/**
 * rpc.js — Content-Length framed JSON-RPC over stdio for NarraFork plugins.
 *
 * Thin transport layer: encodes/decodes frames, routes inbound requests to a
 * registered handler, and tracks outbound requests (plugin → host) so callers
 * get a Promise per request id. No business logic lives here.
 *
 * Frame format: `Content-Length: <bytes>\r\nContent-Type: application/json;
 * charset=utf-8\r\n\r\n<single JSON-RPC object>`.
 */

const MAX_HEADER_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

let nextRequestId = 1;

function appendBytes(left, right) {
	const next = new Uint8Array(left.byteLength + right.byteLength);
	next.set(left);
	next.set(right, left.byteLength);
	return next;
}

function delimiterIndex(bytes) {
	for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
		if (
			bytes[index] === 13 &&
			bytes[index + 1] === 10 &&
			bytes[index + 2] === 13 &&
			bytes[index + 3] === 10
		) {
			return index;
		}
	}
	return -1;
}

function contentLength(header) {
	let length;
	for (const line of header.split("\r\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) throw new Error("invalid RPC header");
		if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
		if (length !== undefined) throw new Error("duplicate Content-Length header");
		const value = line.slice(separator + 1).trim();
		if (!/^\d+$/.test(value)) throw new Error("invalid Content-Length header");
		length = Number(value);
	}
	if (!Number.isSafeInteger(length)) throw new Error("missing Content-Length header");
	return length;
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(message) {
	return isPlainObject(message) && message.jsonrpc === "2.0" && typeof message.method === "string" && "id" in message;
}

/**
 * Create the RPC runtime.
 *
 * @param {object} handlers
 * @param {(message: object) => Promise<object | undefined> | object | undefined} handlers.onRequest
 *   Handle an inbound request. Return the result object (or a {error} shape) to
 *   reply; return undefined to leave the request unanswered.
 * @param {(notification: object) => void} [handlers.onNotification]
 *   Handle an inbound notification (no id).
 * @param {(message: object) => void} [handlers.onSend]
 *   Observe every outgoing frame (used for tests).
 */
export function createRpc({ onRequest, onNotification, onSend }) {
	let buffer = new Uint8Array(0);
	const pending = new Map();

	function send(message) {
		const body = encoder.encode(JSON.stringify(message));
		const header = encoder.encode(
			`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
		);
		process.stdout.write(appendBytes(header, body));
		if (onSend) onSend(message);
	}

	function sendNotification(method, params) {
		const message = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
		send(message);
		return undefined;
	}

	/**
	 * Send a request to the host and await its response.
	 * Resolves with `result`; rejects with an error object carrying
	 * `{ code, message, data }` from the host (or a transport error).
	 */
	function request(method, params, options = {}) {
		const id = `p${nextRequestId}`;
		nextRequestId += 1;
		const message = {
			jsonrpc: "2.0",
			id,
			method,
			...(params === undefined ? {} : { params }),
		};
		return new Promise((resolve, reject) => {
			const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`RPC request timed out: ${method}`));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			try {
				send(message);
			} catch (error) {
				clearTimeout(timer);
				pending.delete(id);
				reject(error);
			}
		});
	}

	function handleMessage(message) {
		if (!isPlainObject(message) || message.jsonrpc !== "2.0") return;
		if (isRequest(message)) {
			const reply = onRequest ? onRequest(message) : undefined;
			if (reply === undefined) return;
			Promise.resolve(reply).then(
				(replyObject) => {
					// onRequest returns a JSON-RPC response shape ({result} or {error});
					// spread it directly so the wire frame is not double-wrapped.
					const response =
						replyObject && typeof replyObject === "object"
							? replyObject
							: { result: replyObject };
					send({ jsonrpc: "2.0", id: message.id, ...response });
				},
				(error) =>
					send({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
					}),
			);
			return;
		}
		if (typeof message.method === "string" && !("id" in message)) {
			if (onNotification) onNotification(message);
			return;
		}
		if ("id" in message) {
			const entry = pending.get(message.id);
			if (!entry) return;
			pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.error) {
				entry.reject(normalizeHostError(message.error));
			} else {
				entry.resolve(message.result);
			}
		}
	}

	function parseFrames() {
		while (buffer.byteLength > 0) {
			const delimiter = delimiterIndex(buffer);
			if (delimiter < 0) {
				if (buffer.byteLength > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
				return;
			}
			if (delimiter > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
			const length = contentLength(decoder.decode(buffer.slice(0, delimiter)));
			if (length > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds limit");
			const bodyStart = delimiter + 4;
			const frameEnd = bodyStart + length;
			if (buffer.byteLength < frameEnd) return;
			const message = JSON.parse(decoder.decode(buffer.slice(bodyStart, frameEnd)));
			buffer = buffer.slice(frameEnd);
			handleMessage(message);
		}
	}

	function onData(chunk) {
		buffer = appendBytes(buffer, new Uint8Array(chunk));
		if (buffer.byteLength > MAX_BUFFER_BYTES) throw new Error("RPC input buffer exceeds limit");
		parseFrames();
	}

	function onEnd() {
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error("RPC stream ended"));
		}
		pending.clear();
	}

	return {
		sendNotification,
		request,
		onData,
		onEnd,
	};
}

/** Normalize a host error object into a stable Error with code/data attached. */
function normalizeHostError(error) {
	const err = new Error(
		isPlainObject(error) && typeof error.message === "string"
			? error.message
			: "Host RPC error",
	);
	err.code = isPlainObject(error) ? error.code ?? -32603 : -32603;
	err.data = isPlainObject(error) ? error.data : undefined;
	return err;
}
