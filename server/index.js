/**
 * narrator-team plugin backend entry.
 *
 * Handles the plugin lifecycle handshake (hello → initialize → activate →
 * health) and dispatches contributed tools (`team.dispatch`, `team.status`)
 * and commands (`team.configure`, `team.dispatch`, `team.status`).
 *
 * Business logic lives in `lib/team-core.js` (pure, unit-tested); host
 * interaction goes through `lib/host-api.js` (queries/commands/storage RPC).
 * Team config and the task queue are persisted in the plugin's storage
 * namespace, so nothing is lost when this process is recycled (idle stop or
 * the 60-minute process cap): the plugin is event-driven, not resident.
 */

import { readFileSync } from "node:fs";
import { createHostApi } from "./lib/host-api.js";
import { createRpc } from "./lib/rpc.js";
import * as core from "./lib/team-core.js";
import { teamSopForRole } from "./lib/team-sop.js";

const PLUGIN_ID = "com.whisent.narrator-team";
// 从包内 manifest.json 读取真实版本：hello 握手要求版本与安装版本一致，
// 硬编码会导致升级后 HELLO_VERSION_MISMATCH 而无法激活。
const PLUGIN_VERSION = (() => {
	try {
		const manifestPath = new URL("../manifest.json", import.meta.url);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		return typeof manifest.version === "string" ? manifest.version : "0.1.0";
	} catch {
		return "0.1.0";
	}
})();
const RPC_PROTOCOL = "narrafork.rpc/1";
// Multi-team layout: `team.<teamId>.config` + `team.<teamId>.tasks.index` +
// `team.<teamId>.tasks.<seq>`. The legacy single-team keys below are only read
// once during migration into a `team.default` team.
const TEAM_PREFIX = "team.";
const STORAGE_KEY_CONFIG = "team.config";
const STORAGE_KEY_INDEX = "tasks.index";
const storageKeyTask = (taskId) => `tasks.${taskId}`;
const teamConfigKey = (teamId) => `team.${teamId}.config`;
const teamTasksIndexKey = (teamId) => `team.${teamId}.tasks.index`;
const teamTaskKey = (teamId, seq) => `team.${teamId}.tasks.${seq}`;
const STATUS_QUEUE_WINDOW = 20;

let initialized = false;
let active = false;
let runtimeId;
let generation;
let teamsMigrated = false;

const rpc = createRpc({
	onRequest: handleRequest,
	onNotification: () => undefined,
});
const host = createHostApi(rpc);

// ---------------------------------------------------------------------------
// Persistence helpers (multi-team)
// ---------------------------------------------------------------------------

/** Enumerate team ids from the `team.<id>.config` keys. */
async function listTeamIds() {
	const result = await host.storageList(TEAM_PREFIX);
	const items =
		result && typeof result === "object" && Array.isArray(result.items) ? result.items : [];
	const keys = items.map((entry) => (entry && typeof entry.key === "string" ? entry.key : null));
	return [...new Set(
		keys
			.filter((key) => key && key.startsWith(TEAM_PREFIX) && key.endsWith(".config"))
			.map((key) => key.slice(TEAM_PREFIX.length, -".config".length)),
	)];
}

async function readTeamConfig(teamId) {
	const raw = await host.storageGet(teamConfigKey(teamId));
	return core.parseTeam(raw);
}

async function writeTeamConfig(team) {
	await host.storageSet(teamConfigKey(team.id), team);
}

async function readTeamIndex(teamId) {
	const raw = await host.storageGet(teamTasksIndexKey(teamId));
	return core.parseTaskIndex(raw);
}

async function writeTeamIndex(teamId, index) {
	await host.storageSet(teamTasksIndexKey(teamId), index);
}

async function readTeamTask(teamId, seq) {
	const raw = await host.storageGet(teamTaskKey(teamId, seq));
	return core.parseTask(raw);
}

async function writeTeamTask(teamId, task) {
	await host.storageSet(teamTaskKey(teamId, task.seq), task);
}

/** Load the newest N task records for a team (index is newest-first). */
async function loadRecentTeamTasks(teamId, index, limit) {
	const tasks = [];
	for (const id of index.ids.slice(0, limit)) {
		const seq = Number(id.replace(/^task-/, ""));
		const task = Number.isInteger(seq) ? await readTeamTask(teamId, seq) : null;
		if (task) tasks.push(task);
	}
	return tasks;
}

/** Load ALL persisted task records for a team (index is newest-first). */
async function loadAllTeamTasks(teamId, index) {
	const tasks = [];
	for (const id of index.ids) {
		const seq = Number(id.replace(/^task-/, ""));
		const task = Number.isInteger(seq) ? await readTeamTask(teamId, seq) : null;
		if (task) tasks.push(task);
	}
	return tasks;
}

/**
 * Normalize one host narrator-list result into a reusable existence snapshot.
 * `known: false` means the host query failed and absence cannot be trusted.
 */
function makeNarratorSnapshot(narrators, known = true) {
	const items = Array.isArray(narrators) ? narrators : [];
	return {
		known: known === true,
		narrators: items,
		ids: new Set(items.filter((item) => item && typeof item.id === "string").map((item) => item.id)),
	};
}

async function readNarratorSnapshot() {
	try {
		const snapshot = makeNarratorSnapshot(await host.listNarrators({ limit: 100 }));
		lastKnownNarratorSnapshot = snapshot;
		return snapshot;
	} catch {
		return makeNarratorSnapshot([], false);
	}
}

/**
 * A single host narrator snapshot is enough for the whole dispatch request.
 * Keep it in-flight shared so concurrent maintenance/event work cannot start
 * another list query while dispatch is deciding whether a target was deleted.
 */
let narratorSnapshotPromise = null;
let lastKnownNarratorSnapshot = null;
function readSharedNarratorSnapshot() {
	if (!narratorSnapshotPromise) {
		narratorSnapshotPromise = readNarratorSnapshot().finally(() => {
			narratorSnapshotPromise = null;
		});
	}
	return narratorSnapshotPromise;
}

function snapshotHasNarrator(snapshot, narratorId) {
	return snapshot?.known === true && snapshot.ids instanceof Set && snapshot.ids.has(narratorId);
}

/**
 * Auto-maintenance for one team's queue: retire active tasks whose member is
 * no longer in the team or whose host narrator was deleted, then prune
 * finished tasks beyond the retention window. Best-effort — a failure is
 * swallowed so maintenance never blocks a status view or dispatch.
 * @param {string} teamId
 * @param {{ known: boolean, ids: Set<string> } | undefined} narratorSnapshot
 * @returns {Promise<{ retired: number, removed: number }>}
 */
async function pruneTeamTasks(teamId, narratorSnapshot) {
	try {
		const team = await readTeamConfig(teamId);
		const index = await readTeamIndex(teamId);
		// 1) Retire queued/sent tasks whose member left the team or whose host
		// narrator disappeared. Both states are terminal and can be pruned later.
		let retired = 0;
		let tasks = await loadAllTeamTasks(teamId, index);
		const orphanContext = { memberIds: team.members };
		if (narratorSnapshot?.known === true) {
			orphanContext.narratorIds = [...narratorSnapshot.ids];
		}
		for (const plan of core.retireOrphanTasks(tasks, orphanContext)) {
			const updated = core.updateTaskStatus(plan.task, plan.nextStatus, {
				error: plan.error,
			});
			if (updated.ok) {
				await writeTeamTask(teamId, updated.task);
				retired += 1;
			}
		}
		// 2) Prune finished tasks beyond the retention window, re-reading state
		// so retired tasks count against the retention budget correctly.
		if (retired > 0) tasks = await loadAllTeamTasks(teamId, index);
		const { retainedIndex, removeIds } = core.planTaskRetention(index, tasks);
		for (const id of removeIds) {
			const seq = Number(id.replace(/^task-/, ""));
			if (Number.isInteger(seq)) await host.storageDelete(teamTaskKey(teamId, seq));
		}
		if (removeIds.length > 0) await writeTeamIndex(teamId, retainedIndex);
		return { retired, removed: removeIds.length };
	} catch {
		return { retired: 0, removed: 0 };
	}
}

/**
 * Retire orphan tasks for one already-loaded team without performing a second
 * narrator query. This is the bounded dispatch fast path: it only reads and
 * updates the target team's records and never starts the global maintenance
 * scan or queued-task recovery.
 */
async function pruneTeamTasksForDispatch(team, narratorSnapshot) {
	if (!team || narratorSnapshot?.known !== true) return { retired: 0, removed: 0 };
	try {
		const index = await readTeamIndex(team.id);
		const tasks = await loadAllTeamTasks(team.id, index);
		let retired = 0;
		for (const plan of core.retireOrphanTasks(tasks, {
			memberIds: team.members,
			narratorIds: [...narratorSnapshot.ids],
		})) {
			const updated = core.updateTaskStatus(plan.task, plan.nextStatus, { error: plan.error });
			if (!updated.ok) continue;
			await writeTeamTask(team.id, updated.task);
			retired += 1;
		}
		return { retired, removed: 0 };
	} catch {
		return { retired: 0, removed: 0 };
	}
}

/** Maintain every persisted team's queue using one host existence snapshot. */
async function hasOpenTeamTasks() {
	try {
		for (const teamId of await listTeamIds()) {
			const index = await readTeamIndex(teamId);
			for (const id of index.ids) {
				const seq = Number(id.replace(/^task-/, ""));
				if (!Number.isInteger(seq)) continue;
				const task = await readTeamTask(teamId, seq);
				if (task && (task.status === "queued" || task.status === "sent" || task.pendingFollowUp)) return true;
			}
		}
	} catch {
		// A failed local read should not stop the event poll loop.
	}
	return false;
}

async function maintainAllTeamTasks(narratorSnapshot = undefined) {
	const snapshot = narratorSnapshot ?? (await readNarratorSnapshot());
	let retired = 0;
	let removed = 0;
	try {
		for (const teamId of await listTeamIds()) {
			const result = await pruneTeamTasks(teamId, snapshot);
			retired += result.retired;
			removed += result.removed;
		}
	} catch {
		// Maintenance is best-effort; the next status/event cycle retries it.
	}
	return { retired, removed };
}

/**
 * One-time migration from the legacy single-team layout. Idempotent: only runs
 * when no `team.*` config keys exist yet; the legacy keys are left untouched.
 */
async function ensureTeamsMigrated() {
	if (teamsMigrated) return;
	const teamIds = await listTeamIds();
	if (teamIds.length === 0) {
		const [rawConfig, rawIndex] = await Promise.all([
			host.storageGet(STORAGE_KEY_CONFIG),
			host.storageGet(STORAGE_KEY_INDEX),
		]);
		if (rawConfig !== null && rawConfig !== undefined && rawIndex !== null && rawIndex !== undefined) {
			const migrated = await core.migrateLegacyTeam(
				rawConfig,
				rawIndex,
				(taskId) => host.storageGet(storageKeyTask(taskId)),
			);
			const teamId = migrated.team.id;
			await writeTeamConfig(migrated.team);
			const index = { nextSeq: 1, ids: [] };
			// Legacy index is newest-first; push oldest-first so the team index
			// keeps the same newest-first ordering after re-keying.
			for (const task of [...migrated.tasks].reverse()) {
				await writeTeamTask(teamId, task);
				index.nextSeq = Math.max(index.nextSeq, task.seq + 1);
				const pushed = core.pushTaskIndex(index, task.id);
				index.ids = pushed.index.ids;
			}
			await writeTeamIndex(teamId, index);
		}
	}
	teamsMigrated = true;
}

/**
 * Resolve the team an operation should target.
 * @param {string | undefined} teamId — explicit target
 * @param {string | undefined} callerNarratorId — invoking narrator
 * @returns {Promise<ReturnType<typeof core.parseTeam> | null>}
 */
async function resolveTeamFor(teamId, callerNarratorId) {
	await ensureTeamsMigrated();
	if (typeof teamId === "string" && teamId.length > 0) {
		const team = await readTeamConfig(teamId);
		const exists = (await listTeamIds()).includes(teamId);
		return exists ? team : null;
	}
	if (typeof callerNarratorId === "string" && callerNarratorId.length > 0) {
		for (const id of await listTeamIds()) {
			const team = await readTeamConfig(id);
			if (core.narratorInTeam(team, callerNarratorId)) return team;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Dispatch flow
// ---------------------------------------------------------------------------

/**
 * Dispatch a task to a team member.
 * @returns {Promise<{ ok: true, taskId: string, seq: number, status: string, busy?: boolean, hint?: string }
 *                   | { ok: false, reason: string }>}
 */
async function dispatchTask(input, callerNarratorId, now = new Date().toISOString()) {
	if (typeof input !== "object" || input === null) {
		return { ok: false, reason: "Invalid dispatch input" };
	}
	const { memberId, task, teamId } = input;
	const priority = input.priority === "high" ? "high" : "normal";
	const followUp = input.followUp === true;
	// If the most recent authoritative host snapshot already proves that this
	// target was deleted, fail before resolving team/storage state. On Windows a
	// host request issued immediately before the response can strand the RPC tail
	// frame, so this fast path must not perform another plugin → host call.
	if (
		typeof memberId === "string" &&
		lastKnownNarratorSnapshot?.known === true &&
		!snapshotHasNarrator(lastKnownNarratorSnapshot, memberId)
	) {
		return { ok: false, reason: `Member narrator no longer exists: ${memberId}` };
	}
	// A status/maintenance pass may already have authoritatively observed that
	// this member is gone. Reuse that negative snapshot instead of immediately
	// issuing another host query; this both avoids a redundant RPC round-trip and
	// guarantees a deleted member cannot be re-targeted during the same turn.
	const narratorSnapshot =
		typeof memberId === "string" &&
		lastKnownNarratorSnapshot?.known === true &&
		!snapshotHasNarrator(lastKnownNarratorSnapshot, memberId)
			? lastKnownNarratorSnapshot
			: await readSharedNarratorSnapshot();

	const team = await resolveTeamFor(teamId, callerNarratorId);
	if (!team) {
		return {
			ok: false,
			reason:
				typeof teamId === "string" && teamId.length > 0
					? `Team not found: ${teamId}`
					: "Caller belongs to no team; pass teamId or configure a team first",
		};
	}
	if (!core.narratorInTeam(team, callerNarratorId)) {
		return { ok: false, reason: `Not a member of team: ${team.id}` };
	}
	// A follow-up is an ADDITIONAL instruction to an already-sent task: it must
	// not create a new queue entry or re-mirror the spec queue. Only the leader
	// may add follow-ups (workers report through team.report instead).
	if (followUp) {
		if (team.leaderId !== callerNarratorId) {
			return { ok: false, reason: "Only the team leader can add follow-up instructions" };
		}
		return dispatchFollowUp(team, { memberId, instruction: task, priority, now });
	}

	if (typeof memberId !== "string" || memberId.length === 0) {
		return { ok: false, reason: "memberId is required" };
	}
	if (!team.members.includes(memberId)) {
		return { ok: false, reason: `Not a team member: ${memberId}` };
	}
	if (memberId === team.leaderId) {
		return { ok: false, reason: "Cannot dispatch a task to the team leader" };
	}
	// Do not create queue/spec records or call any member-facing host command
	// when the persisted member was deleted directly by the host.
	if (narratorSnapshot.known && !snapshotHasNarrator(narratorSnapshot, memberId)) {
		// Do not run global maintenance here: it can contend with a concurrent
		// event/status maintenance pass and make an already terminal dispatch
		// wait behind the full plugin RPC deadline. Retire only this team's
		// orphan tasks, then fail before any member-facing operation.
		await pruneTeamTasksForDispatch(team, narratorSnapshot);
		return { ok: false, reason: `Member narrator no longer exists: ${memberId}` };
	}

	const index = await readTeamIndex(team.id);
	const taskId = core.makeTaskId(index.nextSeq);
	const planned = core.planDispatch(team, { memberId, task, priority }, { now, taskId, index });
	if (!planned.ok) return { ok: false, reason: planned.reason };

	const { task: taskRecord, index: nextIndex, trimmed } = planned.plan;
	// Persist the queued task before touching the host, so a crash cannot lose it.
	await writeTeamTask(team.id, taskRecord);
	await writeTeamIndex(team.id, nextIndex);
	for (const trimmedId of trimmed) {
		const seq = Number(trimmedId.replace(/^task-/, ""));
		await host.storageDelete(teamTaskKey(team.id, seq));
	}

	// The prompt tells the member how to close the loop: report back through
	// team.report so the leader learns the outcome (results do not flow back
	// automatically — the host exposes no message-content query). The role SOP
	// tells the member how to behave as a team worker (recruit/fire temp
	// workers, judge effort, report back).
	const outboundPrompt = buildOutboundPrompt(taskRecord, team);

	// Keep the member's role SOP visible for the WHOLE task, not just the
	// dispatch message: the host re-injects spec://behavior_fence at the fence
	// cadence (every N completed tool calls), so a long-running worker that
	// would otherwise bury the trailing SOP under context growth still sees the
	// "report back through team.report" rule. Best-effort — a fence write
	// failure must never block dispatch.
	try {
		const sop = teamSopForRole(core.memberRole(team, taskRecord.memberId));
		await host.specBehaviorFenceUpdate(memberId, sop, "upsert");
	} catch {
		// fence injection is best-effort; the message + spec queue still deliver
	}

	// Mirror the task into the member's own Dynamic Spec queue (spec://tasks.json)
	// so the host's task machinery drives execution: protected tasks keep the
	// member's loop auto-continuing until done, and the team reads that queue to
	// track completion. The spec text is the stable match key — it carries the
	// same "[团队任务 task-N（priority）]" prefix as the message.
	const specTaskText = taskSpecText(taskId, priority, taskRecord.prompt);
	let specAdded = false;
	try {
		const specResult = await host.specTaskAdd(memberId, specTaskText);
		specAdded = specResult && specResult.added === true;
	} catch {
		// spec queue is best-effort; the message channel still delivers the task
	}

	// Subagents have no direct message channel: the host delivers to them via
	// send_subagent_message (running → buffered for the next safe boundary,
	// idle → resumed in-place with a follow-up turn). Delivery can still fail
	// when the subagent has never been started by its parent narrator (no
	// originating Agent tool call exists) — that case is marked failed with a
	// clear reason instead of being queued forever.
	if (await isSubagentNarrator(memberId)) {
		let subagentSent = false;
		try {
			const result = await host.sendSubagentMessage(memberId, outboundPrompt, {
				idempotencyKey: taskId,
			});
			const messageId =
				result && typeof result.messageId === "string" ? result.messageId : null;
			const updated = core.updateTaskStatus(taskRecord, "sent", { messageId, now });
			if (updated.ok) {
				await writeTeamTask(team.id, updated.task);
				subagentSent = true;
			}
		} catch (error) {
			const failed = core.updateTaskStatus(taskRecord, "failed", {
				error: `${error.code ?? "HOST_ERROR"}: ${error.message}`,
				now,
			});
			if (failed.ok) await writeTeamTask(team.id, failed.task);
		}
		return {
			ok: true,
			teamId: team.id,
			taskId,
			seq: taskRecord.seq,
			priority,
			status: subagentSent ? "sent" : "failed",
			...(!subagentSent
				? {
						hint: "subagent 消息投递失败：subagent 需先由其父叙述者通过 Agent 工具启动过一次，才能被恢复执行以接收任务；否则请改派给父叙述者",
					}
				: {}),
		};
	}

	// Fire the message; a busy narrator stays queued and is retryable. A high
	// priority task interrupts the member (after a short grace period) instead
	// of waiting in the queue.
	let sent = false;
	let busy = false;
	let interrupted = false;
	try {
		const result = await host.sendMessage(memberId, outboundPrompt, {
			idempotencyKey: taskId,
		});
		const messageId = result && typeof result.messageId === "string" ? result.messageId : null;
		const updated = core.updateTaskStatus(taskRecord, "sent", {
			messageId,
			now,
		});
		if (updated.ok) {
			await writeTeamTask(team.id, updated.task);
			sent = true;
		}
	} catch (error) {
		if (error.code === "CONFLICT" && priority === "high") {
			// High priority: interrupt the member, then WAIT until it actually
			// settles to idle before delivering the message. Interrupting alone
			// stops the member's current work but does NOT start the new task —
			// if we send while it is still unwinding we hit CONFLICT again, the
			// task drops to the queue, and (if the event subscription is down)
			// the member is left interrupted with nothing to do. Waiting for the
			// idle transition guarantees the high-priority work actually begins.
			interrupted = true;
			try {
				await host.interruptNarrator(memberId);
			} catch {
				// interrupt is best-effort
			}
			const settled = await waitForNarratorIdle(memberId).catch(() => false);
			if (settled) {
				try {
					const result = await host.sendMessage(memberId, outboundPrompt, {
						idempotencyKey: taskId,
					});
					const messageId =
						result && typeof result.messageId === "string" ? result.messageId : null;
					const updated = core.updateTaskStatus(taskRecord, "sent", {
						messageId,
						now,
					});
					if (updated.ok) {
						await writeTeamTask(team.id, updated.task);
						sent = true;
					}
				} catch (retryError) {
					if (retryError.code !== "CONFLICT") {
						const failed = core.updateTaskStatus(taskRecord, "failed", {
							error: `${retryError.code ?? "HOST_ERROR"}: ${retryError.message}`,
							now,
						});
						if (failed.ok) await writeTeamTask(team.id, failed.task);
					} else {
						busy = true; // still busy after settling; keep queued
					}
				}
			} else {
				// Member never reached idle within the window; keep the task
				// queued so the event-driven path retries it on the next idle.
				busy = true;
			}
		} else if (error.code === "CONFLICT") {
			busy = true;
		} else {
			const updated = core.updateTaskStatus(taskRecord, "failed", {
				error: `${error.code ?? "HOST_ERROR"}: ${error.message}`,
				now,
			});
			if (updated.ok) await writeTeamTask(team.id, updated.task);
		}
	}

	return {
		ok: true,
		teamId: team.id,
		taskId,
		seq: taskRecord.seq,
		priority,
		status: sent ? "sent" : busy ? "queued" : "failed",
		...(interrupted ? { interrupted: true } : {}),
		...((busy || !sent) ? { hint: busy ? "Member is busy; task is queued and can be retried" : "Message send failed; task marked failed" } : {}),
	};
}

/**
 * Leader → worker follow-up on an already-sent task. Sends the additional
 * instruction to the member WITHOUT creating a new task record or re-mirroring
 * the spec queue; the instruction is recorded on the task's thread
 * (`task.followUps`) so the leader can review the full exchange later.
 *
 * Busy members: high priority interrupts (same settle-wait as dispatch);
 * normal priority is recorded as a pending follow-up and re-sent by the idle
 * event branch (retryPendingFollowUps).
 *
 * @returns {Promise<{ ok: true, teamId: string, taskId: string, status: string, hint?: string }
 *                   | { ok: false, reason: string }>}
 */
async function dispatchFollowUp(team, { memberId, instruction, priority, now }) {
	if (typeof memberId !== "string" || memberId.length === 0) {
		return { ok: false, reason: "memberId is required" };
	}
	if (typeof instruction !== "string" || instruction.trim().length === 0) {
		return { ok: false, reason: "follow-up instruction is required" };
	}
	if (!core.narratorInTeam(team, memberId)) {
		return { ok: false, reason: `Not a team member: ${memberId}` };
	}
	if (memberId === team.leaderId) {
		return { ok: false, reason: "Cannot send a follow-up to the team leader" };
	}
	const narratorSnapshot = await readNarratorSnapshot();
	if (!narratorSnapshot.known) {
		return { ok: false, reason: "Unable to verify target narrator; try again" };
	}
	if (!snapshotHasNarrator(narratorSnapshot, memberId)) {
		await pruneTeamTasks(team.id, narratorSnapshot);
		return { ok: false, reason: `Member narrator no longer exists: ${memberId}` };
	}

	// The follow-up targets the member's newest SENT task; without one there is
	// nothing to attach to (leader should dispatch a new task instead).
	const index = await readTeamIndex(team.id);
	let targetTask = null;
	for (const taskId of index.ids) {
		const seq = Number(taskId.replace(/^task-/, ""));
		if (!Number.isInteger(seq)) continue;
		const task = await readTeamTask(team.id, seq);
		if (task && task.status === "sent" && task.memberId === memberId) {
			targetTask = task;
			break;
		}
	}
	if (!targetTask) {
		return {
			ok: false,
			reason: `No active (sent) task found for ${memberId}; dispatch a new task instead`,
		};
	}

	const prompt = core.followUpPrompt(targetTask, instruction);
	const withThread = core.appendFollowUp(targetTask, {
		fromId: team.leaderId,
		toId: memberId,
		text: typeof instruction === "string" ? instruction.trim() : "",
		now,
	});

	// Subagents: deliver through the host's subagent channel.
	if (await isSubagentNarrator(memberId)) {
		try {
			const result = await host.sendSubagentMessage(memberId, prompt, {
				idempotencyKey: `team-followup-${targetTask.id}-${Date.now()}`,
			});
			await writeTeamTask(team.id, withThread);
			return {
				ok: true,
				teamId: team.id,
				taskId: targetTask.id,
				status: result.delivered === "started" ? "sent" : "queued",
			};
		} catch (error) {
			return {
				ok: false,
				reason: `Failed to deliver follow-up: ${error.message}`,
			};
		}
	}

	let sent = false;
	let busy = false;
	try {
		const result = await host.sendMessage(memberId, prompt, {
			idempotencyKey: `team-followup-${targetTask.id}-${Date.now()}`,
		});
		const messageId = result && typeof result.messageId === "string" ? result.messageId : null;
		await writeTeamTask(team.id, { ...withThread, messageId });
		sent = true;
	} catch (error) {
		if (error.code === "CONFLICT") {
			busy = true;
			if (priority === "high") {
				try {
					await host.interruptNarrator(memberId);
				} catch {
					// interrupt is best-effort
				}
				const settled = await waitForNarratorIdle(memberId).catch(() => false);
				if (settled) {
					try {
						const result = await host.sendMessage(memberId, prompt, {
							idempotencyKey: `team-followup-${targetTask.id}-${Date.now()}`,
						});
						const messageId =
							result && typeof result.messageId === "string" ? result.messageId : null;
						await writeTeamTask(team.id, { ...withThread, messageId });
						sent = true;
					} catch (retryError) {
						if (retryError.code !== "CONFLICT") {
							await writeTeamTask(team.id, withThread);
						} else {
							busy = true;
						}
					}
				}
			} else {
				// Normal priority: record the follow-up as pending so the idle
				// event branch re-sends it when the member settles.
				await writeTeamTask(team.id, {
					...withThread,
					pendingFollowUp: {
						prompt,
						at: now,
					},
				});
			}
		} else {
			// Persist the thread so the exchange is not lost even if delivery
			// failed; the leader can retry.
			await writeTeamTask(team.id, withThread);
			return { ok: false, reason: `Failed to deliver follow-up: ${error.message}` };
		}
	}

	return {
		ok: true,
		teamId: team.id,
		taskId: targetTask.id,
		status: sent ? "sent" : busy ? "queued" : "queued",
		...((busy || !sent)
			? { hint: busy ? "Member is busy; follow-up will be re-sent when they settle" : "Follow-up queued" }
			: {}),
	};
}

/** Promise-based sleep for the interrupt grace period. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long a high-priority dispatch waits for the interrupted member to reach idle before delivering. */
const HIGH_INTERRUPT_IDLE_WAIT_MS = 20_000;
const HIGH_INTERRUPT_IDLE_POLL_MS = 1_000;

/**
 * Wait until a narrator is no longer actively working (idle, missing, or gone).
 *
 * After `interruptNarrator` the member's agent loop stops, but it needs a
 * moment to settle (its previous turn unwinds, status migrates working → idle)
 * before it can accept a new message. Sending too early hits the same CONFLICT
 * and the high-priority task silently drops to the queue with no one driving
 * it — the "interrupted but never started" bug. Poll the member's status until
 * it leaves working/waiting, then return so the caller can deliver cleanly.
 *
 * @returns {Promise<boolean>} true if the member became idle, false on timeout
 *   (still settling) — caller then keeps the task queued for event-driven retry.
 */
async function waitForNarratorIdle(narratorId, timeoutMs = HIGH_INTERRUPT_IDLE_WAIT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let narrators;
		try {
			narrators = await host.listNarrators({ limit: 100 });
		} catch {
			// A transient status query must not abort dispatch; retry next tick.
		}
		const narrator = (narrators ?? []).find((item) => item.id === narratorId);
		const status = narrator?.status;
		// Gone / missing / idle: safe to deliver. Treat anything not actively
		// working as a deliverable state (the earlier send only CONFLICTs on
		// "already running").
		if (!narrator || (status !== "working" && status !== "waiting")) return true;
		await sleep(HIGH_INTERRUPT_IDLE_POLL_MS);
	}
	return false;
}

/**
 * Build the outbound prompt for a task: task prompt + report closing-the-loop
 * hint + the member's role SOP. The SOP tells the member how to behave as a
 * team worker (e.g. recruit temp workers for large tasks, fire them when done,
 * report back through team.report). Leader 不接收任务（planDispatch 拒绝
 * leader），其行为准则由 manifest 工具描述常驻注入。
 */
function buildOutboundPrompt(task, team) {
	const hint =
		`\n\n[团队任务 ${task.id}（${task.priority ?? "normal"}）] 这是 Leader 指派的任务。完成后请调用 team.report 工具，向 Leader 汇报结果摘要。`;
	const sop = teamSopForRole(core.memberRole(team, task.memberId));
	return `${task.prompt}${hint}\n\n${sop}`;
}

/** Host spec://tasks.json text for a dispatched team task (stable match key). */
function taskSpecText(taskId, priority, prompt) {
	const prefix = `[团队任务 ${taskId}（${priority}）]`;
	const trimmed = typeof prompt === "string" ? prompt.trim() : "";
	// spec task text is capped at 1000 characters by the host.
	const maxPromptChars = 950;
	const body = [...trimmed].length > maxPromptChars ? [...trimmed].slice(0, maxPromptChars).join("") + "…" : trimmed;
	return `${prefix} ${body}`;
}

/**
 * Sync one team task's status from the member's Dynamic Spec queue. The spec
 * entry is matched by its "[团队任务 task-N" prefix; done → done, blocked →
 * failed. Returns true when the team record changed.
 */
async function syncTeamTaskFromSpec(team, task) {
	if (!task || task.status !== "sent") return false;
	let spec;
	try {
		spec = await host.specTasksGet(task.memberId);
	} catch {
		return false; // spec unavailable; keep the current status
	}
	const tasks = spec && Array.isArray(spec.compiled?.tasks) ? spec.compiled.tasks : [];
	const entry = tasks.find(
		(item) => typeof item.text === "string" && item.text.startsWith(`[团队任务 ${task.id}`),
	);
	if (!entry) return false;
	const nextStatus = entry.status === "done" ? "done" : entry.status === "blocked" ? "failed" : null;
	if (!nextStatus) return false;
	const updated = core.updateTaskStatus(task, nextStatus, {});
	if (!updated.ok) return false;
	await writeTeamTask(team.id, updated.task);
	return true;
}

/**
 * Whether a narrator is a subagent. Subagents receive tasks through the host's
 * dedicated subagent message channel (send_subagent_message: running →
 * buffered, idle → resumed in-place) instead of the primary send_message
 * channel, so dispatch routes them differently.
 */
async function isSubagentNarrator(narratorId) {
	try {
		const narrators = await host.listNarrators({ limit: 100 });
		const narrator = (narrators ?? []).find((item) => item.id === narratorId);
		return typeof narrator?.variant === "string" && narrator.variant.startsWith("subagent:");
	} catch {
		return false;
	}
}

async function buildTeamStatus(team, narratorSnapshot = undefined) {
	const index = await readTeamIndex(team.id);
	const snapshot = narratorSnapshot ?? (await readNarratorSnapshot());
	const narrators = snapshot.narrators;
	const tasks = await loadRecentTeamTasks(team.id, index, STATUS_QUEUE_WINDOW);
	// Sync open tasks against each member's Dynamic Spec queue (best-effort):
	// a member marking the task done/blocked in their spec://tasks.json closes
	// the loop even when the event subscription or message events are missed.
	for (const task of tasks) {
		try {
			await syncTeamTaskFromSpec(team, task);
		} catch {
			// spec sync must never block the status view
		}
	}
	// Re-load after sync so the view reflects any status transitions.
	const syncedTasks = await loadRecentTeamTasks(team.id, index, STATUS_QUEUE_WINDOW);
	const view = core.buildStatusView(team, { narrators, tasks: syncedTasks });
	// Attach each member's CURRENT (sent — actively executing) task so the
	// leader can judge how busy they are. Queued tasks stay visible in the
	// queue and must NOT displace the active one.
	const activeByMember = new Map();
	for (const task of tasks) {
		if (task.status === "sent" && !activeByMember.has(task.memberId)) {
			activeByMember.set(
				task.memberId,
				task.prompt.length > 160 ? `${task.prompt.slice(0, 160)}…` : task.prompt,
			);
		}
	}
	// Attach each member's most recent assistant reply (collaboration
	// visibility): the leader sees real progress without opening the chat page.
	const replyByMember = new Map();
	for (const member of view.members) {
		member.activeTask = activeByMember.get(member.id) ?? null;
		try {
			const messages = await host.listMessages(member.id, 10);
			const reply = core.summarizeReplies(messages);
			if (reply) replyByMember.set(member.id, reply);
		} catch {
			// a message read failure must not block the status view
		}
	}
	for (const member of view.members) {
		member.recentReply = replyByMember.get(member.id) ?? null;
	}
	return view;
}

/**
 * Fallback re-dispatch of queued tasks whose member is currently idle.
 * Runs on every team.status invocation so queued tasks recover even when the
 * event subscription is not active (e.g. right after a process recycle).
 */
async function retryQueuedTasksOnStatus(narratorSnapshot = undefined) {
	const snapshot = narratorSnapshot ?? (await readNarratorSnapshot());
	if (!snapshot.known) return;
	const narrators = snapshot.narrators;
	const busy = new Set(
		narrators
			.filter((narrator) => narrator.status === "working" || narrator.status === "waiting")
			.map((narrator) => narrator.id),
	);
	for (const teamId of await listTeamIds()) {
		const team = await readTeamConfig(teamId);
		const index = await readTeamIndex(teamId);
		for (const taskId of index.ids) {
			const seq = Number(taskId.replace(/^task-/, ""));
			if (!Number.isInteger(seq)) continue;
			const task = await readTeamTask(teamId, seq);
			if (!task || task.status !== "queued") continue;
			if (!snapshotHasNarrator(snapshot, task.memberId)) continue;
			if (busy.has(task.memberId)) continue;
			// Subagents: deliver through the host's subagent channel; failures
			// (e.g. never started by the parent) mark the task failed once.
			if (await isSubagentNarrator(task.memberId)) {
				try {
					const result = await host.sendSubagentMessage(
						task.memberId,
						buildOutboundPrompt(task, team),
						{ idempotencyKey: task.id },
					);
					const messageId =
						result && typeof result.messageId === "string" ? result.messageId : null;
					const updated = core.updateTaskStatus(task, "sent", { messageId });
					if (updated.ok) await writeTeamTask(teamId, updated.task);
				} catch (error) {
					const failed = core.updateTaskStatus(task, "failed", {
						error: `${error.code ?? "HOST_ERROR"}: ${error.message}`,
					});
					if (failed.ok) await writeTeamTask(teamId, failed.task);
				}
				continue;
			}
			try {
				const result = await host.sendMessage(task.memberId, buildOutboundPrompt(task, team), {
					idempotencyKey: task.id,
				});
				const messageId = result && typeof result.messageId === "string" ? result.messageId : null;
				const updated = core.updateTaskStatus(task, "sent", { messageId });
				if (updated.ok) await writeTeamTask(teamId, updated.task);
			} catch (error) {
				if (error.code !== "CONFLICT") {
					const updated = core.updateTaskStatus(task, "failed", {
						error: `${error.code ?? "HOST_ERROR"}: ${error.message}`,
					});
					if (updated.ok) await writeTeamTask(teamId, updated.task);
				}
			}
		}
	}
}

/**
 * Status view for the calling narrator.
 * @param {{ teamId?: string } | undefined} input
 * @param {string | undefined} callerNarratorId
 * @returns {Promise<object>} `{ teams: [...], availableNarrators: [...] }`
 */
async function buildStatus(input, callerNarratorId) {
	await ensureTeamsMigrated();
	const narratorSnapshot = await readNarratorSnapshot();
	// Retire orphaned tasks BEFORE any queued-task recovery so a deleted member
	// can never be resurrected by this status call.
	try {
		await maintainAllTeamTasks(narratorSnapshot);
	} catch {
		// maintenance must never block the status view
	}
	// Best-effort recovery of tasks stuck in `queued` while their member is idle.
	try {
		await retryQueuedTasksOnStatus(narratorSnapshot);
	} catch {
		// recovery must never block the status view
	}
	const teamId = typeof input === "object" && input !== null && typeof input.teamId === "string"
		? input.teamId
		: undefined;
	const narrators = narratorSnapshot.narrators;
	const availableNarrators = narrators.map((narrator) => ({
		id: narrator.id,
		title: narrator.title ?? null,
		handle: narrator.handle ?? null,
		status: narrator.status ?? "idle",
		model: narrator.model ?? null,
	}));

	const teamIds = await listTeamIds();
	const teams = [];
	if (teamId !== undefined) {
		if (!teamIds.includes(teamId)) {
			return { ok: false, reason: `Team not found: ${teamId}` };
		}
		const team = await readTeamConfig(teamId);
		// Non-members may only peek at teams they belong to; admins are not
		// distinguished here, so gate strictly on membership.
		if (!core.narratorInTeam(team, callerNarratorId)) {
			return { ok: false, reason: `Not a member of team: ${teamId}` };
		}
		teams.push(await buildTeamStatus(team, narratorSnapshot));
	} else {
		for (const id of teamIds) {
			const team = await readTeamConfig(id);
			if (core.narratorInTeam(team, callerNarratorId)) {
				teams.push(await buildTeamStatus(team, narratorSnapshot));
			}
		}
	}
	return { ok: true, teams, availableNarrators };
}

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

/** tools.invoke + commands.invoke share the same contribution surface. */
async function invokeContribution(contributionId, input, callerNarratorId) {
	switch (contributionId) {
		case "team.dispatch": {
			const result = await dispatchTask(input, callerNarratorId);
			if (!result.ok) {
				throw new ContributionError("INVALID_PARAMS", result.reason);
			}
			// Auto-maintain the queue after a dispatch so finished tasks do not
			// accumulate indefinitely (best-effort).
			if (result.teamId) await pruneTeamTasks(result.teamId, await readSharedNarratorSnapshot());
			return {
				output: JSON.stringify({
					teamId: result.teamId,
					taskId: result.taskId,
					seq: result.seq,
					status: result.status,
					...(result.hint ? { hint: result.hint } : {}),
				}),
				title: result.status === "sent" ? "Task dispatched" : "Task queued",
				metadata: { teamId: result.teamId, taskId: result.taskId, seq: result.seq, status: result.status },
			};
		}
		case "team.status": {
			const status = await buildStatus(input, callerNarratorId);
			if (!status.ok) {
				throw new ContributionError("INVALID_PARAMS", status.reason);
			}
			const first = status.teams[0];
			return {
				output: JSON.stringify(status),
				title: first
					? `Team: ${first.name || "(unnamed)"}${status.teams.length > 1 ? ` (+${status.teams.length - 1} more)` : ""}`
					: "Team: none",
				metadata: {
					teamCount: status.teams.length,
					memberCount: first ? first.members.length : 0,
					queueCount: first ? first.queue.length : 0,
				},
			};
		}
		case "team.configure":
		case "team.setup": {
			const result = await configureTeam(input, callerNarratorId);
			if (!result.ok) {
				throw new ContributionError("INVALID_PARAMS", result.errors.join("; "));
			}
			return {
				output: JSON.stringify({
					ok: true,
					teamId: result.config.id,
					leaderId: result.config.leaderId,
					members: result.config.members,
				}),
				title: "Team configured",
				metadata: {
					teamId: result.config.id,
					leaderId: result.config.leaderId,
					memberCount: result.config.members.length,
				},
			};
		}
		case "team.recruit": {
			const result = await recruitWorker(input, callerNarratorId);
			if (!result.ok) {
				throw new ContributionError("INVALID_PARAMS", result.reason);
			}
			return {
				output: JSON.stringify({
					ok: true,
					teamId: result.teamId,
					memberId: result.memberId,
					role: result.role,
					title: result.title,
					variant: result.variant,
				}),
				title: result.role === "temp" ? "Temp worker recruited" : "Member recruited",
				metadata: {
					teamId: result.teamId,
					memberId: result.memberId,
					role: result.role,
				},
			};
		}
		case "team.fire": {
			const result = await fireWorker(input, callerNarratorId);
			if (!result.ok) {
				throw new ContributionError("INVALID_PARAMS", result.reason);
			}
			return {
				output: JSON.stringify({
					ok: true,
					teamId: result.teamId,
					memberId: result.memberId,
					role: result.role,
					deleted: result.deleted,
				}),
				title: "Worker fired",
				metadata: {
					teamId: result.teamId,
					memberId: result.memberId,
					role: result.role,
				},
			};
		}
		case "team.report": {
			const result = await reportTaskResult(input, callerNarratorId);
			if (!result.ok) {
				throw new ContributionError("INVALID_PARAMS", result.reason);
			}
			return {
				output: JSON.stringify({
					ok: true,
					teamId: result.teamId,
					taskCount: result.taskCount,
					status: "reported",
				}),
				title: "Task result reported",
				metadata: { teamId: result.teamId, taskCount: result.taskCount },
			};
		}
		case "team.update_member": {
			const result = await updateMemberProfile(input, callerNarratorId);
			if (!result.ok) {
				throw new ContributionError("INVALID_PARAMS", result.reason);
			}
			return {
				output: JSON.stringify({
					ok: true,
					teamId: result.teamId,
					memberId: result.memberId,
					updated: result.updated,
					...(result.spec ? { spec: result.spec } : {}),
				}),
				title: "Member profile updated",
				metadata: { teamId: result.teamId, memberId: result.memberId, updated: result.updated },
			};
		}
		default:
			throw new ContributionError("METHOD_NOT_FOUND", `Unknown contribution: ${contributionId}`);
	}
}

class ContributionError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "ContributionError";
		this.code = code;
	}
}

async function configureTeam(input, callerNarratorId) {
	if (typeof input !== "object" || input === null) {
		return { ok: false, errors: ["Invalid configure input"] };
	}
	await ensureTeamsMigrated();
	const { teamId: requestedTeamId, ...patch } = input;
	const now = new Date().toISOString();

	let team;
	if (typeof requestedTeamId === "string" && requestedTeamId.length > 0) {
		team = await readTeamConfig(requestedTeamId);
		const exists = (await listTeamIds()).includes(requestedTeamId);
		if (!exists) return { ok: false, errors: [`Team not found: ${requestedTeamId}`] };
	} else if (typeof callerNarratorId === "string" && callerNarratorId.length > 0) {
		team = await resolveTeamFor(undefined, callerNarratorId);
		if (!team) {
			// Create a fresh team owned by the caller.
			const teamId = core.makeTeamId(makeShortSuffix());
			team = core.defaultTeam(teamId, now);
			team.leaderId = callerNarratorId;
			team.members = [callerNarratorId];
		}
	} else {
		// No caller identity (e.g. a UI command): update the first team, creating
		// one if none exists yet.
		const teamIds = await listTeamIds();
		if (teamIds.length === 0) {
			const teamId = core.makeTeamId(makeShortSuffix());
			team = core.defaultTeam(teamId, now);
		} else {
			team = await readTeamConfig(teamIds[0]);
		}
	}

	const config = core.applyTeamPatch(team, patch, now);
	// The leader is always a member: keep the invariant that leader ∈ members.
	if (config.leaderId !== null && !config.members.includes(config.leaderId)) {
		config.members = [config.leaderId, ...config.members];
	}
	const narrators = await host.listNarrators({ limit: 100 });
	const validation = core.validateTeamConfig(config, { narrators });
	if (!validation.ok) return { ok: false, errors: validation.errors };
	await writeTeamConfig(config);
	return { ok: true, config };
}

/** Short random-ish suffix for auto-generated team ids (no crypto dependency). */
function makeShortSuffix() {
	return Date.now().toString(36) + Math.floor(Math.random() * 0xffff).toString(36).padStart(3, "0");
}

// ---------------------------------------------------------------------------
// Recruit & fire (three-tier team: leader / members / temp workers)
// ---------------------------------------------------------------------------

/**
 * Recruit a new worker into the team.
 * - role "member" (primary narrator): only the team leader may recruit.
 * - role "temp" (subagent temp worker): any team member may recruit; the
 *   temp worker is owned by the recruiting narrator.
 * @returns {Promise<{ ok: true, teamId: string, memberId: string, role: string, title: string | null, variant: string }
 *                   | { ok: false, reason: string }>}
 */
async function recruitWorker(input, callerNarratorId) {
	if (typeof input !== "object" || input === null) {
		return { ok: false, reason: "Invalid recruit input" };
	}
	const role = input.role === "temp" ? "temp" : "member";
	if (typeof callerNarratorId !== "string" || callerNarratorId.length === 0) {
		return { ok: false, reason: "Recruit requires a team member context" };
	}
	const team = await resolveTeamFor(input.teamId, callerNarratorId);
	if (!team) {
		return { ok: false, reason: "Caller belongs to no team; pass teamId or configure a team first" };
	}
	if (!core.narratorInTeam(team, callerNarratorId)) {
		return { ok: false, reason: `Not a member of team: ${team.id}` };
	}
	// Only the leader may recruit regular members; anyone may recruit temp workers.
	if (role === "member" && team.leaderId !== callerNarratorId) {
		return { ok: false, reason: "Only the team leader can recruit regular members" };
	}
	if (team.members.length >= core.QUEUE_LIMITS.maxMembers) {
		return { ok: false, reason: `Team member limit reached (${core.QUEUE_LIMITS.maxMembers})` };
	}

	let created;
	try {
		created = await host.createNarrator({
			type: role === "temp" ? "subagent" : "primary",
			title: typeof input.title === "string" && input.title.length > 0 ? input.title : undefined,
			model: typeof input.model === "string" && input.model.length > 0 ? input.model : undefined,
			// Temp workers inherit the recruiter's workspace so they can explore the same codebase.
			cwd: typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : undefined,
			subagentType:
				role === "temp" && typeof input.subagentType === "string" && input.subagentType.length > 0
					? input.subagentType
					: undefined,
			parentNarratorId: role === "temp" ? callerNarratorId : undefined,
			idempotencyKey: `team-recruit-${team.id}-${callerNarratorId}-${Date.now()}`,
		});
	} catch (error) {
		return { ok: false, reason: `Failed to create narrator: ${error.message}` };
	}
	const memberId = created && typeof created.narratorId === "string" ? created.narratorId : null;
	if (!memberId) {
		return { ok: false, reason: "Host returned no narrator id" };
	}
	// A successful host-side create invalidates the cached existence snapshot;
	// the next dispatch/status request must refresh it before deciding whether
	// the new member can receive work.
	lastKnownNarratorSnapshot = null;
	const now = new Date().toISOString();

	const next = core.addTeamMember(team, {
		id: memberId,
		role,
		recruitedBy: role === "temp" ? callerNarratorId : null,
		now,
	});
	await writeTeamConfig(next);
	return {
		ok: true,
		teamId: team.id,
		memberId,
		role,
		title: created.title ?? null,
		variant: created.variant ?? null,
	};
}

/**
 * Fire (dismiss) a worker from the team.
 * The leader may fire anyone; a member may only fire temp workers they
 * recruited themselves. The narrator record is deleted as best-effort — the
 * team membership is always removed even if deletion fails.
 * @returns {Promise<{ ok: true, teamId: string, memberId: string, role: string, deleted: boolean }
 *                   | { ok: false, reason: string }>}
 */
async function fireWorker(input, callerNarratorId) {
	if (typeof input !== "object" || input === null) {
		return { ok: false, reason: "Invalid fire input" };
	}
	const memberId = typeof input.memberId === "string" ? input.memberId : "";
	if (!memberId) return { ok: false, reason: "memberId is required" };
	if (typeof callerNarratorId !== "string" || callerNarratorId.length === 0) {
		return { ok: false, reason: "Fire requires a team member context" };
	}
	const team = await resolveTeamFor(input.teamId, callerNarratorId);
	if (!team) {
		return { ok: false, reason: "Caller belongs to no team; pass teamId or configure a team first" };
	}
	if (!core.narratorInTeam(team, callerNarratorId)) {
		return { ok: false, reason: `Not a member of team: ${team.id}` };
	}
	if (!team.members.includes(memberId)) {
		return { ok: false, reason: `Not a member of team: ${memberId}` };
	}
	const role = core.memberRole(team, memberId);
	const isLeader = team.leaderId === callerNarratorId;
	if (!isLeader) {
		const recruiter = team.recruitedBy?.[memberId];
		if (role !== "temp" || recruiter !== callerNarratorId) {
			return {
				ok: false,
				reason:
					"Only the team leader can fire regular members; members can only fire temp workers they recruited",
			};
		}
	}

	const next = core.removeTeamMember(team, memberId);
	await writeTeamConfig(next);

	// Remove the team SOP from the fired member's behavior fence (best-effort)
	// so a dismissed worker no longer carries team collaboration rules.
	await host.specBehaviorFenceUpdate(memberId, "", "clear").catch(() => undefined);

	// Auto-maintain: retire this member's queued/sent tasks (they can never be
	// delivered) and prune finished tasks beyond the retention window.
	await pruneTeamTasks(next.id, await readNarratorSnapshot());

	let deleted = false;
	try {
		await host.deleteNarrator(memberId);
		deleted = true;
	} catch {
		// narrator deletion is best-effort; the team membership is already gone
	}
	lastKnownNarratorSnapshot = null;
	return { ok: true, teamId: team.id, memberId, role, deleted };
}

/**
 * Update a team member's narrator profile (title / model / reasoning effort)
 * and optionally write a Dynamic Spec file. Authorization mirrors team.fire:
 * only the leader may update members; a member may only update temp workers
 * they recruited.
 * @returns {Promise<{ ok: true, teamId: string, memberId: string,
 *                     updated: string[], spec?: { uri: string, revisionId: string | null } }
 *                   | { ok: false, reason: string }>}
 */
async function updateMemberProfile(input, callerNarratorId) {
	if (typeof input !== "object" || input === null) {
		return { ok: false, reason: "Invalid update input" };
	}
	if (typeof callerNarratorId !== "string" || callerNarratorId.length === 0) {
		return { ok: false, reason: "Update requires a team member context" };
	}
	const team = await resolveTeamFor(input.teamId, callerNarratorId);
	if (!team) {
		return {
			ok: false,
			reason:
				typeof input.teamId === "string" && input.teamId.length > 0
					? `Team not found: ${input.teamId}`
					: "Caller belongs to no team; pass teamId or configure a team first",
		};
	}
	if (!core.narratorInTeam(team, callerNarratorId)) {
		return { ok: false, reason: `Not a member of team: ${team.id}` };
	}
	const planned = core.planMemberProfilePatch(team, callerNarratorId, input);
	if (!planned.ok) return { ok: false, reason: planned.reason };

	const { plan } = planned;
	const updated = [];
	// Spec write goes first so a partially-applied update (e.g. title fails
	// afterwards) still leaves the spec change visible; each step is
	// individually best-effort and the overall result reports what happened.
	let specResult = null;
	if (plan.spec) {
		try {
			const written = await host.specFileWrite(plan.memberId, plan.spec.uri, plan.spec.content);
			specResult = {
				uri: plan.spec.uri,
				revisionId: written && typeof written.revisionId === "string" ? written.revisionId : null,
			};
		} catch (error) {
			return { ok: false, reason: `Failed to write spec: ${error.message}` };
		}
	}
	if (plan.title !== undefined || plan.model !== undefined || plan.reasoningEffort !== undefined) {
		try {
			const result = await host.updateNarratorProfile(plan.memberId, {
				...(plan.title !== undefined ? { title: plan.title } : {}),
				...(plan.model !== undefined ? { model: plan.model } : {}),
				...(plan.reasoningEffort !== undefined
					? { reasoningEffort: plan.reasoningEffort }
					: {}),
			});
			updated.push(...(result && Array.isArray(result.updated) ? result.updated : []));
		} catch (error) {
			return { ok: false, reason: `Failed to update profile: ${error.message}` };
		}
	}
	return {
		ok: true,
		teamId: team.id,
		memberId: plan.memberId,
		updated,
		...(specResult ? { spec: specResult } : {}),
	};
}

// ---------------------------------------------------------------------------
// Event-driven task retry & completion signalling
// ---------------------------------------------------------------------------
//
// The plugin is event-driven, not resident, but it stays alive until the host
// recycles it (60-minute cap / idle). While alive it subscribes to narrator
// lifecycle + message events so that:
//   - a member going idle re-dispatches any queued task targeted at them
//     (a busy member used to leave tasks stuck in `queued` forever);
//   - a member sending a message after a task was dispatched marks the task
//     done and notifies the leader that progress came back.

let eventSubscription = null;
let eventPollTimer = null;
let eventPollInFlight = false;

const EVENT_POLL_INTERVAL_MS = 30_000;
const EVENT_TOPICS = [
	"narrafork.narrator.lifecycle",
	"narrafork.narrator.message.changed",
	"narrafork.narrator.spec.changed",
];

/** Subscribe to team-relevant events and start polling (best-effort). */
async function setupEventSubscription() {
	if (!active || eventSubscription) return;
	try {
		const memberIds = new Set();
		for (const teamId of await listTeamIds()) {
			const team = await readTeamConfig(teamId);
			if (team.leaderId) memberIds.add(team.leaderId);
			for (const member of team.members) memberIds.add(member);
		}
		const result = await host.subscribeEvents({
			topics: EVENT_TOPICS,
			filter: { narratorIds: [...memberIds] },
			mode: "live",
			delivery: { transport: "poll", maxRatePerSecond: 10, queueEvents: 100, queueBytes: 256 * 1024 },
		});
		eventSubscription =
			result && typeof result === "object" && typeof result.subscriptionId === "string" ? result : null;
		if (eventSubscription) {
			clearInterval(eventPollTimer);
			eventPollTimer = setInterval(() => {
				pollAndHandleEvents().catch(() => undefined);
			}, EVENT_POLL_INTERVAL_MS);
		}
	} catch {
		// Subscription is best-effort; tasks still retry on the next invocation.
	}
}

async function teardownEventSubscription() {
	clearInterval(eventPollTimer);
	eventPollTimer = null;
	if (eventSubscription) {
		const subscriptionId = eventSubscription.subscriptionId;
		eventSubscription = null;
		try {
			await host.unsubscribeEvents({ subscriptionId });
		} catch {
			// ignore
		}
	}
}

async function pollAndHandleEvents() {
	if (!eventSubscription || eventPollInFlight) return;
	eventPollInFlight = true;
	try {
		// Avoid an extra host narrator query once all persisted tasks are terminal.
		// This keeps an idle event poll from racing a foreground dispatch while
		// still maintaining queues whenever there is work that could be orphaned.
		if (await hasOpenTeamTasks()) await maintainAllTeamTasks();
		const result = await host.pollEvents({ subscriptionId: eventSubscription.subscriptionId });
		const events = result && Array.isArray(result.events) ? result.events : [];
		for (const event of events) {
			try {
				await handleTeamEvent(event);
			} catch {
				// one bad event must not stall the poll loop
			}
		}
	} catch {
		// transient poll failure: try again next interval
	} finally {
		eventPollInFlight = false;
	}
}

function eventNarratorId(event) {
	if (!event || typeof event !== "object") return undefined;
	const fromData = event.data && typeof event.data === "object" ? event.data.narratorId : undefined;
	const fromResource =
		event.resource && typeof event.resource === "object" ? event.resource.narratorId : undefined;
	return typeof fromData === "string" ? fromData : typeof fromResource === "string" ? fromResource : undefined;
}

async function handleTeamEvent(event) {
	// Host narrator deletion has no lifecycle event; refresh the existence
	// snapshot on every delivered event so active plugin runtimes discover and
	// retire orphaned tasks without waiting for a status invocation.
	try {
		await maintainAllTeamTasks();
	} catch {
		// event maintenance is best-effort
	}
	const narratorId = eventNarratorId(event);
	if (!narratorId) return;
	if (event.topic === "narrafork.narrator.lifecycle") {
		const status = event.data && typeof event.data === "object" ? event.data.status : undefined;
		if (status === "idle") await retryQueuedTasks(narratorId);
	} else if (event.topic === "narrafork.narrator.message.changed") {
		await markMemberResponded(narratorId);
	} else if (event.topic === "narrafork.narrator.spec.changed") {
		// A member's spec://tasks.json changed (e.g. the team task was marked
		// done/blocked): sync that member's open team tasks.
		await syncMemberTasksFromSpec(narratorId);
	}
}

/** Sync every open task of a member from their Dynamic Spec queue. */
async function syncMemberTasksFromSpec(memberId) {
	for (const teamId of await listTeamIds()) {
		const team = await readTeamConfig(teamId);
		const index = await readTeamIndex(teamId);
		for (const taskId of index.ids) {
			const seq = Number(taskId.replace(/^task-/, ""));
			if (!Number.isInteger(seq)) continue;
			const task = await readTeamTask(teamId, seq);
			if (!task || task.memberId !== memberId) continue;
			try {
				await syncTeamTaskFromSpec(team, task);
			} catch {
				// one bad sync must not stall the loop
			}
		}
	}
}

/** Re-dispatch queued tasks for a member who just became idle. */
async function retryQueuedTasks(memberId) {
	const snapshot = await readNarratorSnapshot();
	if (!snapshot.known || !snapshotHasNarrator(snapshot, memberId)) {
		if (snapshot.known) await maintainAllTeamTasks(snapshot);
		return;
	}
	for (const teamId of await listTeamIds()) {
		const team = await readTeamConfig(teamId);
		const index = await readTeamIndex(teamId);
		for (const taskId of index.ids) {
			const seq = Number(taskId.replace(/^task-/, ""));
			if (!Number.isInteger(seq)) continue;
		const task = await readTeamTask(teamId, seq);
		// Pending follow-up: a leader's normal-priority follow-up that could not
		// be delivered while the member was busy. Re-send now that they settled.
		if (task && task.memberId === memberId && task.pendingFollowUp) {
			try {
				const prompt = task.pendingFollowUp.prompt;
				const updated = await deliverFollowUpPrompt(teamId, task, prompt, memberId);
				if (updated) await writeTeamTask(teamId, updated);
			} catch {
				// keep the pending follow-up; retry on the next idle event
			}
		}
		if (!task || task.status !== "queued" || task.memberId !== memberId) continue;
		// Subagents: deliver through the host's subagent channel (see dispatch).
		if (await isSubagentNarrator(memberId)) {
			try {
				const result = await host.sendSubagentMessage(memberId, buildOutboundPrompt(task, team), {
					idempotencyKey: task.id,
				});
				const messageId =
					result && typeof result.messageId === "string" ? result.messageId : null;
				const updated = core.updateTaskStatus(task, "sent", { messageId });
				if (updated.ok) await writeTeamTask(teamId, updated.task);
			} catch (error) {
				const updated = core.updateTaskStatus(task, "failed", {
					error: `${error.code ?? "HOST_ERROR"}: ${error.message}`,
				});
				if (updated.ok) await writeTeamTask(teamId, updated.task);
			}
			continue;
		}
		try {
				const result = await host.sendMessage(memberId, buildOutboundPrompt(task, team), {
					idempotencyKey: task.id,
				});
				const messageId = result && typeof result.messageId === "string" ? result.messageId : null;
				const updated = core.updateTaskStatus(task, "sent", { messageId });
				if (updated.ok) await writeTeamTask(teamId, updated.task);
			} catch (error) {
				if (error.code === "CONFLICT") {
					// still busy; stays queued and will retry on the next idle event
				} else {
					const updated = core.updateTaskStatus(task, "failed", {
						error: `${error.code ?? "HOST_ERROR"}: ${error.message}`,
					});
					if (updated.ok) await writeTeamTask(teamId, updated.task);
				}
			}
		}
	}
}

/**
 * Deliver a previously-pending follow-up to a member who has now settled, and
 * clear the pending marker on the task. Returns the updated task (with the
 * pending marker removed and the sent messageId set), or null when delivery
 * must be retried later (still busy) / the task record changed shape.
 */
async function deliverFollowUpPrompt(teamId, task, prompt, memberId) {
	if (await isSubagentNarrator(memberId)) {
		const result = await host.sendSubagentMessage(memberId, prompt, {
			idempotencyKey: `team-followup-${task.id}-${Date.now()}`,
		});
		const messageId = result && typeof result.messageId === "string" ? result.messageId : null;
		return { ...task, pendingFollowUp: null, messageId };
	}
	try {
		const result = await host.sendMessage(memberId, prompt, {
			idempotencyKey: `team-followup-${task.id}-${Date.now()}`,
		});
		const messageId = result && typeof result.messageId === "string" ? result.messageId : null;
		return { ...task, pendingFollowUp: null, messageId };
	} catch (error) {
		if (error.code === "CONFLICT") return null; // still busy; retry next idle
		throw error;
	}
}

/** A member sent a message: complete their open sent tasks and tell the leader. */
async function markMemberResponded(memberId) {
	for (const teamId of await listTeamIds()) {
		const team = await readTeamConfig(teamId);
		const index = await readTeamIndex(teamId);
		let completed = false;
		let completedTasks = [];
		for (const taskId of index.ids) {
			const seq = Number(taskId.replace(/^task-/, ""));
			if (!Number.isInteger(seq)) continue;
			const task = await readTeamTask(teamId, seq);
			if (!task || task.status !== "sent" || task.memberId !== memberId) continue;
			const updated = core.updateTaskStatus(task, "done", {});
			if (updated.ok) {
				await writeTeamTask(teamId, updated.task);
				completed = true;
				completedTasks.push(task);
			}
		}
		if (completed && team.leaderId && team.leaderId !== memberId) {
			// Collaboration visibility: include the member's actual latest reply
			// (truncated) so the leader sees real progress without opening the
			// chat page. Fall back to a task list when the message read fails.
			let summary = null;
			try {
				const messages = await host.listMessages(memberId, 10);
				summary = core.summarizeReplies(messages);
			} catch {
				// message read is best-effort; fall back below
			}
			const taskLabels = completedTasks
				.map((task) => task.id)
				.slice(0, 5)
				.join(", ");
			const body = summary
				? `团队成员 ${memberId} 已就任务做出回复：${summary}`
				: `团队成员 ${memberId} 已就任务做出回复（${taskLabels || "无"}），请查看最新进展。`;
			try {
				await host.sendMessage(team.leaderId, body, {
					idempotencyKey: `team-notify-${memberId}-${Date.now()}`,
				});
			} catch {
				// leader notification is best-effort
			}
		}
	}
}

/**
 * Member → leader task feedback. Marks the caller's sent tasks as done and
 * sends the summary to the leader (or to the team channel if the caller IS the
 * leader).
 * @returns {Promise<{ ok: true, teamId: string, taskCount: number }
 *                  | { ok: false, reason: string }>}
 */
async function reportTaskResult(input, callerNarratorId) {
	if (typeof input !== "object" || input === null) {
		return { ok: false, reason: "Invalid report input" };
	}
	const summary = typeof input.summary === "string" ? input.summary.trim() : "";
	if (!summary) return { ok: false, reason: "summary is required" };
	if (typeof callerNarratorId !== "string" || callerNarratorId.length === 0) {
		return { ok: false, reason: "Report requires a team member context" };
	}
	const team = await resolveTeamFor(input.teamId, callerNarratorId);
	if (!team) return { ok: false, reason: "Caller belongs to no team; pass teamId" };
	if (!core.narratorInTeam(team, callerNarratorId)) {
		return { ok: false, reason: `Not a member of team: ${team.id}` };
	}

	// Mark the caller's open sent tasks as done.
	let taskCount = 0;
	const index = await readTeamIndex(team.id);
	for (const taskId of index.ids) {
		const seq = Number(taskId.replace(/^task-/, ""));
		if (!Number.isInteger(seq)) continue;
		const task = await readTeamTask(team.id, seq);
		if (!task || task.status !== "sent" || task.memberId !== callerNarratorId) continue;
		const updated = core.updateTaskStatus(task, "done", {});
		if (updated.ok) {
			await writeTeamTask(team.id, updated.task);
			taskCount += 1;
		}
	}

	// Deliver the report to the leader (or echo to self when the caller leads).
	const recipient = team.leaderId && team.leaderId !== callerNarratorId ? team.leaderId : callerNarratorId;
	const report =
		`[团队任务汇报] 来自 ${callerNarratorId}：${summary}${taskCount > 0 ? `（已完成 ${taskCount} 项指派任务）` : ""}`;
	try {
		await host.sendMessage(recipient, report, {
			idempotencyKey: `team-report-${callerNarratorId}-${Date.now()}`,
		});
	} catch (error) {
		if (error.code !== "CONFLICT") {
			return { ok: false, reason: `Failed to deliver report: ${error.message}` };
		}
	}
	return { ok: true, teamId: team.id, taskCount };
}

// ---------------------------------------------------------------------------
// RPC lifecycle
// ---------------------------------------------------------------------------

function handleRequest(message) {
	const params = message.params;
	switch (message.method) {
		case "initialize": {
			if (params?.protocol !== RPC_PROTOCOL || params.pluginId !== PLUGIN_ID) {
				return { error: { code: -32602, message: "initialize identity or protocol mismatch" } };
			}
			runtimeId = typeof params.runtimeId === "string" ? params.runtimeId : undefined;
			generation = typeof params.generation === "number" ? params.generation : undefined;
			initialized = true;
			return { result: { initialized: true, protocol: RPC_PROTOCOL } };
		}
		case "activate":
			if (!initialized) {
				return { error: { code: -32603, message: "Plugin must be initialized before activation" } };
			}
			active = true;
			// Kick off the event subscription (non-blocking; polls while alive).
			setupEventSubscription().catch(() => undefined);
			return { result: { activated: true } };
		case "health":
			return {
				result: {
					healthy: initialized && active,
					status: active ? "ready" : "inactive",
					runtimeId,
					generation,
				},
			};
			case "tools.invoke":
		case "commands.invoke": {
			// The host injects the invoking narrator into the RPC context scope;
			// it identifies which narrator is acting so team operations can
			// target/derive the right team.
			const scope = params?.context?.scope;
			const callerNarratorId =
				scope && typeof scope === "object" && typeof scope.narratorId === "string"
					? scope.narratorId
					: undefined;
			return invokeContribution(params?.contributionId, params?.input, callerNarratorId).then(
				(result) => ({ result }),
				(error) => ({
					error: {
						code: error instanceof ContributionError ? -32602 : -32603,
						message: error instanceof Error ? error.message : String(error),
						data: { code: error instanceof ContributionError ? error.code : "INTERNAL_ERROR" },
					},
				}),
			);
		}
		case "deactivate":
			active = false;
			teardownEventSubscription().catch(() => undefined);
			return { result: { deactivated: true } };
		case "shutdown":
			active = false;
			initialized = false;
			process.exit(0);
			return { result: { shutdown: true } };
		default:
			return { error: { code: -32601, message: `Unknown method: ${message.method}` } };
	}
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function readRpcStdin() {
	process.stdin.on("data", (chunk) => {
		try {
			rpc.onData(chunk);
		} catch {
			process.exit(2);
		}
	});
	process.stdin.on("end", () => {
		rpc.onEnd();
		process.exit(0);
	});
}

void readRpcStdin();

rpc.sendNotification("hello", {
	pluginId: PLUGIN_ID,
	version: PLUGIN_VERSION,
	packageDigest: typeof process.env.NF_PLUGIN_PACKAGE_DIGEST === "string" ? process.env.NF_PLUGIN_PACKAGE_DIGEST : undefined,
	rpcProtocol: RPC_PROTOCOL,
	features: ["host_api.requests"],
});
