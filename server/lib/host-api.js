/**
 * host-api.js — typed helpers for calling NarraFork host public APIs from the
 * plugin backend. Every call goes through the plugin → host request surface
 * (`queries.execute` / `commands.execute` / `storage.*`), which requires the
 * `host_api.requests` engine feature (declared in manifest.json).
 *
 * Host errors surface as Error objects with `code` (a PUBLIC_ERROR_CODE string
 * such as CONFLICT / NOT_FOUND / PERMISSION_DENIED) and optional `data`.
 */

export class HostApiError extends Error {
	constructor(code, message, data) {
		super(message);
		this.name = "HostApiError";
		this.code = code;
		this.data = data;
	}
}

function toHostError(error) {
	if (error instanceof HostApiError) return error;
	const code = error && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
	const data = error && "data" in error ? error.data : undefined;
	return new HostApiError(code, error instanceof Error ? error.message : String(error), data);
}

/** Normalize a host response envelope: throw on status "failed". */
function unwrap(result, methodId) {
	if (result && typeof result === "object" && result.status === "failed") {
		const code =
			result.error && typeof result.error.code === "string" ? result.error.code : "INTERNAL_ERROR";
		const message =
			result.error && typeof result.error.message === "string"
				? result.error.message
				: `${methodId} failed`;
		throw new HostApiError(code, message, result.error);
	}
	return result;
}

/**
 * Create the host API client bound to one RPC runtime.
 *
 * @param {object} rpc — the createRpc() runtime
 * @param {object} [options]
 * @param {number} [options.timeoutMs] — per-call timeout (default 30s)
 */
export function createHostApi(rpc, options = {}) {
	const timeoutMs = options.timeoutMs ?? 30_000;

	async function executeQuery(queryId, input) {
		try {
			const result = await rpc.request(
				"queries.execute",
				{ queryId, ...(input === undefined ? {} : { input }) },
				{ timeoutMs },
			);
			return unwrap(result, queryId);
		} catch (error) {
			throw toHostError(error);
		}
	}

	async function executeCommand(commandId, input, extra = {}) {
		const params = { commandId, ...(input === undefined ? {} : { input }) };
		if (extra.idempotencyKey) params.idempotencyKey = extra.idempotencyKey;
		try {
			const result = await rpc.request("commands.execute", params, { timeoutMs });
			return unwrap(result, commandId);
		} catch (error) {
			throw toHostError(error);
		}
	}

	// The host requires an explicit storage scope type; plugins read/write their
	// own global namespace unless they have a narrower grant.
	const OWN_SCOPE = { type: "global" };

	async function storageGet(key) {
		try {
			// The host returns a full entry envelope ({key, value, revision,
			// createdAt, updatedAt}); callers want the stored VALUE (and would
			// otherwise parse the envelope fields — e.g. name/leader/members are
			// inside entry.value, so parsing the envelope yields empty config).
			const entry = await rpc.request("storage.get", { scope: OWN_SCOPE, key }, { timeoutMs });
			return entry && typeof entry === "object" ? entry.value : entry;
		} catch (error) {
			throw toHostError(error);
		}
	}

	async function storageSet(key, value) {
		try {
			return await rpc.request("storage.set", { scope: OWN_SCOPE, key, value }, { timeoutMs });
		} catch (error) {
			throw toHostError(error);
		}
	}

	async function storageDelete(key) {
		try {
			return await rpc.request("storage.delete", { scope: OWN_SCOPE, key }, { timeoutMs });
		} catch (error) {
			throw toHostError(error);
		}
	}

	async function storageList(prefix, options = {}) {
		try {
			const params = { scope: OWN_SCOPE };
			if (prefix !== undefined) params.prefix = prefix;
			if (typeof options.cursor === "string" && options.cursor) params.cursor = options.cursor;
			if (Number.isInteger(options.limit) && options.limit > 0) params.limit = options.limit;
			return await rpc.request("storage.list", params, { timeoutMs });
		} catch (error) {
			throw toHostError(error);
		}
	}

	/**
	 * Subscribe to host events (narrator status / message changes). Requires the
	 * `events.poll` engine feature. Returns the subscription result; events are
	 * delivered via {@link pollEvents}.
	 */
	async function subscribeEvents(input) {
		try {
			return await rpc.request("events.subscribe", input, { timeoutMs });
		} catch (error) {
			throw toHostError(error);
		}
	}

	async function unsubscribeEvents(input) {
		try {
			return await rpc.request("events.unsubscribe", input, { timeoutMs });
		} catch (error) {
			throw toHostError(error);
		}
	}

	/** Poll delivered events for an active subscription. */
	async function pollEvents(input) {
		try {
			return await rpc.request("events.poll", input, { timeoutMs });
		} catch (error) {
			throw toHostError(error);
		}
	}

	/** Query narrators (requires host 0.6+ public API). Returns items array. */
	async function listNarrators(input = {}) {
		const result = await executeQuery("narrafork.narrators.list", input);
		const data = result && typeof result === "object" ? result.data : undefined;
		return data && Array.isArray(data.items) ? data.items : [];
	}

	/**
	 * Read a narrator's recent messages (role + text only, newest first).
	 * Requires the `query.read.narrators` grant (same as listNarrators).
	 * Returns [{ id, role, text, createdAt }].
	 */
	async function listMessages(narratorId, limit = 10) {
		const result = await executeQuery("narrafork.narrator.messages.list", {
			narratorId,
			limit,
		});
		const data = result && typeof result === "object" ? result.data : undefined;
		return data && Array.isArray(data.items) ? data.items : [];
	}

	/** Send a message to a narrator. Returns { accepted, messageId } on success. */
	async function sendMessage(narratorId, message, options = {}) {
		const input = { narratorId, message };
		if (options.locale) input.locale = options.locale;
		if (options.replyInUserLanguage !== undefined) {
			input.replyInUserLanguage = options.replyInUserLanguage;
		}
		const result = await executeCommand("narrafork.narrator.send_message", input, {
			idempotencyKey: options.idempotencyKey,
		});
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/**
	 * Send a message to a SUBAGENT narrator. Subagents have no independent
	 * message channel: a running subagent gets the message buffered (consumed at
	 * its next safe boundary), an idle one is resumed in-place with a follow-up
	 * turn. Returns { delivered: "buffered" | "started", messageId?, bufferedAt? }.
	 */
	async function sendSubagentMessage(narratorId, message, options = {}) {
		const input = { narratorId, message };
		if (options.priority) input.priority = true;
		const result = await executeCommand("narrafork.narrator.send_subagent_message", input, {
			idempotencyKey: options.idempotencyKey,
		});
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/**
	 * Create a narrator (team recruit): "primary" for regular members, "subagent"
	 * for temp workers owned by the recruiting narrator.
	 * Returns { narratorId, title, variant, type, model, cwd, status }.
	 */
	async function createNarrator(options = {}) {
		const input = {};
		for (const key of [
			"title",
			"model",
			"cwd",
			"chapterId",
			"permissionMode",
			"planReflectionAutoApproveOverride",
			"type",
			"subagentType",
			"parentNarratorId",
		]) {
			if (options[key] !== undefined && options[key] !== null) input[key] = options[key];
		}
		const result = await executeCommand("narrafork.narrator.create", input, {
			idempotencyKey: options.idempotencyKey,
		});
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/** Delete a narrator entirely (team fire: removes the worker narrator). */
	async function deleteNarrator(narratorId) {
		const result = await executeCommand("narrafork.narrator.delete", { narratorId });
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/**
	 * Read a narrator's Dynamic Spec tasks.json (compiled). The team queue is
	 * mirrored into each member's spec://tasks.json; this is how the team tracks
	 * whether a dispatched task is still open, done, or blocked.
	 * Returns { content, revisionId, compiled: { tasks, openCount, protectedOpenCount } }.
	 */
	async function specTasksGet(narratorId) {
		const result = await executeCommand("narrafork.narrator.spec_tasks_get", { narratorId });
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/**
	 * Append a protected task to a narrator's spec://tasks.json (same mechanism
	 * as the host /goal command). Idempotent: identical text is not appended
	 * twice. Protected tasks keep the member's loop auto-continuing until done.
	 * Returns { added, taskText, revisionId }.
	 */
	async function specTaskAdd(narratorId, text) {
		const result = await executeCommand("narrafork.narrator.spec_task_add", { narratorId, text });
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/**
	 * Upsert or clear a plugin-managed team-SOP section inside a narrator's
	 * spec://behavior_fence. The host merges the section (user fence content is
	 * preserved) and periodically injects it at the fence cadence, so the SOP
	 * stays visible to the worker even after long runs / context compacts.
	 * Returns { updated, revisionId }.
	 */
	async function specBehaviorFenceUpdate(narratorId, text, mode) {
		const result = await executeCommand("narrafork.narrator.spec_behavior_fence_update", {
			narratorId,
			mode,
			...(text !== undefined && text !== null ? { text } : {}),
		});
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/** Interrupt a narrator. Returns { interrupted }. */
	async function interruptNarrator(narratorId) {
		const result = await executeCommand("narrafork.narrator.interrupt", { narratorId });
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/** Deliver a structured shared context record to multiple narrators. */
	async function deliverNarratorContext(input, options = {}) {
		const result = await executeCommand("narrafork.narrator.context.broadcast", input, {
			idempotencyKey: options.idempotencyKey ?? input?.contextId,
		});
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/** Read delivery receipts for one context record. */
	async function getNarratorContextDeliveries(input) {
		const result = await executeQuery("narrafork.narrator.context.deliveries.list", input);
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/**
	 * Update a narrator's title / model / reasoning effort (at least one field).
	 * model "__default__" follows the global default. Returns { updated: string[] }.
	 */
	async function updateNarratorProfile(narratorId, patch = {}) {
		const input = { narratorId };
		for (const key of ["title", "model", "reasoningEffort", "planReflectionAutoApproveOverride"]) {
			if (patch[key] !== undefined && patch[key] !== null) input[key] = patch[key];
		}
		const result = await executeCommand("narrafork.narrator.update_profile", input);
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	/**
	 * Write (or replace) a whitelisted Dynamic Spec file for a narrator
	 * (uri: "tasks.json" | "index.md"). Returns { path, uri, revisionId }.
	 */
	async function specFileWrite(narratorId, uri, content) {
		const result = await executeCommand("narrafork.narrator.spec_write", {
			narratorId,
			uri,
			content,
		});
		return result && typeof result === "object" ? result.data ?? result : result;
	}

	return {
		executeQuery,
		executeCommand,
		storageGet,
		storageSet,
		storageDelete,
		storageList,
		listNarrators,
		listMessages,
		sendMessage,
		sendSubagentMessage,
		createNarrator,
		deleteNarrator,
		specTasksGet,
		specTaskAdd,
		specBehaviorFenceUpdate,
		interruptNarrator,
		updateNarratorProfile,
		specFileWrite,
		deliverNarratorContext,
		getNarratorContextDeliveries,
	};
}
