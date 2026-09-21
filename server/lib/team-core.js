/**
 * team-core.js — pure business logic for the Narrator Team plugin.
 *
 * No I/O, no RPC: every function takes plain values and returns plain values,
 * so the whole module is directly unit-testable with `bun test`.
 *
 * Storage shapes (persisted under the plugin's `storage.read_self` namespace):
 *
 *   team.config   { name, leaderIds: string[], leaderId, members: string[],
 *                   memberRoles, recruitedBy, updatedAt }
 *   tasks.index   { nextSeq: number, ids: string[] }   // newest first, capped
 *   tasks.<id>    { id, seq, memberId, prompt, status, assignedAt, messageId?, error? }
 *
 * Member roles: "member" (a regular primary narrator, recruited by the leader)
 * or "temp" (a disposable subagent worker recruited by any member to help with
 * bursts of work; they can be fired at any time).
 */

export const TASK_STATUSES = ["queued", "sent", "done", "failed"];

export const MEMBER_ROLES = ["member", "temp"];

export const QUEUE_LIMITS = {
	maxTasks: 200,
	maxPromptChars: 4000,
	maxMembers: 50,
};

/**
 * Queue auto-maintenance knobs. Finished (done/failed) tasks are pruned
 * beyond the retention window so the queue does not grow without bound; the
 * soft limit keeps the total index compact regardless of activity count.
 */
export const FINISHED_RETENTION = 30;
export const QUEUE_SOFT_LIMIT = 50;

/** Build an empty team config. */
export function defaultTeamConfig() {
	return {
		name: "",
		leaderIds: [],
		leaderId: null,
		members: [],
		memberRoles: {},
		recruitedBy: {},
		updatedAt: null,
	};
}

/** Normalize the canonical multi-Leader field while accepting legacy leaderId. */
function normalizeLeaderIds(value) {
	const source = Array.isArray(value?.leaderIds)
		? value.leaderIds
		: typeof value?.leaderId === "string"
			? [value.leaderId]
			: [];
	return [...new Set(source)].filter((id) => typeof id === "string" && id.length > 0).slice(0, QUEUE_LIMITS.maxMembers);
}

/**
 * Parse and normalize a persisted team config (tolerant of missing fields).
 * @param {unknown} raw
 * @returns {{ name: string, leaderIds: string[], leaderId: string | null, members: string[],
 *             memberRoles: Record<string, "member" | "temp">,
 *             recruitedBy: Record<string, string>, updatedAt: string | null }}
 */
export function parseTeamConfig(raw) {
	if (typeof raw !== "object" || raw === null) return defaultTeamConfig();
	const value = raw;
	const leaderIds = normalizeLeaderIds(value);
	const members = Array.isArray(value.members)
		? value.members
				.filter((member) => typeof member === "string")
				.slice(0, QUEUE_LIMITS.maxMembers)
		: [];
	const memberRoles = {};
	if (value.memberRoles && typeof value.memberRoles === "object") {
		for (const [id, role] of Object.entries(value.memberRoles)) {
			if (members.includes(id) && MEMBER_ROLES.includes(role)) memberRoles[id] = role;
		}
	}
	const recruitedBy = {};
	if (value.recruitedBy && typeof value.recruitedBy === "object") {
		for (const [id, recruiter] of Object.entries(value.recruitedBy)) {
			if (members.includes(id) && typeof recruiter === "string") recruitedBy[id] = recruiter;
		}
	}
	return {
		name: typeof value.name === "string" ? value.name.slice(0, 120) : "",
		leaderIds,
		leaderId: leaderIds[0] ?? null,
		members,
		memberRoles,
		recruitedBy,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
	};
}

/** Role of a member ("member" or "temp"); unknown members default to "member". */
export function memberRole(config, memberId) {
	return config.memberRoles && config.memberRoles[memberId] === "temp" ? "temp" : "member";
}

/** Whether the member is a disposable temp worker (subagent). */
export function isTempWorker(config, memberId) {
	return memberRole(config, memberId) === "temp";
}

/**
 * Merge a partial config update into an existing config.
 * Null/undefined fields are left untouched; empty string clears name.
 * @param {ReturnType<typeof parseTeamConfig>} current
 * @param {{ name?: string, leaderIds?: string[], leaderId?: string | null, members?: string[] }} patch
 * @param {string} now — ISO timestamp
 * @returns {ReturnType<typeof parseTeamConfig>}
 */
export function applyTeamConfigPatch(current, patch, now) {
	const next = {
		name: current.name,
		leaderIds: [...(current.leaderIds ?? (current.leaderId ? [current.leaderId] : []))],
		leaderId: current.leaderId,
		members: [...current.members],
		memberRoles: { ...current.memberRoles },
		recruitedBy: { ...current.recruitedBy },
		updatedAt: now,
	};
	if (patch.name !== undefined && patch.name !== null) {
		next.name = String(patch.name).slice(0, 120);
	}
	if (patch.leaderIds !== undefined) {
		next.leaderIds = Array.isArray(patch.leaderIds)
			? [...new Set(patch.leaderIds)]
					.filter((id) => typeof id === "string" && id.length > 0)
					.slice(0, QUEUE_LIMITS.maxMembers)
			: [];
	} else if (patch.leaderId !== undefined) {
		next.leaderIds = typeof patch.leaderId === "string" && patch.leaderId.length > 0 ? [patch.leaderId] : [];
	}
	next.leaderId = next.leaderIds[0] ?? null;
	if (Array.isArray(patch.members)) {
		const members = [...new Set(patch.members)]
			.filter((member) => typeof member === "string")
			.slice(0, QUEUE_LIMITS.maxMembers);
		next.members = members;
		// Drop role/recruiter metadata for members no longer in the team.
		for (const id of Object.keys(next.memberRoles)) {
			if (!members.includes(id)) delete next.memberRoles[id];
		}
		for (const id of Object.keys(next.recruitedBy)) {
			if (!members.includes(id)) delete next.recruitedBy[id];
		}
	}
	for (const leaderId of next.leaderIds) {
		if (!next.members.includes(leaderId) && next.members.length < QUEUE_LIMITS.maxMembers) {
			next.members.unshift(leaderId);
		}
	}
	return next;
}

/**
 * Add a member (or temp worker) to the team config.
 * @returns {ReturnType<typeof parseTeamConfig>} — new config
 */
export function addTeamMember(config, { id, role = "member", recruitedBy = null, now }) {
	const members = config.members.includes(id) ? config.members : [...config.members, id];
	const memberRoles = {
		...config.memberRoles,
		...(role === "temp" ? { [id]: "temp" } : {}),
	};
	if (role !== "temp") delete memberRoles[id];
	const recruited = { ...config.recruitedBy };
	if (role === "temp" && recruitedBy) recruited[id] = recruitedBy;
	if (role !== "temp") delete recruited[id];
	return {
		...config,
		members,
		memberRoles,
		recruitedBy: recruited,
		updatedAt: now,
	};
}

/**
 * Remove a member (or temp worker) from the team config.
 * @returns {ReturnType<typeof parseTeamConfig>} — new config
 */
export function removeTeamMember(config, id) {
	const members = config.members.filter((member) => member !== id);
	const leaderIds = (config.leaderIds ?? (config.leaderId ? [config.leaderId] : [])).filter((leaderId) => leaderId !== id);
	const memberRoles = { ...config.memberRoles };
	const recruited = { ...config.recruitedBy };
	delete memberRoles[id];
	delete recruited[id];
	return {
		...config,
		leaderIds,
		leaderId: leaderIds[0] ?? null,
		members,
		memberRoles,
		recruitedBy: recruited,
		updatedAt: config.updatedAt,
	};
}

/**
 * Validate a team config against known narrators.
 * @param {ReturnType<typeof parseTeamConfig>} config
 * @param {{ narrators: Array<{ id: string }> }} context
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateTeamConfig(config, { narrators }) {
	const errors = [];
	const known = new Set((narrators ?? []).map((narrator) => narrator.id));
	const leaderIds = config.leaderIds ?? (config.leaderId ? [config.leaderId] : []);
	for (const leaderId of leaderIds) {
		if (!known.has(leaderId)) errors.push(`Leader narrator not found: ${leaderId}`);
	}
	for (const member of config.members) {
		if (!known.has(member)) errors.push(`Member narrator not found: ${member}`);
	}
	if (config.members.length === 0) {
		errors.push("Team has no members");
	}
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Parse and normalize a persisted task index. */
export function parseTaskIndex(raw) {
	if (typeof raw !== "object" || raw === null) {
		return { nextSeq: 1, ids: [] };
	}
	const value = raw;
	return {
		nextSeq:
			typeof value.nextSeq === "number" && Number.isInteger(value.nextSeq) && value.nextSeq > 0
				? value.nextSeq
				: 1,
		ids: Array.isArray(value.ids)
			? value.ids.filter((id) => typeof id === "string").slice(0, QUEUE_LIMITS.maxTasks)
			: [],
	};
}

/** Parse a single task record (tolerant). */
export function parseTask(raw) {
	if (typeof raw !== "object" || raw === null) return null;
	const value = raw;
	if (typeof value.id !== "string" || value.id.length === 0) return null;
	return {
		id: value.id,
		seq: typeof value.seq === "number" ? value.seq : 0,
		memberId: typeof value.memberId === "string" ? value.memberId : "",
		prompt: typeof value.prompt === "string" ? value.prompt : "",
		status: TASK_STATUSES.includes(value.status) ? value.status : "queued",
		assignedAt: typeof value.assignedAt === "string" ? value.assignedAt : null,
		messageId: typeof value.messageId === "string" ? value.messageId : null,
		error: typeof value.error === "string" ? value.error : null,
		completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
	};
}

/**
 * Append a task to the queue index (newest first). Older tasks are trimmed when
 * the queue exceeds QUEUE_LIMITS.maxTasks.
 * @param {ReturnType<typeof parseTaskIndex>} index
 * @param {string} taskId
 * @returns {{ index: ReturnType<typeof parseTaskIndex>, trimmed: string[] }}
 */
export function pushTaskIndex(index, taskId) {
	const ids = [taskId, ...index.ids.filter((id) => id !== taskId)];
	const trimmed = ids.length > QUEUE_LIMITS.maxTasks ? ids.splice(QUEUE_LIMITS.maxTasks) : [];
	// Advance the sequence so the next task gets a fresh id (task-N); without
	// this every dispatch would reuse the same task id and overwrite history.
	return { index: { nextSeq: index.nextSeq + 1, ids }, trimmed };
}

/**
 * Plan queue auto-maintenance: decide which finished tasks to drop.
 *
 * Active tasks (`queued`/`sent`) are NEVER pruned — they represent live work.
 * Finished tasks (`done`/`failed`) are kept newest-first up to
 * `FINISHED_RETENTION`, and the total index is additionally capped by
 * `QUEUE_SOFT_LIMIT` (finished slots shrink when many tasks are still active).
 * Callers perform the actual storage deletes and write back the retained index.
 *
 * @param {ReturnType<typeof parseTaskIndex>} index
 * @param {Array<ReturnType<typeof parseTask>>} tasks — all persisted task records
 * @returns {{ retainedIndex: ReturnType<typeof parseTaskIndex>, removeIds: string[] }}
 */
export function planTaskRetention(index, tasks, _options = {}) {
	const ids = Array.isArray(index?.ids) ? index.ids : [];
	const byId = new Map();
	for (const task of Array.isArray(tasks) ? tasks : []) {
		if (task && typeof task.id === "string") byId.set(task.id, task);
	}
	let activeCount = 0;
	for (const id of ids) {
		const task = byId.get(id);
		if (task && (task.status === "queued" || task.status === "sent")) activeCount += 1;
	}
	const finishedBudget = Math.max(0, Math.min(FINISHED_RETENTION, QUEUE_SOFT_LIMIT - activeCount));
	const kept = [];
	const removeIds = [];
	let finishedKept = 0;
	for (const id of ids) {
		const task = byId.get(id);
		// Unknown ids are preserved (defensive): pruning must never delete a
		// record it cannot inspect.
		if (!task) {
			kept.push(id);
			continue;
		}
		if (task.status === "queued" || task.status === "sent") {
			kept.push(id);
			continue;
		}
		if (task.status === "done" || task.status === "failed") {
			if (finishedKept < finishedBudget) {
				kept.push(id);
				finishedKept += 1;
			} else {
				removeIds.push(id);
			}
			continue;
		}
		kept.push(id);
	}
	return { retainedIndex: { ...index, ids: kept }, removeIds };
}

/**
 * Plan retirement of tasks whose member is no longer deliverable.
 * Active (`queued`/`sent`) tasks targeted at a removed member can never be
 * delivered, so they are transitioned to `failed`; finished tasks are left
 * untouched (they are already terminal).
 *
 * `narratorIds` is an optional host snapshot. When it is supplied, a member
 * that remains in the persisted team config but is absent from that snapshot
 * is treated as deleted by the host. An omitted snapshot means availability
 * could not be verified, so no host-deletion failure is planned.
 *
 * @param {Array<ReturnType<typeof parseTask>>} tasks
 * @param {{ memberIds: string[], narratorIds?: string[] }} context — current
 *   team members and, when available, the host narrator ids
 * @returns {Array<{ task: object, nextStatus: "failed", error: string }>}
 */
export function retireOrphanTasks(tasks, { memberIds, narratorIds } = {}) {
	const knownMembers = new Set(Array.isArray(memberIds) ? memberIds : []);
	// Defensive: when no member list is supplied (e.g. a transient config read
	// failure) retire nothing rather than mistakenly failing every active task.
	if (knownMembers.size === 0) return [];
	const knownNarrators = Array.isArray(narratorIds) ? new Set(narratorIds) : null;
	const plans = [];
	for (const task of Array.isArray(tasks) ? tasks : []) {
		if (!task || (task.status !== "queued" && task.status !== "sent")) continue;
		const error = !knownMembers.has(task.memberId)
			? "member no longer in team"
			: knownNarrators && !knownNarrators.has(task.memberId)
				? "member narrator no longer exists"
				: null;
		if (!error) continue;
		plans.push({ task, nextStatus: "failed", error });
	}
	return plans;
}

/** Accepted reasoning effort values (mirrors the host narrator profile schema). */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

/** Max length of a narrator title / model override. */
export const PROFILE_FIELD_MAX = 200;

/**
 * Validate and authorize a member profile patch from the calling narrator.
 *
 * Permission model (mirrors team.fire): the leader may update any member; a
 * non-leader member may only update temp workers they recruited. `spec` is a
 * write to the member's Dynamic Spec files and follows the same authorization.
 *
 * @param {ReturnType<typeof parseTeam>} team
 * @param {string} callerId
 * @param {{ memberId: string, title?: string, model?: string,
 *           reasoningEffort?: string | null, spec?: { uri: string, content: string } }} input
 * @returns {{ ok: true, plan: object } | { ok: false, reason: string }}
 */
export function planMemberProfilePatch(team, callerId, input) {
	if (!input || typeof input !== "object") {
		return { ok: false, reason: "Invalid update input" };
	}
	const memberId = typeof input.memberId === "string" ? input.memberId : "";
	if (!memberId) return { ok: false, reason: "memberId is required" };
	if (!team.members.includes(memberId)) {
		return { ok: false, reason: `Not a team member: ${memberId}` };
	}
	const role = memberRole(team, memberId);
	const isLeader = isTeamLeader(team, callerId);
	if (!isLeader) {
		const recruiter = team.recruitedBy?.[memberId];
		if (role !== "temp" || recruiter !== callerId) {
			return {
				ok: false,
				reason:
					"Only the team leader can update member profiles; members can only update temp workers they recruited",
			};
		}
	}
	const plan = { memberId };
	if (input.title !== undefined) {
		if (typeof input.title !== "string" || input.title.trim().length === 0) {
			return { ok: false, reason: "title must be a non-empty string" };
		}
		const title = input.title.trim();
		if (title.length > PROFILE_FIELD_MAX) {
			return { ok: false, reason: `title must be at most ${PROFILE_FIELD_MAX} characters` };
		}
		plan.title = title;
	}
	if (input.model !== undefined) {
		if (typeof input.model !== "string" || input.model.trim().length === 0) {
			return { ok: false, reason: "model must be a non-empty string" };
		}
		const model = input.model.trim();
		if (model !== "__default__" && model.length > PROFILE_FIELD_MAX) {
			return { ok: false, reason: `model must be at most ${PROFILE_FIELD_MAX} characters` };
		}
		plan.model = model;
	}
	if (input.reasoningEffort !== undefined) {
		const effort = input.reasoningEffort;
		if (effort !== null && !REASONING_EFFORTS.includes(effort)) {
			return {
				ok: false,
				reason: `reasoningEffort must be one of: ${REASONING_EFFORTS.join(", ")} or null`,
			};
		}
		plan.reasoningEffort = effort;
	}
	if (input.spec !== undefined) {
		if (!input.spec || typeof input.spec !== "object") {
			return { ok: false, reason: "spec must be an object with uri and content" };
		}
		const uri = typeof input.spec.uri === "string" ? input.spec.uri : "";
		const content = typeof input.spec.content === "string" ? input.spec.content : "";
		if (!["tasks.json", "index.md"].includes(uri)) {
			return { ok: false, reason: "spec.uri must be one of: tasks.json, index.md" };
		}
		if (content.length === 0) {
			return { ok: false, reason: "spec.content must not be empty" };
		}
		plan.spec = { uri, content };
	}
	if (plan.title === undefined && plan.model === undefined && plan.reasoningEffort === undefined && plan.spec === undefined) {
		return { ok: false, reason: "At least one of title, model, reasoningEffort or spec must be provided" };
	}
	return { ok: true, plan };
}

/**
 * Create a new queued task.
 * @returns {object} the task record
 */
export function createTask(index, { memberId, prompt, now, taskId, priority }) {
	return {
		id: taskId,
		seq: index.nextSeq,
		memberId,
		prompt: String(prompt).slice(0, QUEUE_LIMITS.maxPromptChars),
		priority: priority === "high" ? "high" : "normal",
		status: "queued",
		assignedAt: now,
		messageId: null,
		error: null,
		completedAt: null,
	};
}

/** Legal transitions for task status. */
const STATUS_TRANSITIONS = {
	queued: new Set(["sent", "failed", "done"]),
	sent: new Set(["done", "failed"]),
	failed: new Set(["queued", "done"]),
	done: new Set([]),
};

/**
 * Transition a task's status; rejects illegal transitions.
 * @param {object} task
 * @param {string} nextStatus
 * @param {{ error?: string, messageId?: string | null, now?: string }} patch
 * @returns {{ ok: true, task: object } | { ok: false, reason: string }}
 */
export function updateTaskStatus(task, nextStatus, patch = {}) {
	if (!TASK_STATUSES.includes(nextStatus)) {
		return { ok: false, reason: `Unknown status: ${nextStatus}` };
	}
	if (task.status === nextStatus) {
		return { ok: true, task: { ...task } };
	}
	if (!STATUS_TRANSITIONS[task.status]?.has(nextStatus)) {
		return {
			ok: false,
			reason: `Illegal transition: ${task.status} -> ${nextStatus}`,
		};
	}
	const next = {
		...task,
		status: nextStatus,
		error: patch.error !== undefined ? patch.error : task.error,
		messageId: patch.messageId !== undefined ? patch.messageId : task.messageId,
		completedAt:
			(nextStatus === "done" || nextStatus === "failed")
				? (patch.now ?? new Date().toISOString())
				: null,
	};
	return { ok: true, task: next };
}

/**
 * Plan a dispatch action. Validates member membership and returns the exact
 * actions the caller must perform (persist + send). The caller owns I/O.
 *
 * @param {ReturnType<typeof parseTeamConfig>} config
 * @param {{ memberId: string, task: string }} input
 * @param {{ now: string, taskId: string, index: ReturnType<typeof parseTaskIndex> }} context
 * @returns
 *   { ok: true, plan: { task: object, index: ReturnType<typeof parseTaskIndex>, trimmed: string[] } }
 *   | { ok: false, reason: string }
 */
export function planDispatch(config, input, context) {
	const { memberId, task } = input;
	if (typeof memberId !== "string" || memberId.length === 0) {
		return { ok: false, reason: "memberId is required" };
	}
	if (typeof task !== "string" || task.trim().length === 0) {
		return { ok: false, reason: "task prompt is required" };
	}
	if (!config.members.includes(memberId)) {
		return { ok: false, reason: `Not a team member: ${memberId}` };
	}
	if (isTeamLeader(config, memberId)) {
		return { ok: false, reason: "Cannot dispatch a task to a team leader" };
	}
	const taskRecord = createTask(context.index, {
		memberId,
		prompt: task,
		now: context.now,
		taskId: context.taskId,
		priority: input.priority,
	});
	const { index, trimmed } = pushTaskIndex(context.index, taskRecord.id);
	return { ok: true, plan: { task: taskRecord, index, trimmed } };
}

/**
 * Aggregate a status view from config, known narrators and queue records.
 * @returns {object} a JSON-safe status object
 */
export function buildStatusView(config, { narrators, tasks }) {
	const narratorById = new Map((narrators ?? []).map((narrator) => [narrator.id, narrator]));
	const summarizeNarrator = (id) => {
		const narrator = narratorById.get(id);
		return narrator
			? {
					id: narrator.id,
					title: narrator.title ?? null,
					handle: narrator.handle ?? null,
					variant: narrator.variant ?? "primary",
					type: narrator.type ?? "primary",
					status: narrator.status ?? "idle",
					substatus: Array.isArray(narrator.substatus) ? narrator.substatus : [],
					model: narrator.model ?? null,
					messageCount: typeof narrator.messageCount === "number" ? narrator.messageCount : 0,
					lastMessageAt: narrator.lastMessageAt ?? null,
				}
			: { id, title: null, status: "missing", messageCount: 0, lastMessageAt: null };
	};
	const members = config.members.map((id) => ({
		...summarizeNarrator(id),
		role: memberRole(config, id),
		recruitedBy: config.recruitedBy?.[id] ?? null,
	}));
	const leaderIds = config.leaderIds ?? (config.leaderId ? [config.leaderId] : []);
	const leaders = leaderIds.map((id) => summarizeNarrator(id));
	const leader = leaders[0] ?? null;
	const queue = (tasks ?? []).map((task) => ({
		id: task.id,
		seq: task.seq,
		memberId: task.memberId,
		prompt: task.prompt.length > 200 ? `${task.prompt.slice(0, 200)}…` : task.prompt,
		status: task.status,
		assignedAt: task.assignedAt,
		messageId: task.messageId,
		error: task.error,
		completedAt: task.completedAt,
		// Leader ↔ worker thread: follow-up instructions recorded on the task
		// (empty array when none). pendingFollowUp is the delivery marker for a
		// follow-up that could not be sent while the member was busy.
		followUps: Array.isArray(task.followUps) ? task.followUps : [],
		pendingFollowUp: task.pendingFollowUp ?? null,
	}));
	return {
		id: config.id ?? null,
		name: config.name,
		leaderIds,
		leaderId: leaderIds[0] ?? null,
		leaders,
		leader,
		members,
		queue,
		createdAt: config.createdAt ?? null,
		updatedAt: config.updatedAt,
	};
}

/** Create a deterministic task id (no crypto dependency needed). */
export function makeTaskId(seq) {
	return `task-${seq}`;
}

// ---------------------------------------------------------------------------
// Multi-team model
// ---------------------------------------------------------------------------
//
// A team is stored under `team.<teamId>.config` and its task queue under
// `team.<teamId>.tasks.index` / `team.<teamId>.tasks.<seq>`. Enumerating all
// teams is a prefix list over `team.`. The legacy single-team keys
// (`team.config`, `tasks.index`, `tasks.<id>`) are migrated once into a team
// whose id is `"default"` (see migrateLegacyTeam below).

/** Default id used when migrating the legacy single-team layout. */
export const LEGACY_TEAM_ID = "default";

/** Build a deterministic team id from a short random-ish suffix. */
export function makeTeamId(suffix) {
	const value = String(suffix ?? "");
	return value ? `team-${value}` : "team";
}

/** Build an empty team record. */
export function defaultTeam(id, now) {
	const timestamp = typeof now === "string" ? now : null;
	return {
		id,
		name: "",
		leaderIds: [],
		leaderId: null,
		members: [],
		memberRoles: {},
		recruitedBy: {},
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

/** Parse role/recruiter metadata that is kept in sync with `members`. */
function parseMemberMetadata(members, value, pick) {
	const out = {};
	if (!value || typeof value !== "object") return out;
	for (const [id, entry] of Object.entries(value)) {
		if (!members.includes(id)) continue;
		const picked = pick(entry);
		if (picked !== undefined && picked !== null) out[id] = picked;
	}
	return out;
}

/**
 * Parse and normalize a persisted team record (new multi-team shape).
 * @param {unknown} raw
 * @returns {{ id: string, name: string, leaderIds: string[], leaderId: string | null, members: string[],
 *             memberRoles: Record<string, "member" | "temp">,
 *             recruitedBy: Record<string, string>,
 *             createdAt: string | null, updatedAt: string | null }}
 */
export function parseTeam(raw) {
	if (typeof raw !== "object" || raw === null) return defaultTeam("team", null);
	const value = raw;
	const id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id : "team";
	const leaderIds = normalizeLeaderIds(value);
	const members = Array.isArray(value.members)
		? value.members
				.filter((member) => typeof member === "string")
				.slice(0, QUEUE_LIMITS.maxMembers)
		: [];
	return {
		id,
		name: typeof value.name === "string" ? value.name.slice(0, 120) : "",
		leaderIds,
		leaderId: leaderIds[0] ?? null,
		members,
		memberRoles: parseMemberMetadata(members, value.memberRoles, (entry) =>
			MEMBER_ROLES.includes(entry) ? entry : undefined,
		),
		recruitedBy: parseMemberMetadata(members, value.recruitedBy, (entry) =>
			typeof entry === "string" ? entry : undefined,
		),
		createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
	};
}

/**
 * Merge a partial update into an existing team. Null/undefined fields are left
 * untouched; empty string clears name; null clears leaderId/leaderIds.
 * @param {ReturnType<typeof parseTeam>} current
 * @param {{ name?: string, leaderIds?: string[], leaderId?: string | null, members?: string[] }} patch
 * @param {string} now — ISO timestamp
 * @returns {ReturnType<typeof parseTeam>}
 */
export function applyTeamPatch(current, patch, now) {
	const next = {
		id: current.id,
		name: current.name,
		leaderIds: [...(current.leaderIds ?? (current.leaderId ? [current.leaderId] : []))],
		leaderId: current.leaderId,
		members: [...current.members],
		memberRoles: { ...current.memberRoles },
		recruitedBy: { ...current.recruitedBy },
		createdAt: current.createdAt,
		updatedAt: now,
	};
	if (patch.name !== undefined && patch.name !== null) {
		next.name = String(patch.name).slice(0, 120);
	}
	if (patch.leaderIds !== undefined) {
		next.leaderIds = Array.isArray(patch.leaderIds)
			? [...new Set(patch.leaderIds)]
					.filter((id) => typeof id === "string" && id.length > 0)
					.slice(0, QUEUE_LIMITS.maxMembers)
			: [];
	} else if (patch.leaderId !== undefined) {
		next.leaderIds = typeof patch.leaderId === "string" && patch.leaderId.length > 0 ? [patch.leaderId] : [];
	}
	next.leaderId = next.leaderIds[0] ?? null;
	if (Array.isArray(patch.members)) {
		const members = [...new Set(patch.members)]
			.filter((member) => typeof member === "string")
			.slice(0, QUEUE_LIMITS.maxMembers);
		next.members = members;
		// Drop role/recruiter metadata for members no longer in the team.
		for (const key of Object.keys(next.memberRoles)) {
			if (!members.includes(key)) delete next.memberRoles[key];
		}
		for (const key of Object.keys(next.recruitedBy)) {
			if (!members.includes(key)) delete next.recruitedBy[key];
		}
	}
	for (const leaderId of next.leaderIds) {
		if (!next.members.includes(leaderId) && next.members.length < QUEUE_LIMITS.maxMembers) {
			next.members.unshift(leaderId);
		}
	}
	return next;
}

/** Whether a narrator has Leader permissions in the team. */
export function isTeamLeader(team, narratorId) {
	if (!team || typeof narratorId !== "string" || narratorId.length === 0) return false;
	const leaderIds = team.leaderIds ?? (team.leaderId ? [team.leaderId] : []);
	return leaderIds.includes(narratorId);
}

/**
 * Whether a narrator is part of the team (member or leader).
 * @param {ReturnType<typeof parseTeam>} team
 * @param {string} narratorId
 */
export function narratorInTeam(team, narratorId) {
	if (!team || typeof narratorId !== "string" || narratorId.length === 0) return false;
	return isTeamLeader(team, narratorId) || team.members.includes(narratorId);
}

/**
 * Migrate the legacy single-team layout into the multi-team shape.
 * Idempotent by construction: callers only invoke this when no `team.*` keys
 * exist yet; the returned team is always a fresh default team, and the legacy
 * keys are left untouched (they are simply ignored afterwards).
 *
 * @param {unknown} rawConfig — legacy `team.config`
 * @param {unknown} rawIndex — legacy `tasks.index`
 * @param {(taskId: string) => unknown} readTask — loader for legacy `tasks.<id>`
 * @returns {{ team: ReturnType<typeof defaultTeam>, tasks: Array<ReturnType<typeof parseTask>>, index: ReturnType<typeof parseTaskIndex> }}
 */
export async function migrateLegacyTeam(rawConfig, rawIndex, readTask) {
	const legacy = parseTeamConfig(rawConfig);
	const now = typeof legacy.updatedAt === "string" ? legacy.updatedAt : null;
	const team = {
		...defaultTeam(LEGACY_TEAM_ID, now),
		name: legacy.name,
		leaderIds: legacy.leaderIds ?? (legacy.leaderId ? [legacy.leaderId] : []),
		leaderId: legacy.leaderId,
		members: legacy.members,
		memberRoles: legacy.memberRoles,
		recruitedBy: legacy.recruitedBy,
	};
	const index = parseTaskIndex(rawIndex);
	const tasks = [];
	for (const id of index.ids) {
		const task = await readTask(id);
		if (task) tasks.push(task);
	}
	// Tasks are re-keyed under the team namespace; the team index mirrors the
	// legacy newest-first order.
	return { team, tasks, index };
}

// ---------------------------------------------------------------------------
// Shared context log (leader ↔ workers)
// ---------------------------------------------------------------------------

export const CONTEXT_LOG_LIMITS = Object.freeze({
	maxEntries: 500,
	maxTextChars: 4000,
	maxPayloadKeys: 24,
	maxTargets: 50,
});

export const CONTEXT_KINDS = Object.freeze(["fact", "result", "decision", "artifact", "instruction", "status"]);

export function makeContextId(suffix) {
	const value = String(suffix ?? "").trim();
	return value ? `ctx-${value}` : "ctx";
}

export function parseContextIndex(raw) {
	if (!raw || typeof raw !== "object") return { ids: [] };
	const ids = Array.isArray(raw.ids)
		? [...new Set(raw.ids.filter((id) => typeof id === "string" && id.length > 0))].slice(-CONTEXT_LOG_LIMITS.maxEntries)
		: [];
	return { ids };
}

export function parseContextEntry(raw) {
	if (!raw || typeof raw !== "object") return null;
	const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
	const sourceNarratorId = typeof raw.sourceNarratorId === "string" ? raw.sourceNarratorId : null;
	const text = typeof raw.text === "string" ? raw.text.slice(0, CONTEXT_LOG_LIMITS.maxTextChars).trim() : "";
	if (!id || !sourceNarratorId || !text) return null;
	const kind = CONTEXT_KINDS.includes(raw.kind) ? raw.kind : "status";
	const targetNarratorIds = Array.isArray(raw.targetNarratorIds)
		? [...new Set(raw.targetNarratorIds.filter((id) => typeof id === "string" && id.length > 0))].slice(0, CONTEXT_LOG_LIMITS.maxTargets)
		: [];
	const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
		? Object.fromEntries(
				Object.entries(raw.payload)
					.filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
					.slice(0, CONTEXT_LOG_LIMITS.maxPayloadKeys),
			)
		: {};
	return {
		id,
		kind,
		text,
		payload,
		sourceNarratorId,
		targetNarratorIds,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
	};
}

export function appendContextIndex(rawIndex, contextId) {
	const index = parseContextIndex(rawIndex);
	const ids = [contextId, ...index.ids.filter((id) => id !== contextId)].slice(0, CONTEXT_LOG_LIMITS.maxEntries);
	return { ids, trimmed: index.ids.filter((id) => !ids.includes(id)) };
}

export function filterContextEntries(entries, filter = {}) {
	const kind = typeof filter.kind === "string" ? filter.kind : null;
	const sourceNarratorId = typeof filter.sourceNarratorId === "string" ? filter.sourceNarratorId : null;
	const contains = typeof filter.contains === "string" ? filter.contains.trim().toLowerCase() : "";
	return entries.filter((entry) =>
		entry &&
		(!kind || entry.kind === kind) &&
		(!sourceNarratorId || entry.sourceNarratorId === sourceNarratorId) &&
		(!contains || entry.text.toLowerCase().includes(contains)),
	);
}

/** Per-target outcome of one context broadcast. */
export const CONTEXT_DELIVERY_STATUSES = Object.freeze(["delivered", "failed", "pending"]);

/**
 * Compose the member-facing message for a shared context record.
 *
 * The marker is deliberately distinct from `TEAM_TASK_MARKER`: a context
 * handoff is information, not an assignment, so it must not read as a task the
 * worker has to close with `team.report`. Keeping the two markers apart is what
 * lets the SOP's task-source rule stay unambiguous.
 */
export function contextPrompt(entry) {
	const payloadLines = Object.entries(entry.payload ?? {})
		.map(([key, value]) => `- ${key}: ${value}`)
		.join("\n");
	return [
		`[团队上下文 ${entry.id}（${entry.kind}）] 来自 ${entry.sourceNarratorId}：`,
		entry.text,
		...(payloadLines ? ["", "附加信息：", payloadLines] : []),
	].join("\n");
}

/**
 * Whether two context records carry the same handoff content.
 *
 * `createdAt` is deliberately excluded: it records when the handoff was first
 * stored, so a retry that re-sends the same record would otherwise be rejected
 * as a conflict purely because the clock moved — making the idempotent
 * "already delivered" path unreachable in practice.
 */
export function sameContextContent(a, b) {
	if (!a || !b) return false;
	return (
		a.id === b.id &&
		a.kind === b.kind &&
		a.text === b.text &&
		a.sourceNarratorId === b.sourceNarratorId &&
		JSON.stringify(a.payload) === JSON.stringify(b.payload) &&
		JSON.stringify(a.targetNarratorIds) === JSON.stringify(b.targetNarratorIds)
	);
}

/**
 * Normalize a persisted delivery receipt for one context record. Bounded like
 * every other stored record so a malformed row can never grow the response.
 */export function parseContextDeliveries(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { contextId: null, updatedAt: null, items: [] };
	}
	const items = Array.isArray(raw.items)
		? raw.items
				.slice(0, CONTEXT_LOG_LIMITS.maxTargets)
				.map((item) => ({
					narratorId: typeof item?.narratorId === "string" ? item.narratorId : null,
					status: CONTEXT_DELIVERY_STATUSES.includes(item?.status) ? item.status : "failed",
					messageId: typeof item?.messageId === "string" ? item.messageId : null,
					error: typeof item?.error === "string" ? item.error.slice(0, 500) : null,
				}))
				.filter((item) => item.narratorId !== null)
		: [];
	return {
		contextId: typeof raw.contextId === "string" ? raw.contextId : null,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
		items,
	};
}

/**
 * Summarize a delivery receipt for tool output: counts per status plus the
 * narrators that failed, which is what the Leader needs to act on.
 */
export function summarizeDeliveries(deliveries) {
	const items = Array.isArray(deliveries?.items) ? deliveries.items : [];
	return {
		total: items.length,
		delivered: items.filter((item) => item.status === "delivered").length,
		failed: items.filter((item) => item.status === "failed").map((item) => item.narratorId),
		items,
	};
}

// ---------------------------------------------------------------------------
// Collaboration visibility & follow-up (leader ↔ worker)
// ---------------------------------------------------------------------------

/** Max characters kept in a reply summary shown to the leader. */
export const REPLY_SUMMARY_MAX_CHARS = 300;

/** Max follow-up entries retained on one task record. */
export const FOLLOW_UP_LIMIT = 50;

/**
 * Summarize a member's recent assistant replies from a message list
 * (newest first, as returned by the host messages query). Keeps the newest
 * assistant text, truncated; returns null when there is no assistant reply.
 *
 * @param {Array<{ role: string, text?: string | null }>} messages
 * @param {number} [maxChars]
 * @returns {string | null}
 */
export function summarizeReplies(messages, maxChars = REPLY_SUMMARY_MAX_CHARS) {
	const list = Array.isArray(messages) ? messages : [];
	const reply = list.find((item) => item && item.role === "assistant" && typeof item.text === "string" && item.text.trim().length > 0);
	if (!reply) return null;
	const text = reply.text.trim();
	const chars = [...text];
	return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : text;
}

/**
 * Build the outbound prompt text for a follow-up instruction on an existing
 * task. Carries the same `[团队任务 task-N]` prefix as the dispatch message so
 * the worker can associate it with the original task.
 *
 * @param {object} task — the existing task record
 * @param {string} instruction
 * @returns {string}
 */
export function followUpPrompt(task, instruction) {
	const trimmed = typeof instruction === "string" ? instruction.trim() : "";
	const body = trimmed || "(无补充说明)";
	return `[团队任务 ${task.id}] Leader 追加指令：${body}`;
}

/**
 * Append a follow-up exchange to a task's thread. Keeps the newest
 * `FOLLOW_UP_LIMIT` entries (oldest dropped). Returns the updated task.
 *
 * @param {object} task — the existing task record
 * @param {{ fromId: string, toId: string, text: string, now?: string }} entry
 * @returns {object} a NEW task object with the thread appended
 */
export function appendFollowUp(task, { fromId, toId, text, now }) {
	const timestamp = typeof now === "string" && now ? now : new Date().toISOString();
	const followUps = Array.isArray(task.followUps) ? task.followUps : [];
	const next = [...followUps, { fromId, toId, text, at: timestamp }];
	const trimmed = next.length > FOLLOW_UP_LIMIT ? next.slice(next.length - FOLLOW_UP_LIMIT) : next;
	return { ...task, followUps: trimmed };
}

/**
 * Plain-text inclusion check used to decide whether a changed file path is
 * relevant to a task prompt. Case-insensitive, matches either the full path or
 * its basename against any prompt fragment.
 *
 * @param {string} filePath
 * @param {string} prompt
 * @returns {boolean}
 */
export function promptMentionsPath(filePath, prompt) {
	if (typeof filePath !== "string" || typeof prompt !== "string") return false;
	const needle = filePath.trim();
	if (!needle) return false;
	const haystack = prompt.toLowerCase();
	const basename = needle.split(/[/\\]/).pop() ?? needle;
	// Match the full path, the basename, or the basename without its extension
	// (e.g. "src/worker.ts" also matches "fix the worker").
	const stem = basename.includes(".") ? basename.slice(0, basename.lastIndexOf(".")) : basename;
	return (
		haystack.includes(needle.toLowerCase()) ||
		(basename.length > 0 && haystack.includes(basename.toLowerCase())) ||
		(stem.length > 0 && haystack.includes(stem.toLowerCase()))
	);
}
