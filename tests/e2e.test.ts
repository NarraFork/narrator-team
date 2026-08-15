/**
 * e2e.test.ts — end-to-end verification of the narrator-team plugin against a
 * real host assembly (PluginHostServices + PluginPublicApi + narrator adapter),
 * with the actual plugin process spawned over Content-Length RPC.
 *
 * This exercises the full chain that unit tests cannot:
 *   plugin process (stdio RPC) → host dispatcher → storage/commands.execute
 *   → public API authorization → narrator adapter → fake narrator-session
 *
 * Run from the narrafork checkout so tsconfig path aliases resolve:
 *   cd narrafork && bun test ../plugins/narrator-team/tests/e2e.test.ts
 *
 * The narrator-session behind send_message is faked here (it would otherwise
 * kick off a real agent loop); everything up to and including the public API
 * adapter boundary is the real implementation.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Host modules are imported via relative paths because this test file lives
// outside the narrafork checkout (path aliases like @server/* are resolved from
// the narrafork tsconfig, which applies to host files themselves, not this file).
import { CapabilityBroker } from "../../../narrafork/server/services/plugin-capability-broker";
import { PluginHostServices } from "../../../narrafork/server/services/plugin-host-services";
import { ValidationError } from "../../../narrafork/server/lib/errors";
import {
	createCorePluginPublicApiAdapters,
	PluginPublicApi,
} from "../../../narrafork/server/services/plugin-public-api";
import { LocalProcessRunner, PluginRuntime } from "../../../narrafork/server/services/plugin-runtime";
import { PluginStorageFactory } from "../../../narrafork/server/services/plugin-storage";
import { cleanDb, getTestDb } from "../../../narrafork/tests/setup";
import { eq } from "../../../narrafork/node_modules/drizzle-orm";
import {
	apiRequests,
	backgroundTasks,
	benchmarkTaskResults,
	chapters,
	chapterCommits,
	fileAttributions,
	gatewaySessionMappings,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorBufferedMessages,
	narratorFileSnapshots,
	narratorMessageRefs,
	narratorMessages,
	narratorPatches,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	narrators,
	projects,
	terminalTabs,
	terminalViewState,
	terminals,
} from "../../../narrafork/server/db/schema";

const PLUGIN_ID = "com.whisent.narrator-team";
const PLUGIN_ROOT = resolve(import.meta.dir, "..");
const CURSOR_SECRET = "e2e-narrator-team-cursor-secret-32-bytes";

const { db, sqlite } = getTestDb();
const tempRoot = mkdtempSync(join(tmpdir(), "narrator-team-e2e-"));

// Fake narrator-session: records what would have been sent, avoiding a real
// agent loop. This is the only boundary left on the host side.
const sent = [];
const subagentSent = [];
let failSubagentDelivery = false;
let narratorSeq = 0;
const createdNarrators = [];
const deletedNarrators = [];
// Fake per-member Dynamic Spec queues (spec://tasks.json mirror).
const specQueues = new Map();
let specSeq = 0;
const fakeSession = {
	async sendMessage(narratorId, prompt, _images, locale, _replyInUserLanguage, _commandText, _userId, _textFiles, _preBashCommand, origin) {
		sent.push({ narratorId, prompt, locale, originLabel: origin?.originLabel ?? null });
		return { id: `msg-${sent.length}`, seq: sent.length };
	},
	async sendSubagentMessage({ subagentId, message, priority }) {
		if (failSubagentDelivery) {
			throw new ValidationError("Cannot find the original Agent tool call for this subagent");
		}
		subagentSent.push({ subagentId, message, priority });
		return {
			delivered: "started",
			started: true,
			messageId: `smsg-${subagentSent.length}`,
		};
	},
	async specTaskAdd(narratorId, text) {
		specSeq += 1;
		const queue = specQueues.get(narratorId) ?? [];
		if (queue.some((entry) => entry.text === text)) {
			return { added: false, taskText: text, revisionId: `r${specSeq}` };
		}
		queue.push({ text, status: "todo" });
		specQueues.set(narratorId, queue);
		return { added: true, taskText: text, revisionId: `r${specSeq}` };
	},
	async specTasksGet(narratorId) {
		const queue = specQueues.get(narratorId) ?? [];
		return {
			content: JSON.stringify({ tasks: queue }),
			revisionId: "r0",
			compiled: {
				tasks: queue.map((entry) => ({ text: entry.text, status: entry.status, protected: true })),
				openCount: queue.filter((entry) => entry.status !== "done").length,
				protectedOpenCount: queue.filter((entry) => entry.status !== "done").length,
			},
		};
	},
	async createNarrator(input) {
		narratorSeq += 1;
		const id = `n-created-${narratorSeq}`;
		const now = "2026-08-08T12:00:00.000Z";
		// The plugin looks narrators up through the real listNarrators query, so
		// keep the fake host's created narrators visible in the test DB.
		db.insert(narrators)
			.values({
				id,
				chapterId: "ch1",
				type: input.type === "subagent" ? "subagent" : "primary",
				inheritMode: "fresh",
				title: input.title ?? `Created ${narratorSeq}`,
				variant: input.type === "subagent" ? "subagent:general" : "primary",
				parentNarratorId: input.type === "subagent" ? (input.parentNarratorId ?? null) : null,
				status: "idle",
				substatus: "[]",
				messageCount: 0,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		createdNarrators.push({ ...input, id });
		return {
			narratorId: id,
			title: input.title ?? null,
			variant: input.type === "subagent" ? "subagent:general" : "primary",
			type: input.type ?? "primary",
			model: input.model ?? null,
			cwd: input.cwd ?? null,
			status: "idle",
		};
	},
	async deleteNarrator(narratorId) {
		deletedNarrators.push(narratorId);
		db.delete(narrators).where(eq(narrators.id, narratorId)).run();
		return { deleted: true };
	},
	interruptNarrator() {
		return false;
	},
	async getById(id) {
		return { id };
	},
	async updateProfile(narratorId, patch) {
		const set = {
			...(patch.title !== undefined ? { title: patch.title } : {}),
			...(patch.model !== undefined ? { model: patch.model } : {}),
			...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
			updatedAt: new Date().toISOString(),
		};
		db.update(narrators).set(set).where(eq(narrators.id, narratorId)).run();
		return { updated: Object.keys(patch) };
	},
	async specWrite(narratorId, uri, content) {
		specQueues.set(`spec-file:${narratorId}:${uri}`, content);
		return { path: uri, uri: `spec://${uri}`, revisionId: "r-spec-1" };
	},
};

const pluginManagerStub = {
	async list() {
		return [];
	},
	async getStatus() {
		return undefined;
	},
	async enable() {
		throw new Error("not used in e2e");
	},
	async disable() {
		throw new Error("not used in e2e");
	},
};

const CAPABILITIES = [
	"query.read.narrators",
	"query.read.projects",
	"query.read.chapters",
	"command.narrator.send_message",
	"command.narrator.send_subagent_message",
	"command.narrator.interrupt",
	"command.narrator.create",
	"command.narrator.delete",
	"command.narrator.spec_tasks_get",
	"command.narrator.spec_task_add",
	"command.narrator.spec_behavior_fence_update",
	"command.narrator.update_profile",
	"command.narrator.spec_write",
	"storage.read_self",
	"storage.write_self",
	"ui.panel",
];

let hostServices;
let pluginRuntime;

function makeGrant(capability, index) {
	return {
		pluginId: PLUGIN_ID,
		installationId: "installation-e2e",
		grantId: `grant-${capability}`,
		capability,
		scope: { type: "global" },
		grantedBy: "admin-user-1",
		revision: index,
	};
}

beforeAll(async () => {
	// Seed the DB the narrator adapter queries against.
	const now = "2026-08-08T12:00:00.000Z";
	db.insert(projects)
		.values({ id: "p1", name: "Team Proj", gitPath: "/repo/p1", createdAt: now, updatedAt: now })
		.run();
	db.insert(chapters)
		.values({
			id: "ch1",
			projectId: "p1",
			title: "Chapter 1",
			branch: "chapter/ch1",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values({
			id: "n-leader",
			chapterId: "ch1",
			type: "primary",
			inheritMode: "fresh",
			title: "Leader",
			status: "idle",
			substatus: "[]",
			messageCount: 3,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values({
			id: "n-worker",
			chapterId: "ch1",
			type: "primary",
			inheritMode: "fresh",
			title: "Worker",
			status: "idle",
			substatus: "[]",
			messageCount: 1,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values({
			id: "n-other",
			chapterId: "ch1",
			type: "primary",
			inheritMode: "fresh",
			title: "Other",
			status: "idle",
			substatus: "[]",
			messageCount: 0,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values({
			id: "n-sub",
			chapterId: "ch1",
			type: "subagent",
			inheritMode: "fresh",
			title: "Subagent",
			variant: "subagent:explore",
			parentNarratorId: "n-leader",
			status: "idle",
			substatus: "[]",
			messageCount: 0,
			createdAt: now,
			updatedAt: now,
		})
		.run();

	// Real host assembly: broker + public API (with the narrator adapter) + storage.
	const capabilityBroker = new CapabilityBroker();
	hostServices = new PluginHostServices({
		capabilityBroker,
		publicApi: new PluginPublicApi({
			capabilityBroker,
			adapters: createCorePluginPublicApiAdapters({
				db,
				pluginManager: pluginManagerStub,
				narratorSession: fakeSession,
			}),
			cursorSecret: CURSOR_SECRET,
		}),
		storageFactory: new PluginStorageFactory({ root: join(tempRoot, "storage") }),
	});
	const binding = hostServices.bindRuntime({
		pluginId: PLUGIN_ID,
		packageVersion: "0.1.42",
		installationId: "installation-e2e",
		runtimeId: "runtime-e2e",
		runtimeGeneration: 1,
		grantRevision: 1,
		desiredState: "enabled",
		runtimeState: "active",
		compatibilityState: "compatible",
		manifestRequested: CAPABILITIES,
		grants: CAPABILITIES.map((capability, index) => makeGrant(capability, index + 1)),
	});

	// Spawn the actual plugin process and wire its host-facing dispatcher.
	pluginRuntime = new PluginRuntime({
		pluginId: PLUGIN_ID,
		pluginVersion: "0.1.42",
		installationId: "installation-e2e",
		runtimeId: "runtime-e2e",
		command: [process.execPath, join(PLUGIN_ROOT, "server/index.js")],
		cwd: PLUGIN_ROOT,
		rpcProtocol: "narrafork.rpc/1",
		dispatcher: binding.dispatcher,
		runner: new LocalProcessRunner({
			allowedCwds: [PLUGIN_ROOT, tempRoot],
			maxBodyBytes: 1 * 1024 * 1024,
			maxStdoutBytes: 4 * 1024 * 1024,
			maxStderrBytes: 256 * 1024,
			maxStderrBytesPerSecond: 256 * 1024,
			spawnTimeoutMs: 20_000,
			idleTimeoutMs: 60_000,
			totalTimeoutMs: 120_000,
			resourceLimits: { cpuTimeSeconds: 60, memoryBytes: 1024 * 1024 * 1024 },
			allowUnboundedResourceUsage: process.platform === "win32",
		}),
		timeouts: {
			handshakeMs: 20_000,
			activationMs: 20_000,
			rpcMs: 20_000,
			drainMs: 1_000,
			shutdownMs: 2_000,
			cancelGraceMs: 500,
		},
	});
	await pluginRuntime.start();
	expect(pluginRuntime.state).toBe("active");
});

afterAll(async () => {
	await pluginRuntime?.shutdown();
	cleanDb(sqlite);
	try {
		rmSync(tempRoot, { recursive: true, force: true, maxRetries: 2 });
	} catch {
		// Windows may still hold handles; the OS temp dir reclaims it later.
	}
});

describe("narrator-team end-to-end", () => {
	// Shared between the ordered tests below (bun runs them in file order).
	let teamAId = "";
	let teamBId = "";

	/** Helper: invoke a contribution with an optional calling narrator. */
	function invoke(contributionId, input, narratorId) {
		const context = { requestId: "e2e-req", correlationId: "e2e" };
		if (narratorId) context.scope = { narratorId };
		return pluginRuntime.request("tools.invoke", {
			contributionId,
			input,
			context,
		});
	}

	/** Read a stored value from the plugin's persisted document (global scope). */
	function readStored(key) {
		const docPath = join(tempRoot, "storage", `${PLUGIN_ID}.json`);
		const doc = JSON.parse(readFileSync(docPath, "utf8"));
		return doc.scopes?.["global\u0000"]?.[key]?.value;
	}

	test("handshake succeeded and team.status reports no teams initially", async () => {
		const result = await invoke("team.status", {}).catch((error) => {
			console.log("AUDIT:", error.audit);
			throw error;
		});
		expect(result.output).toBeDefined();
		const status = JSON.parse(result.output);
		expect(status).toMatchObject({ ok: true, teams: [] });
		expect(Array.isArray(status.availableNarrators)).toBe(true);
	});

	test("team.setup creates a first team owned by the caller narrator", async () => {
		const result = await invoke(
			"team.setup",
			{ name: "Team A", members: ["n-worker"] },
			"n-leader",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.ok).toBe(true);
		expect(output.leaderId).toBe("n-leader");
		expect(output.members).toContain("n-leader"); // leader auto-added
		expect(output.members).toContain("n-worker");
		teamAId = output.teamId;
		expect(teamAId).toMatch(/^team-/);

		// Persisted under the team-scoped key.
		const persisted = readStored(`team.${teamAId}.config`);
		expect(persisted).toMatchObject({ id: teamAId, leaderId: "n-leader", members: ["n-leader", "n-worker"] });
	});

	test("team.setup creates a second team with a different owner", async () => {
		const result = await invoke(
			"team.setup",
			{ name: "Team B", leaderId: "n-other", members: ["n-worker"] },
			"n-other",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		teamBId = output.teamId;
		expect(teamBId).not.toBe(teamAId);
		expect(output.leaderId).toBe("n-other");
	});

	test("team.status filters to the calling narrator's teams", async () => {
		// n-leader belongs only to Team A.
		const leaderView = JSON.parse((await invoke("team.status", {}, "n-leader")).output);
		expect(leaderView.ok).toBe(true);
		expect(leaderView.teams).toHaveLength(1);
		expect(leaderView.teams[0].id).toBe(teamAId);
		expect(leaderView.teams[0].name).toBe("Team A");
		expect(leaderView.teams[0].leader).toMatchObject({ id: "n-leader", title: "Leader", status: "idle" });

		// A caller with no team sees nothing.
		const outsider = JSON.parse((await invoke("team.status", {}, "n-outsider")).output);
		expect(outsider.teams).toHaveLength(0);
	});

	test("team.dispatch targets an explicit teamId", async () => {
		const result = await invoke(
			"team.dispatch",
			{ teamId: teamAId, memberId: "n-worker", task: "review chapter 3 and report back" },
			"n-leader",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.teamId).toBe(teamAId);
		expect(output.status).toBe("sent");
		expect(output.taskId).toBe("task-1");

		// The fake narrator-session received the task prompt (with the
		// team.report closing-the-loop hint appended) and plugin attribution.
		expect(sent).toHaveLength(1);
		expect(sent[0].narratorId).toBe("n-worker");
		expect(sent[0].prompt).toContain("review chapter 3 and report back");
		expect(sent[0].prompt).toContain("[团队任务 task-1（normal）]");
		expect(sent[0].prompt).toContain("[团队协作准则 · Worker]"); // role SOP appended
		expect(sent[0].locale).toBe("en");
		expect(sent[0].originLabel).toBe(`plugin:${PLUGIN_ID}`);

		// Queue record persisted in the team-scoped namespace.
		const task = readStored(`team.${teamAId}.tasks.1`);
		expect(task).toMatchObject({ id: "task-1", seq: 1, memberId: "n-worker", status: "sent" });
		expect(task.messageId).toBe("msg-1");

		// The task was mirrored into the member's Dynamic Spec queue
		// (spec://tasks.json) with the stable "[团队任务 task-N" match key.
		const workerSpec = specQueues.get("n-worker") ?? [];
		expect(workerSpec.some((entry) => entry.text.startsWith("[团队任务 task-1（normal）]"))).toBe(true);
		expect(workerSpec[0].text).toContain("review chapter 3 and report back");
	});

	test("team.dispatch advances task ids on every dispatch", async () => {
		// Previous dispatch test consumed task-1; this one must get task-2,
		// proving nextSeq advances instead of reusing the same id.
		const result = await invoke(
			"team.dispatch",
			{ teamId: teamAId, memberId: "n-worker", task: "another task" },
			"n-leader",
		);
		expect(JSON.parse(result.output).taskId).toBe("task-2");
	});

	test("team.dispatch rejects an unknown teamId", async () => {
		await expect(
			invoke("team.dispatch", { teamId: "team-nope", memberId: "n-worker", task: "x" }, "n-leader"),
		).rejects.toThrow(/Team not found/);
	});

	test("team.status with explicit teamId returns that team's queue", async () => {
		const view = JSON.parse((await invoke("team.status", { teamId: teamAId }, "n-leader")).output);
		expect(view.ok).toBe(true);
		expect(view.teams).toHaveLength(1);
		expect(view.teams[0].queue).toHaveLength(2);
		expect(view.teams[0].queue[0]).toMatchObject({ id: "task-2", status: "sent", memberId: "n-worker" });
	});

	test("team.setup adds a subagent member", async () => {
		const result = await invoke(
			"team.setup",
			{ teamId: teamAId, members: ["n-worker", "n-sub"] },
			"n-leader",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.ok).toBe(true);
		expect(output.members).toContain("n-sub");
	});

	test("team.dispatch to a subagent member delivers through the subagent channel", async () => {
		const result = await invoke(
			"team.dispatch",
			{ teamId: teamAId, memberId: "n-sub", task: "explore the plugin API and report" },
			"n-leader",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.teamId).toBe(teamAId);
		expect(output.status).toBe("sent");
		expect(output.taskId).toBe("task-3");

		// The subagent channel (not the primary send_message channel) got the
		// task prompt with the closing-the-loop hint appended.
		expect(subagentSent).toHaveLength(1);
		expect(subagentSent[0].subagentId).toBe("n-sub");
		expect(subagentSent[0].message).toContain("explore the plugin API and report");
		expect(subagentSent[0].message).toContain("[团队任务 task-3（normal）]");
		expect(sent).toHaveLength(2); // primary channel untouched by this dispatch

		const task = readStored(`team.${teamAId}.tasks.3`);
		expect(task).toMatchObject({ id: "task-3", seq: 3, memberId: "n-sub", status: "sent" });
		expect(task.messageId).toBe("smsg-1");
	});

	test("subagent delivery failure marks the task failed with the host reason", async () => {
		failSubagentDelivery = true;
		try {
			const result = await invoke(
				"team.dispatch",
				{ teamId: teamAId, memberId: "n-sub", task: "task that cannot be delivered" },
				"n-leader",
			);
			expect(result.error).toBeUndefined();
			const output = JSON.parse(result.output);
			expect(output.status).toBe("failed");
			expect(output.hint).toContain("subagent");

			const task = readStored(`team.${teamAId}.tasks.4`);
			expect(task.status).toBe("failed");
			expect(task.error).toContain("original Agent tool call");
		} finally {
			failSubagentDelivery = false;
		}
	});

	test("team.recruit creates a primary member when called by the leader", async () => {
		const result = await invoke(
			"team.recruit",
			{ teamId: teamAId, role: "member", title: "New Member" },
			"n-leader",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.ok).toBe(true);
		expect(output.role).toBe("member");
		expect(output.variant).toBe("primary");
		expect(createdNarrators).toHaveLength(1);
		expect(createdNarrators[0]).toMatchObject({ type: "primary", title: "New Member" });

		const config = readStored(`team.${teamAId}.config`);
		expect(config.members).toContain(output.memberId);
		expect(config.memberRoles[output.memberId]).toBeUndefined(); // regular member: no role marker
	});

	test("team.recruit rejects non-leaders recruiting regular members", async () => {
		const before = readStored(`team.${teamAId}.config`).members.length;
		await expect(
			invoke("team.recruit", { teamId: teamAId, role: "member" }, "n-worker"),
		).rejects.toThrow(/Only the team leader/);
		// Nothing was created or added.
		expect(createdNarrators.length).toBe(1);
		expect(readStored(`team.${teamAId}.config`).members.length).toBe(before);
	});

	test("team.recruit creates a temp subagent worker from a regular member", async () => {
		const result = await invoke(
			"team.recruit",
			{ teamId: teamAId, role: "temp", title: "Temp Explorer", subagentType: "explore" },
			"n-worker",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.ok).toBe(true);
		expect(output.role).toBe("temp");
		expect(output.variant).toBe("subagent:general");
		expect(createdNarrators).toHaveLength(2);
		expect(createdNarrators[1]).toMatchObject({
			type: "subagent",
			subagentType: "explore",
			parentNarratorId: "n-worker",
		});

		const config = readStored(`team.${teamAId}.config`);
		expect(config.members).toContain(output.memberId);
		expect(config.memberRoles[output.memberId]).toBe("temp");
		expect(config.recruitedBy[output.memberId]).toBe("n-worker");
	});

	test("team.dispatch to a freshly recruited temp worker delivers without prior parent startup", async () => {
		const tempId = createdNarrators[1].id;
		const result = await invoke(
			"team.dispatch",
			{ teamId: teamAId, memberId: tempId, task: "survey the codebase and report" },
			"n-leader",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.status).toBe("sent");
		expect(output.taskId).toBe("task-5");

		// Delivered through the subagent channel; the fake host accepts it even
		// though the subagent was never started by a parent Agent tool call.
		expect(subagentSent).toHaveLength(2);
		expect(subagentSent[1].subagentId).toBe(tempId);
		expect(subagentSent[1].message).toContain("[团队协作准则 · 临时工]"); // temp role SOP appended
		const task = readStored(`team.${teamAId}.tasks.5`);
		expect(task).toMatchObject({ id: "task-5", seq: 5, memberId: tempId, status: "sent" });
	});

	test("team.fire removes a temp worker and deletes its narrator", async () => {
		const tempId = createdNarrators[1].id;
		const result = await invoke(
			"team.fire",
			{ teamId: teamAId, memberId: tempId },
			"n-worker", // the recruiter may fire the temp worker
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.ok).toBe(true);
		expect(output.role).toBe("temp");
		expect(output.deleted).toBe(true);
		expect(deletedNarrators).toContain(tempId);

		const config = readStored(`team.${teamAId}.config`);
		expect(config.members).not.toContain(tempId);
		expect(config.memberRoles[tempId]).toBeUndefined();
		expect(config.recruitedBy[tempId]).toBeUndefined();
	});

	test("team.fire rejects firing a regular member by a non-leader", async () => {
		const memberId = createdNarrators[0].id; // recruited by the leader
		await expect(
			invoke("team.fire", { teamId: teamAId, memberId }, "n-worker"),
		).rejects.toThrow(/Only the team leader/);
	});

	test("team.fire retires the fired member's queued/sent tasks as failed", async () => {
		// task-5 targeted the temp worker that was fired above. Auto-maintenance
		// inside team.fire must retire its active task (member no longer in
		// team) so it can never be delivered again.
		const task5 = readStored(`team.${teamAId}.tasks.5`);
		expect(task5.status).toBe("failed");
		expect(task5.error).toBe("member no longer in team");
	});

	test("team.status closes a task when the member marks it done in their spec queue", async () => {
		// The member completes task-5 in their own spec://tasks.json.
		const tempId = createdNarrators[1].id; // fired earlier — its queue is gone
		// Use task-2 (n-worker) instead: mark its spec entry done.
		const workerQueue = specQueues.get("n-worker") ?? [];
		const task2 = workerQueue.find((entry) => entry.text.startsWith("[团队任务 task-2"));
		expect(task2).toBeDefined();
		task2.status = "done";

		const view = JSON.parse((await invoke("team.status", { teamId: teamAId }, "n-leader")).output);
		const task2Record = readStored(`team.${teamAId}.tasks.2`);
		expect(task2Record.status).toBe("done");
		expect(view.teams[0].queue.find((t) => t.id === "task-2").status).toBe("done");
	});

	test("team.status marks a task failed when the member blocks it in their spec queue", async () => {
		// task-3 targets n-sub; mark its spec entry blocked → failed.
		const subQueue = specQueues.get("n-sub") ?? [];
		const task3 = subQueue.find((entry) => entry.text.startsWith("[团队任务 task-3"));
		expect(task3).toBeDefined();
		task3.status = "blocked";

		await invoke("team.status", { teamId: teamAId }, "n-leader");
		const task3Record = readStored(`team.${teamAId}.tasks.3`);
		expect(task3Record.status).toBe("failed");
	});

	test("team.update_member lets the leader change a member's profile", async () => {
		const result = await invoke(
			"team.update_member",
			{
				teamId: teamAId,
				memberId: "n-worker",
				title: "Worker Prime",
				model: "claude-sonnet-4.5",
				reasoningEffort: "high",
			},
			"n-leader",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.ok).toBe(true);
		expect(output.memberId).toBe("n-worker");
		expect(output.updated.sort()).toEqual(["model", "reasoningEffort", "title"]);

		// Persisted through the host's narrator adapter (fake session → DB).
		const row = db.select().from(narrators).where(eq(narrators.id, "n-worker")).get();
		expect(row?.title).toBe("Worker Prime");
		expect(row?.model).toBe("claude-sonnet-4.5");
		expect(row?.reasoningEffort).toBe("high");
	});

	test("team.update_member rejects a non-leader updating another member", async () => {
		// n-worker is a teamA member but not the leader; it may only update temp
		// workers it recruited, never the leader or other regular members.
		await expect(
			invoke(
				"team.update_member",
				{ teamId: teamAId, memberId: "n-leader", title: "Hijacked" },
				"n-worker",
			),
		).rejects.toThrow(/Only the team leader/);
	});

	test("team.update_member writes a whitelisted spec file", async () => {
		const result = await invoke(
			"team.update_member",
			{
				teamId: teamAId,
				memberId: "n-worker",
				spec: { uri: "index.md", content: "# Updated index" },
			},
			"n-leader",
		);
		expect(result.error).toBeUndefined();
		const output = JSON.parse(result.output);
		expect(output.spec).toEqual({ uri: "index.md", revisionId: "r-spec-1" });
		expect(specQueues.get("spec-file:n-worker:index.md")).toBe("# Updated index");
	});

	test("team.update_member rejects a non-whitelisted spec uri", async () => {
		await expect(
			invoke(
				"team.update_member",
				{
					teamId: teamAId,
					memberId: "n-worker",
					spec: { uri: "behavior_fence", content: "x" },
				},
				"n-leader",
			),
		).rejects.toThrow(/spec.uri must be one of/);
	});

	test("host-deleted members retire orphan tasks and cannot receive new dispatches", async () => {
		const beforeSent = sent.length;
		const beforeSubagentSent = subagentSent.length;
		const result = await invoke(
			"team.dispatch",
			{ teamId: teamAId, memberId: "n-worker", task: "queued before host deletion" },
			"n-leader",
		);
		expect(result.error).toBeUndefined();
		expect(JSON.parse(result.output).status).toBe("sent");
		const task6 = readStored(`team.${teamAId}.tasks.6`);
		expect(task6).toMatchObject({ memberId: "n-worker", status: "sent" });
		expect(sent.length).toBe(beforeSent + 1);
		expect(subagentSent.length).toBe(beforeSubagentSent);

		// Simulate host-side deletion without changing the persisted team config.
		// This mirrors narratorService.remove's FK cleanup, while deliberately
		// bypassing the plugin's team.fire path.
		const workerMessageIds = db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, "n-worker"))
			.all()
			.map((row) => row.id);
		db.delete(terminalViewState).where(eq(terminalViewState.narratorId, "n-worker")).run();
		db.delete(terminalTabs).where(eq(terminalTabs.narratorId, "n-worker")).run();
		db.delete(terminals).where(eq(terminals.narratorId, "n-worker")).run();
		db.delete(narratorBufferedMessages).where(eq(narratorBufferedMessages.narratorId, "n-worker")).run();
		db.delete(narratorFileSnapshots).where(eq(narratorFileSnapshots.narratorId, "n-worker")).run();
		db.delete(narratorPatches).where(eq(narratorPatches.narratorId, "n-worker")).run();
		db.delete(narratorWhitelistDirs).where(eq(narratorWhitelistDirs.narratorId, "n-worker")).run();
		db.delete(narratorBlacklistDirs).where(eq(narratorBlacklistDirs.narratorId, "n-worker")).run();
		db.delete(narratorWhitelistCmds).where(eq(narratorWhitelistCmds.narratorId, "n-worker")).run();
		db.delete(narratorBlacklistCmds).where(eq(narratorBlacklistCmds.narratorId, "n-worker")).run();
		db.delete(apiRequests).where(eq(apiRequests.narratorId, "n-worker")).run();
		db.update(chapterCommits).set({ narratorId: null }).where(eq(chapterCommits.narratorId, "n-worker")).run();
		db.update(benchmarkTaskResults).set({ narratorId: null }).where(eq(benchmarkTaskResults.narratorId, "n-worker")).run();
		db.update(fileAttributions).set({ narratorId: null }).where(eq(fileAttributions.narratorId, "n-worker")).run();
		db.delete(gatewaySessionMappings).where(eq(gatewaySessionMappings.narratorId, "n-worker")).run();
		db.delete(backgroundTasks).where(eq(backgroundTasks.subagentNarratorId, "n-worker")).run();
		db.delete(backgroundTasks).where(eq(backgroundTasks.parentNarratorId, "n-worker")).run();
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, "n-worker")).run();
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, "n-worker")).run();
		if (workerMessageIds.length > 0) {
			db.update(narrators).set({ forkMessageId: null, pruneBoundaryMessageId: null }).where(eq(narrators.id, "n-worker")).run();
			db.delete(narratorSidecars).where(eq(narratorSidecars.narratorId, "n-worker")).run();
			db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, "n-worker")).run();
			db.delete(narratorMessages).where(eq(narratorMessages.narratorId, "n-worker")).run();
		}
		db.delete(narrators).where(eq(narrators.id, "n-worker")).run();

		const status = JSON.parse((await invoke("team.status", { teamId: teamAId }, "n-leader")).output);
		const task6Record = readStored(`team.${teamAId}.tasks.6`);
		expect(task6Record).toMatchObject({
			status: "failed",
			error: "member narrator no longer exists",
		});
		expect(status.teams[0].members.find((member) => member.id === "n-worker")).toMatchObject({
			id: "n-worker",
			status: "missing",
		});

		const dispatchRequest = invoke(
			"team.dispatch",
			{ teamId: teamAId, memberId: "n-worker", task: "must not be delivered" },
			"n-leader",
		);
		await expect(dispatchRequest).rejects.toThrow(/Member narrator no longer exists/);
		expect(sent.length).toBe(beforeSent + 1);
		expect(subagentSent.length).toBe(beforeSubagentSent);
		const queue = JSON.parse((await invoke("team.status", { teamId: teamAId }, "n-leader")).output).teams[0].queue;
		expect(queue.some((task) => task.memberId === "n-worker" && task.status === "queued")).toBe(false);
	});
});
