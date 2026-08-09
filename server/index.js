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
	// automatically — the host exposes no message-content query).
	const reportHint =
		`\n\n[团队任务 ${taskId}（${priority}）] 这是 Leader 指派的任务。完成后请调用 team.report 工具，向 Leader 汇报结果摘要。`;
	const outboundPrompt = `${taskRecord.prompt}${reportHint}`;

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
			// High priority: interrupt the member, then retry delivery a few times.
			interrupted = true;
			try {
				await host.interruptNarrator(memberId);
			} catch {
				// interrupt is best-effort
			}
			for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
				await sleep(2000);
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
				} catch (retryError) {
					if (retryError.code !== "CONFLICT") {
						const failed = core.updateTaskStatus(taskRecord, "failed", {
							error: `${retryError.code ?? "HOST_ERROR"}: ${retryError.message}`,
							now,
						});
						if (failed.ok) await writeTeamTask(team.id, failed.task);
						break;
					}
				}
			}
			if (!sent) busy = true; // still busy after interrupt+retries: keep queued
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

/** Promise-based sleep for the interrupt grace period. */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

async function buildTeamStatus(team) {
	const index = await readTeamIndex(team.id);
	const narrators = await host.listNarrators({ limit: 100 });
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
	for (const member of view.members) {
		member.activeTask = activeByMember.get(member.id) ?? null;
	}
	return view;
}

/**
 * Fallback re-dispatch of queued tasks whose member is currently idle.
 * Runs on every team.status invocation so queued tasks recover even when the
 * event subscription is not active (e.g. right after a process recycle).
 */
async function retryQueuedTasksOnStatus() {
	const narrators = await host.listNarrators({ limit: 100 });
	const busy = new Set(
		(narrators ?? [])
			.filter((narrator) => narrator.status === "working" || narrator.status === "waiting")
			.map((narrator) => narrator.id),
	);
	for (const teamId of await listTeamIds()) {
		const index = await readTeamIndex(teamId);
		for (const taskId of index.ids) {
			const seq = Number(taskId.replace(/^task-/, ""));
			if (!Number.isInteger(seq)) continue;
			const task = await readTeamTask(teamId, seq);
			if (!task || task.status !== "queued" || busy.has(task.memberId)) continue;
			// Subagents: deliver through the host's subagent channel; failures
			// (e.g. never started by the parent) mark the task failed once.
			if (await isSubagentNarrator(task.memberId)) {
				try {
					const result = await host.sendSubagentMessage(task.memberId, task.prompt, {
						idempotencyKey: task.id,
					});
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
				const result = await host.sendMessage(task.memberId, task.prompt, {
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
	// Best-effort recovery of tasks stuck in `queued` while their member is idle.
	try {
		await retryQueuedTasksOnStatus();
	} catch {
		// recovery must never block the status view
	}
	await ensureTeamsMigrated();
	const teamId = typeof input === "object" && input !== null && typeof input.teamId === "string"
		? input.teamId
		: undefined;
	const narrators = await host.listNarrators({ limit: 100 });
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
		teams.push(await buildTeamStatus(team));
	} else {
		for (const id of teamIds) {
			const team = await readTeamConfig(id);
			if (core.narratorInTeam(team, callerNarratorId)) {
				teams.push(await buildTeamStatus(team));
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

	let deleted = false;
	try {
		await host.deleteNarrator(memberId);
		deleted = true;
	} catch {
		// narrator deletion is best-effort; the team membership is already gone
	}
	return { ok: true, teamId: team.id, memberId, role, deleted };
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
	for (const teamId of await listTeamIds()) {
		const index = await readTeamIndex(teamId);
		for (const taskId of index.ids) {
			const seq = Number(taskId.replace(/^task-/, ""));
			if (!Number.isInteger(seq)) continue;
		const task = await readTeamTask(teamId, seq);
		if (!task || task.status !== "queued" || task.memberId !== memberId) continue;
		// Subagents: deliver through the host's subagent channel (see dispatch).
		if (await isSubagentNarrator(memberId)) {
			try {
				const result = await host.sendSubagentMessage(memberId, task.prompt, {
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
				const result = await host.sendMessage(memberId, task.prompt, {
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

/** A member sent a message: complete their open sent tasks and tell the leader. */
async function markMemberResponded(memberId) {
	for (const teamId of await listTeamIds()) {
		const team = await readTeamConfig(teamId);
		const index = await readTeamIndex(teamId);
		let completed = false;
		for (const taskId of index.ids) {
			const seq = Number(taskId.replace(/^task-/, ""));
			if (!Number.isInteger(seq)) continue;
			const task = await readTeamTask(teamId, seq);
			if (!task || task.status !== "sent" || task.memberId !== memberId) continue;
			const updated = core.updateTaskStatus(task, "done", {});
			if (updated.ok) {
				await writeTeamTask(teamId, updated.task);
				completed = true;
			}
		}
		if (completed && team.leaderId && team.leaderId !== memberId) {
			try {
				await host.sendMessage(
					team.leaderId,
					`团队成员 ${memberId} 已就指派的任务做出回复，请在其聊天页查看最新进展。`,
					{ idempotencyKey: `team-notify-${memberId}-${Date.now()}` },
				);
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

rpc.sendNotification("hello", {
	pluginId: PLUGIN_ID,
	version: PLUGIN_VERSION,
	packageDigest: typeof process.env.NF_PLUGIN_PACKAGE_DIGEST === "string" ? process.env.NF_PLUGIN_PACKAGE_DIGEST : undefined,
	rpcProtocol: RPC_PROTOCOL,
	features: ["host_api.requests"],
});
