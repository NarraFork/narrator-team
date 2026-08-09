/**
 * team-core.js — pure business logic for the Narrator Team plugin.
 *
 * No I/O, no RPC: every function takes plain values and returns plain values,
 * so the whole module is directly unit-testable with `bun test`.
 *
 * Storage shapes (persisted under the plugin's `storage.read_self` namespace):
 *
 *   team.config   { name, leaderId, members: string[], memberRoles,
 *                   recruitedBy, updatedAt }
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

/** Build an empty team config. */
export function defaultTeamConfig() {
	return {
		name: "",
		leaderId: null,
		members: [],
		memberRoles: {},
		recruitedBy: {},
		updatedAt: null,
	};
}

/**
 * Parse and normalize a persisted team config (tolerant of missing fields).
 * @param {unknown} raw
 * @returns {{ name: string, leaderId: string | null, members: string[],
 *             memberRoles: Record<string, "member" | "temp">,
 *             recruitedBy: Record<string, string>, updatedAt: string | null }}
 */
export function parseTeamConfig(raw) {
	if (typeof raw !== "object" || raw === null) return defaultTeamConfig();
	const value = raw;
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
		leaderId: typeof value.leaderId === "string" ? value.leaderId : null,
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
 * @param {{ name?: string, leaderId?: string | null, members?: string[] }} patch
 * @param {string} now — ISO timestamp
 * @returns {ReturnType<typeof parseTeamConfig>}
 */
export function applyTeamConfigPatch(current, patch, now) {
	const next = {
		name: current.name,
		leaderId: current.leaderId,
		members: [...current.members],
		memberRoles: { ...current.memberRoles },
		recruitedBy: { ...current.recruitedBy },
		updatedAt: now,
	};
	if (patch.name !== undefined && patch.name !== null) {
		next.name = String(patch.name).slice(0, 120);
	}
	if (patch.leaderId !== undefined) {
		next.leaderId = typeof patch.leaderId === "string" ? patch.leaderId : null;
	}
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
	const memberRoles = { ...config.memberRoles };
	const recruited = { ...config.recruitedBy };
	delete memberRoles[id];
	delete recruited[id];
	return { ...config, members, memberRoles, recruitedBy: recruited, updatedAt: config.updatedAt };
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
	if (config.leaderId !== null && !known.has(config.leaderId)) {
		errors.push(`Leader narrator not found: ${config.leaderId}`);
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
	if (config.leaderId !== null && memberId === config.leaderId) {
		return { ok: false, reason: "Cannot dispatch a task to the team leader" };
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
	const leader = config.leaderId === null ? null : summarizeNarrator(config.leaderId);
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
	}));
	return {
		id: config.id ?? null,
		name: config.name,
		leaderId: config.leaderId,
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
 * @returns {{ id: string, name: string, leaderId: string | null, members: string[],
 *             memberRoles: Record<string, "member" | "temp">,
 *             recruitedBy: Record<string, string>,
 *             createdAt: string | null, updatedAt: string | null }}
 */
export function parseTeam(raw) {
	if (typeof raw !== "object" || raw === null) return defaultTeam("team", null);
	const value = raw;
	const id = typeof value.id === "string" && value.id.trim().length > 0 ? value.id : "team";
	const members = Array.isArray(value.members)
		? value.members
				.filter((member) => typeof member === "string")
				.slice(0, QUEUE_LIMITS.maxMembers)
		: [];
	return {
		id,
		name: typeof value.name === "string" ? value.name.slice(0, 120) : "",
		leaderId: typeof value.leaderId === "string" ? value.leaderId : null,
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
 * untouched; empty string clears name; null clears leaderId.
 * @param {ReturnType<typeof parseTeam>} current
 * @param {{ name?: string, leaderId?: string | null, members?: string[] }} patch
 * @param {string} now — ISO timestamp
 * @returns {ReturnType<typeof parseTeam>}
 */
export function applyTeamPatch(current, patch, now) {
	const next = {
		id: current.id,
		name: current.name,
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
	if (patch.leaderId !== undefined) {
		next.leaderId = typeof patch.leaderId === "string" ? patch.leaderId : null;
	}
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
	return next;
}

/**
 * Whether a narrator is part of the team (member or leader).
 * @param {ReturnType<typeof parseTeam>} team
 * @param {string} narratorId
 */
export function narratorInTeam(team, narratorId) {
	if (!team || typeof narratorId !== "string" || narratorId.length === 0) return false;
	if (team.leaderId === narratorId) return true;
	return team.members.includes(narratorId);
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
