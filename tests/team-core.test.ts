import { describe, expect, test } from "bun:test";
import * as core from "../server/lib/team-core.js";

const NOW = "2026-08-08T12:00:00.000Z";

describe("team config", () => {
	test("defaults to an empty team", () => {
		expect(core.defaultTeamConfig()).toEqual({
			name: "",
			leaderId: null,
			members: [],
			memberRoles: {},
			recruitedBy: {},
			updatedAt: null,
		});
	});

	test("parseTeamConfig tolerates missing and malformed fields", () => {
		expect(core.parseTeamConfig(null)).toEqual(core.defaultTeamConfig());
		expect(core.parseTeamConfig("junk")).toEqual(core.defaultTeamConfig());
		expect(
			core.parseTeamConfig({
				name: 42,
				leaderId: "n1",
				members: ["n2", 7, "n3"],
				updatedAt: NOW,
			}),
		).toEqual({
			name: "",
			leaderId: "n1",
			members: ["n2", "n3"],
			memberRoles: {},
			recruitedBy: {},
			updatedAt: NOW,
		});
	});

	test("applyTeamConfigPatch merges partial updates and dedupes members", () => {
		const current = core.parseTeamConfig({ name: "A", leaderId: "n1", members: ["n2", "n2", "n3"] });
		const next = core.applyTeamConfigPatch(current, { members: ["n3", "n4", "n3"] }, NOW);
		expect(next).toEqual({
			name: "A",
			leaderId: "n1",
			members: ["n3", "n4"],
			memberRoles: {},
			recruitedBy: {},
			updatedAt: NOW,
		});
	});

	test("validateTeamConfig rejects unknown narrators and empty teams", () => {
		const narrators = [{ id: "n1" }, { id: "n2" }];
		const ok = core.parseTeamConfig({ leaderId: "n1", members: ["n2"] });
		expect(core.validateTeamConfig(ok, { narrators })).toEqual({ ok: true });

		const badLeader = core.parseTeamConfig({ leaderId: "nX", members: ["n2"] });
		expect(core.validateTeamConfig(badLeader, { narrators }).ok).toBe(false);

		const badMember = core.parseTeamConfig({ leaderId: "n1", members: ["nX"] });
		const result = core.validateTeamConfig(badMember, { narrators });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toContain("Member narrator not found: nX");

		const noMembers = core.parseTeamConfig({ leaderId: "n1", members: [] });
		const empty = core.validateTeamConfig(noMembers, { narrators });
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.errors).toContain("Team has no members");
	});
});

describe("task queue", () => {
	test("parseTaskIndex defaults and tolerates malformed input", () => {
		expect(core.parseTaskIndex(null)).toEqual({ nextSeq: 1, ids: [] });
		expect(core.parseTaskIndex({ nextSeq: -3, ids: ["t1", 5] })).toEqual({
			nextSeq: 1,
			ids: ["t1"],
		});
	});

	test("createTask builds a queued task with a bounded prompt", () => {
		const index = { nextSeq: 7, ids: ["t6"] };
		const longPrompt = "x".repeat(5000);
		const task = core.createTask(index, {
			memberId: "n2",
			prompt: longPrompt,
			now: NOW,
			taskId: "task-7",
		});
		expect(task).toEqual({
			id: "task-7",
			seq: 7,
			memberId: "n2",
			prompt: "x".repeat(core.QUEUE_LIMITS.maxPromptChars),
			priority: "normal",
			status: "queued",
			assignedAt: NOW,
			messageId: null,
			error: null,
			completedAt: null,
		});
	});

	test("pushTaskIndex keeps newest first and trims beyond the cap", () => {
		let index = { nextSeq: 1, ids: [] };
		const trimmed = [];
		for (let i = 1; i <= core.QUEUE_LIMITS.maxTasks + 5; i += 1) {
			const result = core.pushTaskIndex(index, `task-${i}`);
			index = result.index;
			trimmed.push(...result.trimmed);
		}
		expect(index.ids.length).toBe(core.QUEUE_LIMITS.maxTasks);
		expect(index.ids[0]).toBe(`task-${core.QUEUE_LIMITS.maxTasks + 5}`);
		expect(trimmed).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5"]);
	});

	test("updateTaskStatus follows the legal state machine", () => {
		const base = core.parseTask({
			id: "task-1",
			seq: 1,
			memberId: "n2",
			prompt: "hi",
			status: "queued",
			assignedAt: NOW,
		});
		expect(base).not.toBeNull();

		const sent = core.updateTaskStatus(base, "sent", { messageId: "msg-1", now: NOW });
		expect(sent.ok).toBe(true);
		if (sent.ok) expect(sent.task.status).toBe("sent");

		const done = core.updateTaskStatus(sent.ok ? sent.task : base, "done", { now: NOW });
		expect(done.ok).toBe(true);
		if (done.ok) expect(done.task.completedAt).toBe(NOW);

		// done is terminal: no transitions out
		const rejected = core.updateTaskStatus(done.ok ? done.task : base, "failed", {});
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.reason).toContain("Illegal transition");
	});

	test("updateTaskStatus rejects unknown statuses", () => {
		const task = core.createTask({ nextSeq: 1, ids: [] }, { memberId: "n2", prompt: "x", now: NOW, taskId: "task-1" });
		const result = core.updateTaskStatus(task, "flying", {});
		expect(result.ok).toBe(false);
	});
});

describe("planDispatch", () => {
	const config = core.parseTeamConfig({ name: "T", leaderId: "n1", members: ["n2", "n3"] });
	const index = { nextSeq: 3, ids: ["task-2", "task-1"] };

	test("plans a dispatch to a member", () => {
		const result = core.planDispatch(
			config,
			{ memberId: "n3", task: "review chapter 3" },
			{ now: NOW, taskId: "task-3", index },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plan.task).toMatchObject({
				id: "task-3",
				seq: 3,
				memberId: "n3",
				status: "queued",
			});
			expect(result.plan.index.ids[0]).toBe("task-3");
		}
	});

	test("rejects non-members, empty prompts and the leader itself", () => {
		expect(
			core.planDispatch(config, { memberId: "nX", task: "x" }, { now: NOW, taskId: "t", index }).ok,
		).toBe(false);
		expect(
			core.planDispatch(config, { memberId: "n2", task: "   " }, { now: NOW, taskId: "t", index }).ok,
		).toBe(false);
		expect(
			core.planDispatch(config, { memberId: "n1", task: "x" }, { now: NOW, taskId: "t", index }).ok,
		).toBe(false);
		expect(core.planDispatch(config, { memberId: "n2", task: "x" }, { now: NOW, taskId: "t", index })).toMatchObject(
			{ ok: true },
		);
	});
});

describe("buildStatusView", () => {
	test("aggregates narrators and queue into a JSON-safe view", () => {
		const config = core.parseTeamConfig({ name: "T", leaderId: "n1", members: ["n2"] });
		const view = core.buildStatusView(
			config,
			{
				narrators: [
					{ id: "n1", title: "Leader", status: "idle", messageCount: 5, lastMessageAt: NOW },
					{ id: "n2", title: "Worker", status: "working", messageCount: 1, lastMessageAt: NOW },
				],
				tasks: [
					{
						id: "task-1",
						seq: 1,
						memberId: "n2",
						prompt: "x".repeat(500),
						status: "sent",
						assignedAt: NOW,
						messageId: "m1",
						error: null,
						completedAt: null,
					},
				],
			},
		);
		expect(view.leader).toMatchObject({ id: "n1", title: "Leader", status: "idle" });
		expect(view.members[0]).toMatchObject({ id: "n2", title: "Worker", status: "working" });
		expect(view.queue[0].prompt).toBe(`${"x".repeat(200)}…`);
		expect(view.queue[0]).toMatchObject({ status: "sent", memberId: "n2" });
	});

	test("marks unknown narrators as missing", () => {
		const config = core.parseTeamConfig({ name: "T", leaderId: null, members: ["nX"] });
		const view = core.buildStatusView(config, { narrators: [], tasks: [] });
		expect(view.members[0]).toMatchObject({ id: "nX", status: "missing" });
	});
});

describe("multi-team model", () => {
	test("defaultTeam builds an empty team with id and timestamps", () => {
		expect(core.defaultTeam("team-a", NOW)).toEqual({
			id: "team-a",
			name: "",
			leaderId: null,
			members: [],
			memberRoles: {},
			recruitedBy: {},
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	test("makeTeamId prefixes a suffix", () => {
		expect(core.makeTeamId("abc")).toBe("team-abc");
		expect(core.makeTeamId(undefined)).toBe("team");
	});

	test("parseTeam tolerates missing/malformed fields and keeps id", () => {
		expect(core.parseTeam(null)).toEqual(core.defaultTeam("team", null));
		const parsed = core.parseTeam({
			id: "team-x",
			name: 42,
			leaderId: "n1",
			members: ["n2", 7, "n3"],
			createdAt: NOW,
			updatedAt: NOW,
		});
		expect(parsed).toEqual({
			id: "team-x",
			name: "",
			leaderId: "n1",
			members: ["n2", "n3"],
			memberRoles: {},
			recruitedBy: {},
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	test("applyTeamPatch merges partial updates preserving id/createdAt", () => {
		const current = core.parseTeam({
			id: "team-x",
			name: "A",
			leaderId: "n1",
			members: ["n2", "n2", "n3"],
			createdAt: NOW,
			updatedAt: null,
		});
		const next = core.applyTeamPatch(current, { members: ["n3", "n4", "n3"] }, NOW);
		expect(next).toEqual({
			id: "team-x",
			name: "A",
			leaderId: "n1",
			members: ["n3", "n4"],
			memberRoles: {},
			recruitedBy: {},
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	test("member roles: addTeamMember marks temp workers and their recruiter", () => {
		const team = core.parseTeam({ id: "team-x", leaderId: "n1", members: ["n2"] });
		const withTemp = core.addTeamMember(team, {
			id: "n3",
			role: "temp",
			recruitedBy: "n2",
			now: NOW,
		});
		expect(withTemp.members).toEqual(["n2", "n3"]);
		expect(withTemp.memberRoles).toEqual({ n3: "temp" });
		expect(withTemp.recruitedBy).toEqual({ n3: "n2" });
		expect(core.memberRole(withTemp, "n3")).toBe("temp");
		expect(core.isTempWorker(withTemp, "n3")).toBe(true);
		expect(core.isTempWorker(withTemp, "n2")).toBe(false);

		// Recruiting a regular member clears any previous temp metadata.
		const withMember = core.addTeamMember(withTemp, { id: "n3", role: "member", now: NOW });
		expect(withMember.memberRoles).toEqual({});
		expect(withMember.recruitedBy).toEqual({});
		expect(core.memberRole(withMember, "n3")).toBe("member");
	});

	test("removeTeamMember drops roles and recruiter metadata", () => {
		const team = core.parseTeam({
			id: "team-x",
			leaderId: "n1",
			members: ["n2", "n3"],
			memberRoles: { n3: "temp" },
			recruitedBy: { n3: "n2" },
		});
		const after = core.removeTeamMember(team, "n3");
		expect(after.members).toEqual(["n2"]);
		expect(after.memberRoles).toEqual({});
		expect(after.recruitedBy).toEqual({});
	});

	test("parseTeam drops role metadata for members that no longer exist", () => {
		const team = core.parseTeam({
			id: "team-x",
			leaderId: "n1",
			members: ["n2"],
			memberRoles: { n3: "temp", n2: "temp" },
			recruitedBy: { n3: "n2", n2: "n1" },
		});
		expect(team.memberRoles).toEqual({ n2: "temp" });
		expect(team.recruitedBy).toEqual({ n2: "n1" });
	});

	test("narratorInTeam matches members and leader", () => {
		const team = core.parseTeam({ id: "team-x", leaderId: "n1", members: ["n2"] });
		expect(core.narratorInTeam(team, "n1")).toBe(true);
		expect(core.narratorInTeam(team, "n2")).toBe(true);
		expect(core.narratorInTeam(team, "n3")).toBe(false);
		expect(core.narratorInTeam(null, "n1")).toBe(false);
	});

	test("buildStatusView includes team id/createdAt", () => {
		const team = core.parseTeam({
			id: "team-x",
			name: "T",
			leaderId: "n1",
			members: ["n2"],
			createdAt: NOW,
			updatedAt: NOW,
		});
		const view = core.buildStatusView(team, {
			narrators: [{ id: "n1" }, { id: "n2" }],
			tasks: [],
		});
		expect(view.id).toBe("team-x");
		expect(view.createdAt).toBe(NOW);
	});

	test("migrateLegacyTeam folds the single-team layout into team.default", async () => {
		const rawConfig = { name: "Old", leaderId: "n1", members: ["n2"], updatedAt: NOW };
		const rawIndex = { nextSeq: 3, ids: ["task-2", "task-1"] };
		const tasksById = new Map([
			["task-1", { id: "task-1", seq: 1, memberId: "n2", prompt: "a", status: "done", assignedAt: NOW }],
			["task-2", { id: "task-2", seq: 2, memberId: "n2", prompt: "b", status: "sent", assignedAt: NOW }],
		]);
		const migrated = await core.migrateLegacyTeam(rawConfig, rawIndex, (id) => tasksById.get(id));
		expect(migrated.team).toMatchObject({
			id: core.LEGACY_TEAM_ID,
			name: "Old",
			leaderId: "n1",
			members: ["n2"],
			updatedAt: NOW,
		});
		expect(migrated.tasks.map((task) => task.id)).toEqual(["task-2", "task-1"]);
		expect(migrated.index).toEqual({ nextSeq: 3, ids: ["task-2", "task-1"] });
	});
});

