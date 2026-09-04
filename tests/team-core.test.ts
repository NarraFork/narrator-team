import { describe, expect, test } from "bun:test";
import * as core from "../server/lib/team-core.js";
import { TEMP_SOP, TEAM_TASK_MARKER, WORKER_SOP } from "../server/lib/team-sop.js";

const NOW = "2026-08-08T12:00:00.000Z";

describe("team config", () => {
	test("defaults to an empty team", () => {
		expect(core.defaultTeamConfig()).toEqual({
			name: "",
			leaderIds: [],
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
			leaderIds: ["n1"],
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
			leaderIds: ["n1"],
			leaderId: "n1",
			members: ["n1", "n3", "n4"],
			memberRoles: {},
			recruitedBy: {},
			updatedAt: NOW,
		});
	});

	test("supports canonical multi-Leader config while preserving legacy leaderId", () => {
		const parsed = core.parseTeamConfig({
			leaderIds: ["n1", "n2", "n1"],
			leaderId: "stale-legacy-leader",
			members: ["n3"],
		});
		expect(parsed.leaderIds).toEqual(["n1", "n2"]);
		expect(parsed.leaderId).toBe("n1");

		const next = core.applyTeamConfigPatch(parsed, { leaderIds: ["n2", "n4"] }, NOW);
		expect(next.leaderIds).toEqual(["n2", "n4"]);
		expect(next.leaderId).toBe("n2");
		expect(next.members).toEqual(["n4", "n2", "n3"]);
		expect(core.isTeamLeader(next, "n2")).toBe(true);
		expect(core.isTeamLeader(next, "n4")).toBe(true);
		expect(core.isTeamLeader(next, "n1")).toBe(false);
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

describe("queue auto-maintenance", () => {
	const makeTask = (id, status, memberId = "n2") =>
		core.parseTask({ id, seq: Number(id.replace(/^task-/, "")), memberId, prompt: "p", status, assignedAt: NOW });

	test("planTaskRetention keeps active tasks and prunes old finished ones", () => {
		// Newest first: task-9..task-1; 3 active + 6 finished beyond retention.
		const ids = ["task-9", "task-8", "task-7", "task-6", "task-5", "task-4", "task-3", "task-2", "task-1"];
		const tasks = [
			makeTask("task-9", "sent"),
			makeTask("task-8", "queued"),
			makeTask("task-7", "done"),
			makeTask("task-6", "done"),
			makeTask("task-5", "failed"),
			makeTask("task-4", "done"),
			makeTask("task-3", "done"),
			makeTask("task-2", "done"),
			makeTask("task-1", "failed"),
		];
		const index = { nextSeq: 10, ids };
		const { retainedIndex, removeIds } = core.planTaskRetention(index, tasks);
		// All 9 tasks fit within FINISHED_RETENTION: nothing is removed.
		expect(removeIds).toEqual([]);
		expect(retainedIndex.ids).toEqual(ids);
	});

	test("planTaskRetention trims beyond the retention window newest-first", () => {
		// 35 finished tasks + 1 active. FINISHED_RETENTION=30 keeps the 30
		// newest finished, drops the 5 oldest; active is always kept.
		const ids = [];
		const tasks = [];
		for (let i = 36; i >= 1; i -= 1) {
			const id = `task-${i}`;
			ids.push(id);
			tasks.push(makeTask(id, i === 36 ? "sent" : "done"));
		}
		const { retainedIndex, removeIds } = core.planTaskRetention({ nextSeq: 37, ids }, tasks);
		expect(retainedIndex.ids[0]).toBe("task-36"); // active kept at front
		expect(retainedIndex.ids.length).toBe(core.FINISHED_RETENTION + 1);
		expect(retainedIndex.ids).toContain("task-36");
		expect(retainedIndex.ids).toContain("task-6"); // newest 30 finished kept
		expect(retainedIndex.ids).not.toContain("task-5");
		expect(removeIds.sort()).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5"]);
	});

	test("planTaskRetention honours QUEUE_SOFT_LIMIT when many tasks are active", () => {
		// 40 finished + 45 active = 85 total. Finished budget shrinks to
		// QUEUE_SOFT_LIMIT - activeCount = 5, so only the 5 newest finished stay.
		const ids = [];
		const tasks = [];
		for (let i = 85; i >= 1; i -= 1) {
			const id = `task-${i}`;
			ids.push(id);
			const active = i <= 45;
			tasks.push(makeTask(id, active ? "sent" : "done"));
		}
		const { retainedIndex, removeIds } = core.planTaskRetention({ nextSeq: 86, ids }, tasks);
		expect(retainedIndex.ids.length).toBe(core.QUEUE_SOFT_LIMIT);
		expect(removeIds.length).toBe(85 - core.QUEUE_SOFT_LIMIT);
		// Newest finished kept: task-85..task-81 (5 entries).
		expect(retainedIndex.ids).toContain("task-81");
		expect(retainedIndex.ids).not.toContain("task-80");
		// All active tasks survive.
		expect(retainedIndex.ids).toContain("task-45");
		expect(retainedIndex.ids).toContain("task-1");
	});

	test("planTaskRetention preserves unknown ids defensively", () => {
		const index = { nextSeq: 3, ids: ["task-3", "task-2", "task-1"] };
		const tasks = [makeTask("task-3", "done"), makeTask("task-1", "failed")]; // task-2 missing
		const { retainedIndex, removeIds } = core.planTaskRetention(index, tasks);
		expect(retainedIndex.ids).toEqual(["task-3", "task-2", "task-1"]);
		expect(removeIds).toEqual([]);
	});

	test("retireOrphanTasks retires queued/sent tasks of removed members", () => {
		const tasks = [
			makeTask("task-1", "sent", "n-removed"),
			makeTask("task-2", "queued", "n-removed"),
			makeTask("task-3", "sent", "n2"),
			makeTask("task-4", "done", "n-removed"),
		];
		const plans = core.retireOrphanTasks(tasks, { memberIds: ["n1", "n2"] });
		expect(plans.map((plan) => plan.task.id)).toEqual(["task-1", "task-2"]);
		for (const plan of plans) {
			expect(plan.nextStatus).toBe("failed");
			expect(plan.error).toBe("member no longer in team");
		}
	});

	test("retireOrphanTasks ignores unknown memberIds input", () => {
		const tasks = [makeTask("task-1", "sent", "n2")];
		expect(core.retireOrphanTasks(tasks, { memberIds: null })).toEqual([]);
		expect(core.retireOrphanTasks([], { memberIds: ["n1"] })).toEqual([]);
	});

	test("retireOrphanTasks retires members deleted by the host", () => {
		const tasks = [
			makeTask("task-1", "queued", "n2"),
			makeTask("task-2", "sent", "n2"),
			makeTask("task-3", "sent", "n-removed"),
			makeTask("task-4", "done", "n2"),
			makeTask("task-5", "failed", "n2"),
		];
		const plans = core.retireOrphanTasks(tasks, {
			memberIds: ["n1", "n2"],
			narratorIds: ["n1"],
		});
		expect(plans.map((plan) => plan.task.id)).toEqual(["task-1", "task-2", "task-3"]);
		expect(plans.slice(0, 2).every((plan) => plan.error === "member narrator no longer exists")).toBe(true);
		expect(plans[2].error).toBe("member no longer in team");
		expect(plans.every((plan) => plan.nextStatus === "failed")).toBe(true);
	});

	test("retireOrphanTasks does not infer deletion when the host snapshot is unavailable", () => {
		const tasks = [makeTask("task-1", "sent", "n2")];
		expect(core.retireOrphanTasks(tasks, { memberIds: ["n2"] })).toEqual([]);
	});

	test("retireOrphanTasks treats an empty host snapshot as authoritative", () => {
		const tasks = [makeTask("task-1", "queued", "n2")];
		expect(core.retireOrphanTasks(tasks, { memberIds: ["n2"], narratorIds: [] })).toMatchObject([
			{ task: { id: "task-1" }, nextStatus: "failed", error: "member narrator no longer exists" },
		]);
	});
});

describe("member profile patch", () => {
	const team = () =>
		core.parseTeam({
			id: "team-x",
			name: "T",
			leaderId: "n1",
			members: ["n1", "n2", "n3"],
			memberRoles: { n3: "temp" },
			recruitedBy: { n3: "n2" },
		});

	test("leader can update any member's profile", () => {
		const result = core.planMemberProfilePatch(
			team(),
			"n1",
			{ memberId: "n2", title: "New Name", model: "claude-sonnet-4.5", reasoningEffort: "high" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plan).toMatchObject({
				memberId: "n2",
				title: "New Name",
				model: "claude-sonnet-4.5",
				reasoningEffort: "high",
			});
		}
	});

	test("recruiter can update their own temp worker only", () => {
		const ok = core.planMemberProfilePatch(team(), "n2", {
			memberId: "n3",
			title: "Temp",
		});
		expect(ok.ok).toBe(true);

		const denied = core.planMemberProfilePatch(team(), "n2", {
			memberId: "n1",
			title: "Leader",
		});
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.reason).toContain("Only the team leader");
	});

	test("non-leader cannot update a regular member they did not recruit", () => {
		const result = core.planMemberProfilePatch(team(), "n3", {
			memberId: "n2",
			title: "x",
		});
		expect(result.ok).toBe(false);
	});

	test("rejects unknown members, empty patches and bad values", () => {
		expect(core.planMemberProfilePatch(team(), "n1", { memberId: "nX", title: "x" }).ok).toBe(false);
		expect(core.planMemberProfilePatch(team(), "n1", { memberId: "n2" }).ok).toBe(false);
		expect(core.planMemberProfilePatch(team(), "n1", { memberId: "n2", title: "  " }).ok).toBe(false);
		expect(core.planMemberProfilePatch(team(), "n1", { memberId: "n2", reasoningEffort: "ultra" }).ok).toBe(false);
		expect(core.planMemberProfilePatch(team(), "n1", { memberId: "n2", title: "x".repeat(201) }).ok).toBe(false);
		expect(
			core.planMemberProfilePatch(team(), "n1", { memberId: "n2", model: "x".repeat(201) }).ok,
		).toBe(false);
	});

	test("reasoningEffort null resets to default; __default__ model is allowed", () => {
		const ok = core.planMemberProfilePatch(team(), "n1", {
			memberId: "n2",
			reasoningEffort: null,
			model: "__default__",
		});
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.plan.reasoningEffort).toBeNull();
			expect(ok.plan.model).toBe("__default__");
		}
	});

	test("spec patch validates uri whitelist and content", () => {
		const good = core.planMemberProfilePatch(team(), "n1", {
			memberId: "n2",
			spec: { uri: "index.md", content: "# Hello" },
		});
		expect(good.ok).toBe(true);
		if (good.ok) expect(good.plan.spec).toEqual({ uri: "index.md", content: "# Hello" });

		const badUri = core.planMemberProfilePatch(team(), "n1", {
			memberId: "n2",
			spec: { uri: "behavior_fence", content: "x" },
		});
		expect(badUri.ok).toBe(false);

		const empty = core.planMemberProfilePatch(team(), "n1", {
			memberId: "n2",
			spec: { uri: "tasks.json", content: "" },
		});
		expect(empty.ok).toBe(false);
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

	test("rejects every configured Leader as a dispatch target", () => {
		const multiLeader = core.parseTeamConfig({ leaderIds: ["n1", "n2"], members: ["n1", "n2", "n3"] });
		expect(
			core.planDispatch(multiLeader, { memberId: "n2", task: "x" }, { now: NOW, taskId: "t", index }).ok,
		).toBe(false);
		expect(
			core.planDispatch(multiLeader, { memberId: "n3", task: "x" }, { now: NOW, taskId: "t", index }).ok,
		).toBe(true);
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

	test("exposes all Leaders while retaining the legacy first leader field", () => {
		const config = core.parseTeamConfig({ leaderIds: ["n1", "n2"], members: ["n1", "n2", "n3"] });
		const view = core.buildStatusView(
			config,
			{
				narrators: [{ id: "n1", title: "One" }, { id: "n2", title: "Two" }],
				tasks: [],
			},
		);
		expect(view.leaderIds).toEqual(["n1", "n2"]);
		expect(view.leaders.map((leader) => leader.id)).toEqual(["n1", "n2"]);
		expect(view.leader.id).toBe("n1");
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
			leaderIds: [],
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
			leaderIds: ["n1"],
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
			leaderIds: ["n1"],
			leaderId: "n1",
			members: ["n1", "n3", "n4"],
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

describe("collaboration visibility & follow-up", () => {
	test("summarizeReplies picks the newest assistant text and truncates", () => {
		expect(core.summarizeReplies([])).toBeNull();
		expect(core.summarizeReplies(null)).toBeNull();
		expect(
			core.summarizeReplies([
				{ role: "user", text: "task" },
				{ role: "assistant", text: "  done  " },
			]),
		).toBe("done");
		// Newest first: the first assistant entry wins.
		expect(
			core.summarizeReplies([
				{ role: "assistant", text: "second reply" },
				{ role: "assistant", text: "first reply" },
			]),
		).toBe("second reply");
		// Truncation with ellipsis (character-aware for CJK).
		const long = "字".repeat(310);
		const summarized = core.summarizeReplies([{ role: "assistant", text: long }], 300);
		expect(summarized?.endsWith("…")).toBe(true);
		expect([...summarized.slice(0, -1)].length).toBe(300);
	});

	test("followUpPrompt carries the task prefix and instruction", () => {
		const task = { id: "task-3", prompt: "original" };
		expect(core.followUpPrompt(task, " 再检查一下边界  ")).toBe(
			"[团队任务 task-3] Leader 追加指令：再检查一下边界",
		);
		expect(core.followUpPrompt(task, "")).toContain("(无补充说明)");
	});

	test("appendFollowUp keeps newest entries and caps the thread", () => {
		const task = { id: "task-1", prompt: "p" };
		const now = "2026-08-08T13:00:00.000Z";
		const one = core.appendFollowUp(task, {
			fromId: "n-leader",
			toId: "n-worker",
			text: "do it",
			now,
		});
		expect(one.followUps).toEqual([
			{ fromId: "n-leader", toId: "n-worker", text: "do it", at: now },
		]);
		// Original task unchanged (immutability).
		expect(task.followUps).toBeUndefined();

		// Cap: only the newest FOLLOW_UP_LIMIT entries remain.
		let t = task;
		for (let i = 0; i < core.FOLLOW_UP_LIMIT + 5; i++) {
			t = core.appendFollowUp(t, {
				fromId: "n-leader",
				toId: "n-worker",
				text: `m${i}`,
				now,
			});
		}
		expect(t.followUps.length).toBe(core.FOLLOW_UP_LIMIT);
		expect(t.followUps[0].text).toBe("m5");
		expect(t.followUps[t.followUps.length - 1].text).toBe(`m${core.FOLLOW_UP_LIMIT + 4}`);
	});

	test("promptMentionsPath matches full path or basename case-insensitively", () => {
		expect(core.promptMentionsPath("src/worker.ts", "fix the worker")).toBe(true);
		expect(core.promptMentionsPath("src/Worker.TS", "fix worker")).toBe(true);
		expect(core.promptMentionsPath("src/a/b.ts", "check src/a/b.ts carefully")).toBe(true);
		expect(core.promptMentionsPath("src/unrelated.ts", "fix the worker")).toBe(false);
		expect(core.promptMentionsPath("", "anything")).toBe(false);
		expect(core.promptMentionsPath("a.ts", null)).toBe(false);
	});
});

describe("team task source SOP", () => {
	test("requires the stable marker and rejects unconditional reporting language", () => {
		expect(TEAM_TASK_MARKER).toBe("[团队任务 ");
		for (const sop of [WORKER_SOP, TEMP_SOP]) {
			expect(sop).toContain("带有 [团队任务 task-N（high|normal）] 标记");
			expect(sop).toContain("不要调用 team.report");
			expect(sop).toContain("不要因为自己是团队成员");
			expect(sop).toContain("team.context_broadcast");
			expect(sop).toMatch(/实际负责修改的成员|实际实施者/);
			expect(sop).toContain("不替代");
			expect(sop).toContain("原始 tool 输出");
			expect(sop).not.toContain("完成任务后必须调用 team.report");
		}
	});
});

describe("shared context log", () => {
	test("normalizes context records and filters the shared log", () => {
		const entry = core.parseContextEntry({
			id: "ctx-1",
			kind: "decision",
			text: "  Use the batched delivery path  ",
			payload: { accepted: true, nested: { nope: true } },
			sourceNarratorId: "leader",
			targetNarratorIds: ["worker", "worker"],
			createdAt: NOW,
		});
		expect(entry).toEqual({
			id: "ctx-1",
			kind: "decision",
			text: "Use the batched delivery path",
			payload: { accepted: true },
			sourceNarratorId: "leader",
			targetNarratorIds: ["worker"],
			createdAt: NOW,
		});
		expect(core.filterContextEntries([entry], { kind: "decision", contains: "BATCHED" })).toEqual([entry]);
	});

	test("appendContextIndex is idempotent and trims oldest ids", () => {
		const first = core.appendContextIndex({ ids: ["ctx-1", "ctx-2"] }, "ctx-2");
		expect(first).toEqual({ ids: ["ctx-2", "ctx-1"], trimmed: [] });
		const ids = Array.from({ length: core.CONTEXT_LOG_LIMITS.maxEntries + 1 }, (_, i) => `ctx-${i}`);
		const result = core.appendContextIndex({ ids: ids.slice(1) }, ids[0]);
		expect(result.ids.length).toBe(core.CONTEXT_LOG_LIMITS.maxEntries);
		expect(result.ids[0]).toBe(ids[0]);
	});
});

