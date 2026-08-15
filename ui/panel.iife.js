/**
 * narrator-team panel UI.
 *
 * Runs inside the host-controlled sandbox iframe: `connect-src 'none'`, so the
 * only way to touch the host is `globalThis.narrafork.request(method, params)`
 * (context.get / queries.execute / commands.execute / storage.*). Plain DOM,
 * no framework — the host's React/Mantine are not available in the iframe.
 *
 * Multi-team model: the panel shows only the teams the CURRENT narrator (the
 * one whose chat page the panel is attached to) belongs to — as member or
 * leader. Members are clickable and jump to their narrator chat page via the
 * host-local `ui.navigate` bridge.
 */

(() => {
	const sdk = globalThis.narrafork;
	const root = document.body;

	const REQUEST_TIMEOUT_MS = 10_000;

	/** Wrap a host request with a timeout so a stuck bridge never hangs the UI. */
	function request(method, params) {
		return Promise.race([
			sdk.request(method, params),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error(`${method} timed out`)), REQUEST_TIMEOUT_MS),
			),
		]);
	}

	const STATUS_LABEL = {
		idle: "idle",
		working: "working",
		waiting: "waiting",
		archived: "archived",
		missing: "missing",
	};
		// ------------------------------------------------------------------ state
	const state = {
		narrators: [],
		currentNarratorId: null,
		teams: [],
		activeTeamId: null,
		busy: false,
		// True while the very first data load is in flight; renders a neutral
		// "加载中" skeleton instead of the misleading "no team" empty states.
		loading: true,
		notice: null,
		pickerOpen: false,
		pickerSelected: [],
		pickerLeader: null,
		messageTarget: null,
		// Member profile editor: { teamId, memberId, name } when open.
		editTarget: null,
		// Task deletion confirm: { team, task } when open. Uses an in-panel DOM
		// modal because the plugin iframe runs sandbox="allow-scripts" only, and
		// window.confirm() is silently rejected without allow-modals.
		deleteTarget: null,
	};

	// The last successfully loaded view is persisted under the plugin's own
	// storage so the next open paints instantly from cache, then refreshes
	// in place — no blank frame, no "no team" flash before the data arrives.
	const VIEW_CACHE_KEY = "ui.panel.cache.v1";
	let lastCacheSaveAt = 0;

	/** Relative time for the "last activity" hint (progress alignment). */
	function timeAgo(iso) {
		if (!iso) return "—";
		const ms = Date.now() - new Date(iso).getTime();
		if (!Number.isFinite(ms) || ms < 0) return "—";
		const minutes = Math.floor(ms / 60000);
		if (minutes < 1) return "刚刚";
		if (minutes < 60) return `${minutes} 分钟前`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours} 小时前`;
		return `${Math.floor(hours / 24)} 天前`;
	}

	// The host's storage.get returns an entry envelope ({key, value, revision,
	// ...}); callers want the stored VALUE. Unwrap it so config/task parsing
	// sees the actual object (name/leader/members live inside entry.value).
	async function storageGet(key) {
		const entry = 			await request("storage.get", { scope: { type: "global" }, key });
		return entry && typeof entry === "object" ? entry.value : entry;
	}

	async function storageList(prefix) {
		const result = 			await request("storage.list", { scope: { type: "global" }, prefix });
		return result && typeof result === "object" && Array.isArray(result.items) ? result.items : [];
	}

	function el(tag, props = {}, children = []) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(props)) {
			if (key === "class") node.className = value;
			else if (key === "text") node.textContent = value;
			else if (key.startsWith("on") && typeof value === "function") {
				node.addEventListener(key.slice(2).toLowerCase(), value);
			} else if (value !== undefined && value !== null) {
				node.setAttribute(key, String(value));
			}
		}
		for (const child of [].concat(children)) {
			if (child === null || child === undefined) continue;
			node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
		}
		return node;
	}

	function section(title, body) {
		return el("section", { class: "nt-section" }, [
			el("h2", { class: "nt-title", text: title }),
			body,
		]);
	}

	function teamConfigKey(teamId) {
		return `team.${teamId}.config`;
	}
	function teamTasksIndexKey(teamId) {
		return `team.${teamId}.tasks.index`;
	}
	function teamTaskKey(teamId, seq) {
		return `team.${teamId}.tasks.${seq}`;
	}
	function teamIdFromKey(key, prefix) {
		if (typeof key !== "string" || !key.startsWith(prefix) || !key.endsWith(".config")) return null;
		return key.slice(prefix.length, -".config".length);
	}

	function narratorInTeam(team, narratorId) {
		if (!team || !narratorId) return false;
		return team.leaderId === narratorId || (Array.isArray(team.members) && team.members.includes(narratorId));
	}

	function parseTeam(raw, teamId) {
		if (typeof raw !== "object" || raw === null) {
			return { id: teamId, name: "", leaderId: null, members: [], memberRoles: {}, createdAt: null, updatedAt: null };
		}
		const members = Array.isArray(raw.members) ? raw.members.filter((m) => typeof m === "string") : [];
		const memberRoles = {};
		if (raw.memberRoles && typeof raw.memberRoles === "object") {
			for (const [id, role] of Object.entries(raw.memberRoles)) {
				if (members.includes(id) && (role === "member" || role === "temp")) memberRoles[id] = role;
			}
		}
		return {
			id: typeof raw.id === "string" && raw.id ? raw.id : teamId,
			name: typeof raw.name === "string" ? raw.name : "",
			leaderId: typeof raw.leaderId === "string" ? raw.leaderId : null,
			members,
			memberRoles,
			createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
		};
	}

	// ---------------------------------------------------------------- loading
	async function loadNarrators() {
		const result = 			await request("queries.execute", {
			queryId: "narrafork.narrators.list",
			input: { limit: 100, status: ["idle", "working", "waiting"] },
		});
		if (!result || typeof result !== "object" || result.status !== "succeeded") {
			throw new Error(result?.error?.message ?? "Failed to load narrators");
		}
		state.narrators = result.data?.items ?? [];
	}

	async function loadCurrentNarrator() {
		try {
			const panelState = await request("panel.getState");
			state.debugPanelState = panelState;
			const binding = panelState && typeof panelState === "object" ? panelState.binding : null;
			// Derive narratorId from the panel binding:
			// - workspace-narrator: binding.ownerNarratorId
			// - focus-current-narrator: need context.get (focus page only)
			if (binding && typeof binding === "object") {
				if (binding.kind === "workspace-narrator" && typeof binding.ownerNarratorId === "string") {
					state.currentNarratorId = binding.ownerNarratorId;
				} else if (binding.kind === "focus-current-narrator") {
					// The binding carries the narrator it was opened for (host >= fix14);
					// fall back to context.get on older hosts.
					if (typeof binding.narratorId === "string" && binding.narratorId) {
						state.currentNarratorId = binding.narratorId;
					} else {
						try {
							const ctx = await request("context.get");
							state.currentNarratorId =
								ctx && typeof ctx === "object" && ctx.narrator && typeof ctx.narrator.id === "string"
									? ctx.narrator.id
									: null;
						} catch {
							state.currentNarratorId = null;
						}
					}
				} else {
					state.currentNarratorId = null;
				}
			} else {
				state.currentNarratorId = null;
			}
			state.surfaceKind = binding?.kind ?? null;
		} catch (error) {
			state.debugPanelState = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
			state.currentNarratorId = null;
			state.surfaceKind = null;
		}
	}

	async function loadTeamTasks(teamId) {
		const index = await storageGet(teamTasksIndexKey(teamId));
		const ids = index && Array.isArray(index.ids) ? index.ids.slice(0, 20) : [];
		const tasks = await Promise.all(
			ids.map(async (id) => {
				const seq = Number(String(id).replace(/^task-/, ""));
				if (!Number.isInteger(seq)) return null;
				try {
					const task = await storageGet(teamTaskKey(teamId, seq));
					return task && typeof task === "object" ? task : null;
				} catch {
					return null;
				}
			}),
		);
		return tasks.filter(Boolean);
	}

	/**
	 * UI-side one-time migration of the legacy single-team layout.
	 *
	 * The old plugin stored everything under `team.config` / `tasks.index` /
	 * `tasks.<id>`. The multi-team layout uses `team.<id>.config` +
	 * `team.<id>.tasks.*`, which is what this panel enumerates. Migration is
	 * normally done lazily by the plugin backend on the first team operation,
	 * but a panel that only talks to storage would never trigger it — so the
	 * panel performs the same fold itself (idempotent, legacy keys kept).
	 */
	async function ensureTeamsMigrated() {
		const entries = await storageList("team.");
		if (entries.length > 0) return; // already migrated
		const legacy = await storageGet("team.config");
		if (legacy === null || legacy === undefined) return; // nothing to migrate
		const team = {
			id: "default",
			name: typeof legacy.name === "string" ? legacy.name : "",
			leaderId: typeof legacy.leaderId === "string" ? legacy.leaderId : null,
			members: Array.isArray(legacy.members)
				? legacy.members.filter((member) => typeof member === "string")
				: [],
			createdAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : null,
			updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : null,
		};
		await request("storage.set", { scope: { type: "global" }, key: "team.default.config", value: team });
		// Fold the legacy task queue into the team namespace.
		const legacyIndex = await storageGet("tasks.index");
		if (legacyIndex && typeof legacyIndex === "object" && Array.isArray(legacyIndex.ids)) {
			for (const taskId of legacyIndex.ids) {
				const task = await storageGet(`tasks.${taskId}`);
				if (task && typeof task === "object" && typeof task.seq === "number") {
					await request("storage.set", {
						scope: { type: "global" },
						key: teamTaskKey("default", task.seq),
						value: task,
					});
				}
			}
			await request("storage.set", {
				scope: { type: "global" },
				key: "team.default.tasks.index",
				value: {
					nextSeq:
						typeof legacyIndex.nextSeq === "number" && legacyIndex.nextSeq > 0
							? legacyIndex.nextSeq
							: 1,
					ids: legacyIndex.ids.slice(0, 200),
				},
			});
		}
	}

	/** Load every team the current narrator belongs to (member or leader). */
	async function loadTeams() {
		await ensureTeamsMigrated();
		const entries = await storageList("team.");
		// TEMP diagnostic: remember how many teams exist regardless of filtering.
		state.debugAllTeams = entries.length;
		const teamIds = Array.from(
			new Set(entries.map((entry) => teamIdFromKey(entry?.key, "team.")).filter(Boolean)),
		);
		const teams = [];
		for (const teamId of teamIds) {
			const raw = await storageGet(teamConfigKey(teamId));
			if (raw === null || raw === undefined) continue;
			const team = parseTeam(raw, teamId);
			if (!narratorInTeam(team, state.currentNarratorId)) continue;
			team.tasks = await loadTeamTasks(teamId);
			teams.push(team);
		}
		state.teams = teams;
		// Collaboration visibility: attach each member's latest assistant reply
		// (read directly from the host, same source as the backend status view)
		// so the leader sees real progress without opening the chat page.
		await attachRecentReplies(state.teams);
		// Keep the edit form anchored to a stable team (prefer the first one).
		if (!teams.some((team) => team.id === state.activeTeamId)) {
			state.activeTeamId = teams[0]?.id ?? null;
		}
	}

	/** Attach recentReply to every team member (best-effort; never blocks). */
	async function attachRecentReplies(teams) {
		for (const team of teams) {
			team.replies = {};
			const ids = new Set([...(team.leaderId ? [team.leaderId] : []), ...(team.members ?? [])]);
			for (const id of ids) {
				try {
					const result = await request("queries.execute", {
						queryId: "narrafork.narrator.messages.list",
						input: { narratorId: id, limit: 10 },
					});
					const items =
						result && typeof result === "object" && result.status === "succeeded"
							? result.data?.items ?? []
							: [];
					const reply = summarizeReplies(items);
					if (reply) team.replies[id] = reply;
				} catch {
					// a message read failure must not block the panel
				}
			}
		}
	}

	/** Newest assistant text from a message list (mirrors the backend helper). */
	function summarizeReplies(messages) {
		for (const item of messages ?? []) {
			if (item && item.role === "assistant" && typeof item.text === "string" && item.text.trim()) {
				const text = item.text.trim();
				return text.length > 300 ? `${text.slice(0, 300)}…` : text;
			}
		}
		return null;
	}

	/** Persist the current view for an instant first paint next time (throttled). */
	async function saveViewCache() {
		if (!state.currentNarratorId) return;
		const now = Date.now();
		if (now - lastCacheSaveAt < 3_000) return; // throttle bursty event refreshes
		lastCacheSaveAt = now;
		try {
			await request("storage.set", {
				scope: { type: "global" },
				key: VIEW_CACHE_KEY,
				value: {
					version: 1,
					savedAt: new Date().toISOString(),
					currentNarratorId: state.currentNarratorId,
					activeTeamId: state.activeTeamId ?? null,
					teams: state.teams.map((team) => ({
						...team,
						tasks: team.tasks ?? [],
					})),
					narrators: state.narrators,
				},
			});
		} catch {
			// cache is best-effort
		}
	}

	/** Restore the cached view so the panel paints without a blank/empty frame. */
	async function restoreViewCache() {
		try {
			const entry = await storageGet(VIEW_CACHE_KEY);
			const payload = entry && typeof entry === "object" && entry.version === 1 ? entry : null;
			if (!payload) return false;
			if (typeof payload.currentNarratorId === "string") {
				state.currentNarratorId = payload.currentNarratorId;
			}
			if (typeof payload.activeTeamId === "string") {
				state.activeTeamId = payload.activeTeamId;
			}
			if (Array.isArray(payload.narrators)) state.narrators = payload.narrators;
			if (Array.isArray(payload.teams)) state.teams = payload.teams;
			return state.teams.length > 0;
		} catch {
			return false;
		}
	}

	async function refresh() {
		if (state.busy) return;
		state.busy = true;
		state.notice = null;
		try {
			await loadNarrators();
			const previousCurrent = state.currentNarratorId;
			await loadCurrentNarrator();
			// The live narrator probe can come back empty during the bridge
			// handshake window. Keep a previously known binding (e.g. restored
			// from cache) so we never flash the "open in a narrator page"
			// placeholder over a perfectly valid cached view.
			if (!state.currentNarratorId && previousCurrent && state.teams.length > 0) {
				state.currentNarratorId = previousCurrent;
			}
			await loadTeams();
			state.loading = false;
		} catch (error) {
			state.notice = `加载失败：${error instanceof Error ? error.message : String(error)}`;
		} finally {
			state.busy = false;
			render();
			saveViewCache();
			// Keep the live event subscription aligned with the current teams.
			setupEventSubscription();
		}
	}

	// -------------------------------------------------- live refresh (events)
	// The panel subscribes to host events for the narrators it displays (team
	// members + leader) and re-renders whenever something relevant changes:
	// status transitions (working→idle), new messages, or spec queue edits —
	// so the panel always shows the latest data without a manual refresh.
	const EVENT_TOPICS = [
		"narrafork.narrator.lifecycle",
		"narrafork.narrator.message.changed",
		"narrafork.narrator.spec.changed",
	];
	const EVENT_POLL_INTERVAL_MS = 3_000;
	let eventSubscriptionId = null;
	let eventPollTimer = null;
	let eventPollInFlight = false;
	let lastSubscribedIds = null;
	let refreshTimer = null;

	/** Narrator ids relevant to the panel (every team the current narrator belongs to). */
	function teamMemberIds() {
		const ids = new Set();
		for (const team of state.teams) {
			if (team.leaderId) ids.add(team.leaderId);
			for (const member of team.members) ids.add(member);
		}
		return [...ids];
	}

	/** (Re)subscribe when the team roster changed; best-effort. */
	async function setupEventSubscription() {
		const memberIds = teamMemberIds();
		if (memberIds.length === 0) {
			teardownEventSubscription();
			return;
		}
		const key = memberIds.slice().sort().join(",");
		if (eventSubscriptionId && key === lastSubscribedIds) return;
		lastSubscribedIds = key;
		try {
			if (eventSubscriptionId) {
				await request("events.unsubscribe", { subscriptionId: eventSubscriptionId }).catch(
					() => undefined,
				);
				eventSubscriptionId = null;
			}
			const result = await request("events.subscribe", {
				topics: EVENT_TOPICS,
				filter: { narratorIds: memberIds },
				mode: "live",
				delivery: {
					transport: "poll",
					maxRatePerSecond: 10,
					queueEvents: 100,
					queueBytes: 256 * 1024,
				},
			});
			eventSubscriptionId =
				result && typeof result === "object" && typeof result.subscriptionId === "string"
					? result.subscriptionId
					: null;
			if (eventSubscriptionId && !eventPollTimer) {
				eventPollTimer = setInterval(pollEvents, EVENT_POLL_INTERVAL_MS);
			}
		} catch {
			// subscription is best-effort; the manual refresh button stays available
		}
	}

	function teardownEventSubscription() {
		if (eventPollTimer) {
			clearInterval(eventPollTimer);
			eventPollTimer = null;
		}
		if (eventSubscriptionId) {
			request("events.unsubscribe", { subscriptionId: eventSubscriptionId }).catch(() => undefined);
			eventSubscriptionId = null;
		}
		lastSubscribedIds = null;
	}

	async function pollEvents() {
		if (!eventSubscriptionId || eventPollInFlight) return;
		eventPollInFlight = true;
		try {
			const result = await request("events.poll", {
				subscriptionId: eventSubscriptionId,
				limit: 100,
			});
			const events = result && Array.isArray(result.events) ? result.events : [];
			if (events.length > 0) scheduleRefresh();
		} catch {
			// transient poll failure: try again next tick
		} finally {
			eventPollInFlight = false;
		}
	}

	/** Debounced refresh so a burst of events renders exactly once. */
	function scheduleRefresh() {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refresh();
		}, 500);
	}

	// ---------------------------------------------------------------- actions
	function activeTeam() {
		return state.teams.find((team) => team.id === state.activeTeamId) ?? null;
	}

	async function saveTeamConfig(name, leaderId, members) {
		const team = activeTeam();
		if (!team) return;
		state.busy = true;
		try {
			const next = {
				...team,
				name,
				leaderId: leaderId || null,
				members,
				updatedAt: new Date().toISOString(),
			};
			delete next.tasks;
			await request("storage.set", { scope: { type: "global" }, key: teamConfigKey(team.id), value: next });
			state.notice = "团队配置已保存";
		} catch (error) {
			state.notice = `保存失败：${error instanceof Error ? error.message : String(error)}`;
		} finally {
			state.busy = false;
			await refresh();
		}
	}

	async function interrupt(memberId) {
		state.busy = true;
		try {
			const result = 			await request("commands.execute", {
				commandId: "narrafork.narrator.interrupt",
				input: { narratorId: memberId },
			});
			const interrupted =
				result && typeof result === "object" && result.status === "succeeded"
					? result.data?.interrupted
					: false;
			state.notice = interrupted ? `已中断 ${memberId}` : `${memberId} 没有运行中的任务`;
		} catch (error) {
			state.notice = `中断失败：${error instanceof Error ? error.message : String(error)}`;
		} finally {
			state.busy = false;
			await refresh();
		}
	}

	/** Jump to a narrator's chat page via the host-local navigation bridge. */
	function openNarrator(narratorId) {
		request("ui.navigate", { to: `/narrators/${encodeURIComponent(narratorId)}` }).catch((error) => {
			state.notice = `无法跳转：${error instanceof Error ? error.message : String(error)}`;
			render();
		});
	}

	/** Send a direct message to a narrator via the host public API. */
	async function sendMessageTo(narratorId, message) {
		const result = 			await request("commands.execute", {
			commandId: "narrafork.narrator.send_message",
			input: { narratorId, message },
		});
		if (result && typeof result === "object" && result.status === "failed") {
			throw new Error(result.error?.message ?? "send failed");
		}
		return result;
	}

	function closeMessageModal() {
		state.messageTarget = null;
		render();
	}

	function renderMessageModal() {
		const target = state.messageTarget;
		if (!target) return null;
		const input = el("textarea", { rows: 3, placeholder: `给 ${target.name} 的消息…` });
		const send = el("button", {
			class: "nt-btn",
			text: "发送",
			onclick: async () => {
				const text = input.value.trim();
				if (!text) return;
				send.disabled = true;
				try {
					await sendMessageTo(target.narratorId, text);
					state.messageTarget = null;
					state.notice = `已发送给 ${target.name}`;
				} catch (error) {
					state.notice = `发送失败：${error instanceof Error ? error.message : String(error)}`;
				}
				render();
			},
		});
		return el("div", {
			class: "nt-modal-overlay",
			onclick: (e) => { if (e.target === e.currentTarget) closeMessageModal(); },
		}, [
			el("div", { class: "nt-modal nt-modal-narrow" }, [
				el("div", { class: "nt-modal-header" }, [
					el("h3", { text: `发消息给 ${target.name}` }),
					el("button", { class: "nt-modal-close", text: "✕", onclick: closeMessageModal }),
				]),
				el("div", { class: "nt-modal-list" }, [input]),
				el("div", { class: "nt-modal-footer" }, [
					el("button", { class: "nt-btn nt-btn-outline", text: "取消", onclick: closeMessageModal }),
					send,
				]),
			]),
		]);
	}

	function narratorLabel(narrator) {
		return narrator.title || narrator.handle || narrator.id;
	}

	// ------------------------------------------------------------------ render
	function renderTeamSwitcher() {
		if (state.teams.length <= 1) return null;
		const options = state.teams.map((team) => {
			const option = el("option", { value: team.id, text: `${team.name || "(unnamed)"}（${team.id}）` });
			if (team.id === state.activeTeamId) option.selected = true;
			return option;
		});
		const select = el("select", { class: "nt-team-switch", onchange: (e) => {
			state.activeTeamId = e.target.value;
			render();
		} });
		for (const option of options) select.appendChild(option);
		return el("div", { class: "nt-form" }, [el("label", { text: "编辑团队" }), select]);
	}

	let autoSaveTimer = null;

	/** Debounced auto-save for the team config form (name / leader changes). */
	function scheduleAutoSave(patch) {
		const team = activeTeam();
		if (!team) return;
		clearTimeout(autoSaveTimer);
		autoSaveTimer = setTimeout(async () => {
			const next = { ...team, ...patch, updatedAt: new Date().toISOString() };
			delete next.tasks;
			try {
				await request("storage.set", { scope: { type: "global" }, key: teamConfigKey(team.id), value: next });
				// Update local state in place so the form keeps focus; no full refresh.
				const idx = state.teams.findIndex((t) => t.id === team.id);
				if (idx >= 0) state.teams[idx] = { ...state.teams[idx], ...patch, updatedAt: next.updatedAt };
			} catch (error) {
				state.notice = `自动保存失败：${error instanceof Error ? error.message : String(error)}`;
				render();
			}
		}, 600);
	}

	function renderConfigForm() {
		const team = activeTeam();
		if (!team) return null;
		const nameInput = el("input", {
			type: "text",
			value: team.name,
			placeholder: "团队名称",
			oninput: (e) => scheduleAutoSave({ name: e.target.value.trim() }),
		});
		const leaderSelect = el("select", {
			onchange: (e) => scheduleAutoSave({ leaderId: e.target.value || null }),
		});
		leaderSelect.appendChild(el("option", { value: "", text: "（无 Leader）" }));
		for (const narrator of state.narrators) {
			const option = el("option", {
				value: narrator.id,
				text: `${narratorLabel(narrator)}（${narrator.id}）`,
			});
			if (narrator.id === team.leaderId) option.selected = true;
			leaderSelect.appendChild(option);
		}

		return section("团队配置", el("div", { class: "nt-form" }, [
			el("label", { text: "名称" }), nameInput,
			el("label", { text: "Leader" }), leaderSelect,
			el("span", { class: "nt-empty", text: "名称与 Leader 修改后自动保存" }),
		]));
	}

	function renderMemberChips(team) {
		const byId = new Map(state.narrators.map((narrator) => [narrator.id, narrator]));
		const ids = [
			...(team.leaderId ? [team.leaderId] : []),
			...team.members.filter((id) => id !== team.leaderId),
		];
		if (ids.length === 0) return el("p", { class: "nt-empty", text: "尚未配置成员" });
		const chips = ids.map((id) => {
			const narrator = byId.get(id) ?? { id, status: "missing" };
			const isLeader = id === team.leaderId;
			// The primary accent marks the CURRENT narrator (whose chat page the
			// panel is attached to); the leader is only identified by its pill.
			const isCurrent = id === state.currentNarratorId;
			const role = isLeader
				? "Leader"
				: team.memberRoles && team.memberRoles[id] === "temp"
					? "Temp"
					: "Member";
			const status = narrator.status ?? "missing";
			const accent = PICKER_STATUS[status] ?? PICKER_STATUS.idle;
			const label = narratorLabel(narrator);
			return el("div", {
				class: `nt-chip${isCurrent ? " nt-chip-current" : ""}`,
			}, [
				// Clickable body: open the narrator's chat page.
				el("button", {
					class: "nt-chip-body",
					title: `打开 ${label} 的聊天页`,
					onclick: () => openNarrator(id),
				}, [
					el("span", {
						class: "nt-chip-status",
						style: `background: var(--mantine-color-${accent.color}-${accent.shade})`,
						text: STATUS_LABEL[status] ?? status,
					}),
				el("span", { class: "nt-chip-main" }, [
					el("span", { class: "nt-chip-title", text: label }),
					el("span", {
						class: "nt-chip-meta",
						text: `${narrator.model ?? "default model"} · ${narrator.messageCount ?? 0} msgs · 最近 ${timeAgo(narrator.lastMessageAt)}`,
					}),
					// Collaboration visibility: the member's latest reply, shown
					// inline so the leader sees real progress without opening the
					// chat page. `team.replies[id]` is filled by attachRecentReplies.
					...(team.replies && typeof team.replies[id] === "string" && team.replies[id]
						? [
								el("span", {
									class: "nt-chip-reply",
									title: "最近回复",
									text: `↳ ${team.replies[id]}`,
								}),
							]
						: []),
				]),
				]),
				el("span", { class: `nt-chip-role${isLeader ? " nt-chip-role-leader" : ""}`, text: role }),
				// Interrupt a working member (host command.narrator.interrupt).
				el("button", {
					class: "nt-chip-icon",
					title: `中断 ${label} 的当前工作`,
					onclick: () => interrupt(id),
				}, "⏹"),
				// Message the member from the panel.
				el("button", {
					class: "nt-chip-icon",
					title: `给 ${label} 发消息`,
					onclick: () => {
						state.messageTarget = { narratorId: id, name: label };
						render();
					},
				}, "✉"),
				// Edit the member's profile (title / model / reasoning effort).
				// Visible for the leader (any member) or the recruiter of a temp.
				...(canEditMember(team, id)
					? [
							el("button", {
								class: "nt-chip-icon",
								title: `编辑 ${label} 的资料`,
								onclick: () => {
									state.editTarget = { teamId: team.id, memberId: id, name: label };
									render();
								},
							}, "✎"),
						]
					: []),
				// Jump to the member's chat page.
				el("button", {
					class: "nt-chip-icon",
					title: `打开 ${label} 的聊天页`,
					onclick: () => openNarrator(id),
				}, "↗"),
			]);
		});
		return el("div", { class: "nt-cards" }, chips);
	}

	/**
	 * Whether the current narrator may edit a member's profile: the team leader
	 * can edit anyone; a non-leader member may only edit temp workers they
	 * recruited (mirrors the backend team.update_member authorization).
	 */
	function canEditMember(team, memberId) {
		const current = state.currentNarratorId;
		if (!current) return false;
		if (team.leaderId === current) return true;
		const role = team.memberRoles && team.memberRoles[memberId] === "temp" ? "temp" : "member";
		return role === "temp" && team.recruitedBy && team.recruitedBy[memberId] === current;
	}

	function closeEditMember() {
		state.editTarget = null;
		render();
	}

	/** Save a member's profile through the host update_profile command. */
	async function saveMemberProfile(teamId, memberId, patch) {
		state.busy = true;
		try {
			const result = await request("commands.execute", {
				commandId: "narrafork.narrator.update_profile",
				input: { narratorId: memberId, ...patch },
			});
			if (result && typeof result === "object" && result.status === "failed") {
				throw new Error(result.error?.message ?? "update failed");
			}
			state.notice = "成员资料已保存";
			state.editTarget = null;
		} catch (error) {
			state.notice = `保存失败：${error instanceof Error ? error.message : String(error)}`;
		} finally {
			state.busy = false;
			await refresh();
		}
	}

	function renderEditMemberModal() {
		const target = state.editTarget;
		if (!target) return null;
		const narrator =
			state.narrators.find((n) => n.id === target.memberId) ??
			{ id: target.memberId, title: target.name, model: null, reasoningEffort: null };
		const titleInput = el("input", {
			type: "text",
			value: narrator.title ?? "",
			placeholder: "名称（留空则不改）",
			maxlength: 200,
		});
		const modelInput = el("input", {
			type: "text",
			value: narrator.model ?? "",
			placeholder: "模型，如 claude-sonnet-4.5；__default__ 跟随全局",
			maxlength: 200,
		});
		const effortSelect = el("select", {});
		effortSelect.appendChild(el("option", { value: "", text: "（不改思考强度）" }));
		for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
			const option = el("option", { value: effort, text: effort });
			if (narrator.reasoningEffort === effort) option.selected = true;
			effortSelect.appendChild(option);
		}
		effortSelect.appendChild(el("option", { value: "__reset__", text: "重置为默认（null）" }));

		const save = el("button", {
			class: "nt-btn",
			text: "保存",
			onclick: async () => {
				save.disabled = true;
				const patch = {};
				const title = titleInput.value.trim();
				if (title && title !== narrator.title) patch.title = title;
				const model = modelInput.value.trim();
				if (model && model !== narrator.model) patch.model = model;
				const effort = effortSelect.value;
				if (effort === "__reset__") patch.reasoningEffort = null;
				else if (effort && effort !== narrator.reasoningEffort) patch.reasoningEffort = effort;
				if (Object.keys(patch).length === 0) {
					state.notice = "没有需要保存的修改";
					state.editTarget = null;
					render();
					return;
				}
				await saveMemberProfile(target.teamId, target.memberId, patch);
			},
		});

		return el("div", {
			class: "nt-modal-overlay",
			onclick: (e) => { if (e.target === e.currentTarget) closeEditMember(); },
		}, [
			el("div", { class: "nt-modal nt-modal-narrow" }, [
				el("div", { class: "nt-modal-header" }, [
					el("h3", { text: `编辑成员：${target.name}` }),
					el("button", { class: "nt-modal-close", text: "✕", onclick: closeEditMember }),
				]),
				el("div", { class: "nt-form" }, [
					el("label", { text: "名称" }), titleInput,
					el("label", { text: "模型" }), modelInput,
					el("label", { text: "思考强度" }), effortSelect,
					el("span", { class: "nt-empty", text: "仅填写需要修改的字段；保存后自动生效" }),
				]),
				el("div", { class: "nt-modal-footer" }, [
					el("button", { class: "nt-btn nt-btn-outline", text: "取消", onclick: closeEditMember }),
					save,
				]),
			]),
		]);
	}

	/**
	 * Confirm then delete a task from the team queue. Deletes the stored task
	 * record AND removes it from the task index (persisted — "自动保存").
	 */
	async function deleteTask(teamId, seq) {
		const key = teamTaskKey(teamId, seq);
		const indexKey = teamTasksIndexKey(teamId);
		try {
			// 1) Remove the task record.
			await request("storage.delete", { scope: { type: "global" }, key });
			// 2) Remove its id from the index and persist the updated index.
			const index = await storageGet(indexKey);
			if (index && Array.isArray(index.ids)) {
				const taskId = `task-${seq}`;
				const ids = index.ids.filter((id) => id !== taskId);
				await request("storage.set", {
					scope: { type: "global" },
					key: indexKey,
					value: { ...index, ids },
				});
			}
			state.notice = `已删除任务 #${seq}`;
			// Update in-memory state so the panel reflects the deletion instantly.
			const team = state.teams.find((t) => t.id === teamId);
			if (team && Array.isArray(team.tasks)) {
				team.tasks = team.tasks.filter((task) => task.seq !== seq);
			}
		} catch (error) {
			state.notice = `删除任务失败：${error instanceof Error ? error.message : String(error)}`;
		}
		render();
		saveViewCache();
	}

	function confirmDeleteTask(team, task) {
		// Native confirm() is blocked inside the sandboxed iframe
		// (sandbox="allow-scripts" without allow-modals): the browser silently
		// rejects it and returns false, so the delete would never run. Use an
		// in-panel DOM confirm modal instead — works regardless of sandbox flags.
		state.deleteTarget = { team, task };
		render();
	}

	function closeDeleteConfirm() {
		state.deleteTarget = null;
		render();
	}

	function renderDeleteConfirmModal() {
		const target = state.deleteTarget;
		if (!target) return null;
		const { team, task } = target;
		const del = el("button", {
			class: "nt-btn nt-btn-danger",
			text: "删除",
			onclick: async () => {
				del.disabled = true;
				state.deleteTarget = null;
				await deleteTask(team.id, task.seq);
			},
		});
		return el("div", {
			class: "nt-modal-overlay",
			onclick: (e) => { if (e.target === e.currentTarget) closeDeleteConfirm(); },
		}, [
			el("div", { class: "nt-modal nt-modal-narrow" }, [
				el("div", { class: "nt-modal-header" }, [
					el("h3", { text: "删除任务" }),
					el("button", { class: "nt-modal-close", text: "✕", onclick: closeDeleteConfirm }),
				]),
				el("div", { class: "nt-modal-list" }, [
					el("p", { text: `确定删除任务 #${task.seq}（${task.memberId}）？删除后不可恢复。` }),
				]),
				el("div", { class: "nt-modal-footer" }, [
					el("button", { class: "nt-btn nt-btn-outline", text: "取消", onclick: closeDeleteConfirm }),
					del,
				]),
			]),
		]);
	}

	function renderTasks(team) {
		const rows = (team.tasks ?? []).map((task) => {
			const seq = task.seq;
			const deleteBtn = el("button", {
				class: "nt-task-delete",
				title: "删除此任务",
				text: "✕",
				onclick: (e) => {
					e.stopPropagation();
					confirmDeleteTask(team, task);
				},
			});
			const row = el("div", { class: "nt-task" }, [
				el("span", { class: "nt-task-id", text: `#${task.seq} ${task.id}` }),
				el("span", {
					class: `nt-badge nt-badge-${task.status ?? "queued"}`,
					text: task.status,
				}),
				el("span", { class: "nt-task-member", text: task.memberId }),
				el("div", { class: "nt-task-prompt", text: task.prompt }),
				...(task.error ? [el("div", { class: "nt-task-error", text: task.error })] : []),
				deleteBtn,
			]);
			// Right-click anywhere on the row offers the same delete action.
			row.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				confirmDeleteTask(team, task);
			});
			return row;
		});
		return section(
			"任务队列",
			rows.length ? el("div", { class: "nt-tasks" }, rows) : el("p", { class: "nt-empty", text: "暂无任务" }),
		);
	}

	function renderTeam(team) {
		return el("div", { class: "nt-team" }, [
			el("div", { class: "nt-team-head" }, [
				el("h2", { class: "nt-title nt-title-inline", text: team.name || "(unnamed)" }),
				el("span", { class: "nt-team-id", text: team.id }),
			]),
			renderMemberChips(team),
			renderTasks(team),
		]);
	}

	// ------------------------------------------------------------ picker modal
	function openPicker() {
		const team = activeTeam();
		if (!team) return;
		state.pickerOpen = true;
		state.pickerSelected = [];
		state.pickerLeader = team.leaderId;
		render();
	}

	function closePicker() {
		state.pickerOpen = false;
		render();
	}

	function togglePick(id) {
		const idx = state.pickerSelected.indexOf(id);
		if (idx >= 0) state.pickerSelected.splice(idx, 1);
		else state.pickerSelected.push(id);
		render();
	}

	async function confirmPicker() {
		const team = activeTeam();
		if (!team) return;
		const members = Array.from(new Set([...team.members, ...state.pickerSelected]));
		// Leader 必须同时是成员：单独设为 Leader 时自动加入
		let leaderId = state.pickerLeader;
		if (leaderId && !members.includes(leaderId)) members.push(leaderId);
		state.pickerOpen = false;
		await saveTeamConfig(team.name, leaderId, members);
	}

	/** 移除成员；若移除的是 Leader 则同步清空 Leader。 */
	async function deleteMember(id) {
		const team = activeTeam();
		if (!team) return;
		const members = team.members.filter((member) => member !== id);
		const leaderId = team.leaderId === id ? null : team.leaderId;
		await saveTeamConfig(team.name, leaderId, members);
	}

	/** 弹窗内切换 Leader（单选；再点一次取消）。 */
	function toggleLeader(id) {
		state.pickerLeader = state.pickerLeader === id ? null : id;
		// Leader 一定是成员：自动纳入勾选
		if (state.pickerLeader && !state.pickerSelected.includes(id)) {
			state.pickerSelected.push(id);
		}
		render();
	}

	// 状态点色阶与宿主 status-registry 一致：idle=gray/working=blue/
	// waiting=yellow/archived=dark/missing=red
	const PICKER_STATUS = {
		idle: { color: "gray", shade: 6 },
		working: { color: "blue", shade: 6 },
		waiting: { color: "yellow", shade: 6 },
		archived: { color: "dark", shade: 4 },
		missing: { color: "red", shade: 6 },
	};

	function renderPicker() {
		if (!state.pickerOpen) return null;
		const team = activeTeam();
		if (!team) return null;
		const rows = state.narrators.map((narrator) => {
			const alreadyMember = team.members.includes(narrator.id) || narrator.id === team.leaderId;
			const selected = state.pickerSelected.includes(narrator.id);
			const status = narrator.status ?? "idle";
			const accent = PICKER_STATUS[status] ?? PICKER_STATUS.idle;
			return el("div", {
				class: `nt-narrator-row${selected ? " nt-row-selected" : ""}${alreadyMember ? " nt-row-member" : ""}`,
				onclick: alreadyMember ? undefined : () => togglePick(narrator.id),
			}, [
				el("span", {
					class: "nt-narrator-dot",
					style: `background: var(--mantine-color-${accent.color}-${accent.shade})`,
				}),
				el("div", { class: "nt-narrator-main" }, [
					el("div", { class: "nt-narrator-title", text: narratorLabel(narrator) }),
					el("div", { class: "nt-narrator-sub", text: `${narrator.id} · ${narrator.model ?? "default model"} · ${narrator.messageCount ?? 0} msgs` }),
				]),
				el("button", {
					class: `nt-leader-mark${state.pickerLeader === narrator.id ? " nt-leader-active" : ""}`,
					text: "★",
					title: "设为 Leader",
					onclick: (e) => { e.stopPropagation(); toggleLeader(narrator.id); },
				}),
				alreadyMember
					? el("span", { class: "nt-narrator-check", text: "已添加" })
					: selected
						? el("span", { class: "nt-narrator-check", text: "✓" })
						: null,
			]);
		});
		return el("div", {
			class: "nt-modal-overlay",
			onclick: (e) => { if (e.target === e.currentTarget) closePicker(); },
		}, [
			el("div", { class: "nt-modal" }, [
				el("div", { class: "nt-modal-header" }, [
					el("h3", { text: "添加叙述者" }),
					el("button", { class: "nt-modal-close", text: "✕", onclick: closePicker }),
				]),
				el("div", { class: "nt-modal-list" },
					rows.length
						? rows
						: [el("div", { class: "nt-modal-empty", text: "没有可用的叙述者" })]),
				el("div", { class: "nt-modal-footer" }, [
					el("button", { class: "nt-btn nt-btn-outline", text: "取消", onclick: closePicker }),
					el("button", {
						class: "nt-btn",
						text: state.pickerSelected.length
							? `添加（${state.pickerSelected.length}）`
							: "添加",
						onclick: confirmPicker,
					}),
				]),
			]),
		]);
	}

	function render() {
		root.textContent = "";
		const header = el("div", { class: "nt-header" }, [
			el("h1", { text: "Narrator Team" }),
			el("div", { class: "nt-header-actions" }, [
				el("button", { class: "nt-btn nt-btn-small", text: state.busy ? "加载中…" : "刷新", onclick: refresh }),
				// Close the dock panel via the host bridge. The tab strip may be
				// hidden when this panel is the only one in its group, so the
				// panel must always offer its own close affordance.
				el("button", {
					class: "nt-btn nt-btn-small nt-btn-outline",
					text: "✕",
					title: "关闭面板",
					onclick: () => {
						request("panel.close").catch(() => {
							state.notice = "无法关闭面板：宿主桥不可用";
							render();
						});
					},
				}),
			]),
		]);
		root.appendChild(header);
		if (state.notice) root.appendChild(el("div", { class: "nt-notice", text: state.notice }));

		// Neutral loading skeleton during the first paint — never a misleading
		// "no team" / "no narrator" empty state before real data has arrived.
		if (state.loading && !state.currentNarratorId) {
			root.appendChild(
				el("p", {
					class: "nt-empty",
					text: "正在加载团队数据…",
					style: "padding:16px 0;text-align:center;",
				}),
			);
			return;
		}

		if (!state.currentNarratorId) {
			root.appendChild(
				el("p", {
					class: "nt-empty",
					text: "请在某个叙述者的聊天界面（/narrators/:id）或叙述者工作区打开此面板，以显示该叙述者所属的团队。",
				}),
			);
			// TEMP diagnostic: binding + loaded state so the integration status
			// is visible without opening devtools.
			const bindingText = state.debugPanelState && typeof state.debugPanelState === "object"
				? JSON.stringify(state.debugPanelState.binding ?? null)
				: String(state.debugPanelState ?? "(panel.getState 失败)");
			root.appendChild(
				el("pre", {
					style: "white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto;background:var(--mantine-color-dark-4);padding:8px;border-radius:6px;",
					text: `binding: ${bindingText}\nnarrators: ${state.narrators.length}\nteams(未过滤): ${state.debugAllTeams ?? "?"}`,
				}),
			);
			return;
		}
		if (state.teams.length === 0) {
			root.appendChild(
				el("p", { class: "nt-empty", text: "当前叙述者不属于任何团队。由 Leader 通过「团队配置」把此叙述者加入团队后，这里会显示对应的团队信息。" }),
			);
			return;
		}

		const switcher = renderTeamSwitcher();
		if (switcher) root.appendChild(switcher);
		root.appendChild(renderConfigForm());
		// 成员编辑入口（作用于当前编辑团队）
		root.appendChild(
			el("div", { class: "nt-section" }, [
				el("div", { class: "nt-section-head" }, [
					el("h2", { class: "nt-title nt-title-inline", text: "成员" }),
					el("button", { class: "nt-btn nt-btn-outline nt-btn-small", text: "+ 添加叙述者", onclick: openPicker }),
				]),
			]),
		);
		for (const team of state.teams) {
			root.appendChild(renderTeam(team));
		}
		const picker = renderPicker();
		if (picker) root.appendChild(picker);
		const messageModal = renderMessageModal();
		if (messageModal) root.appendChild(messageModal);
		const editModal = renderEditMemberModal();
		if (editModal) root.appendChild(editModal);
		const deleteModal = renderDeleteConfirmModal();
		if (deleteModal) root.appendChild(deleteModal);
	}

	// ------------------------------------------------------------------ boot
	root.className = "nt-root";
	render();
	// Defer the first data load: the host UI bridge finishes its handshake after
	// this script runs, so an immediate burst of requests can race it. A short
	// delay keeps the first paint instant and the requests serialized behind
	// the established bridge.
	setTimeout(async () => {
		// 1. Paint the cached view immediately (if any) — no blank / empty flash.
		const restored = await restoreViewCache();
		if (restored) {
			state.loading = false;
			render();
		}
		// 2. Refresh with live data; the cache is overwritten on success.
		await refresh();
	}, 250);
})();
