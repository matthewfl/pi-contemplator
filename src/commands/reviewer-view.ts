import type { Entry } from "../session-ledger/index.js";

const REVIEWER_MESSAGE = "om.reviewer.message";
const REVIEWER_NOTICE = "om.reviewer.notice";
const REVIEW_RESULT = "om.review.result";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type StoredMessage = { role?: unknown; content?: unknown };
type ContentPart = { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; content?: unknown };

type ReviewerRun = {
	requestId: string;
	scope: string;
	messages: StoredMessage[];
	notice?: string;
	outcome?: string;
	memoryId?: string;
};

function renderValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return JSON.stringify(value, null, 2);
}

function renderContent(content: unknown): string {
	if (!Array.isArray(content)) return renderValue(content);
	return content.map((part: ContentPart) => {
		if (part.type === "text") return typeof part.text === "string" ? part.text : "";
		if (part.type === "toolCall" || part.type === "tool_use" || part.type === "toolUse") {
			return `[tool call: ${typeof part.name === "string" ? part.name : "unknown tool"}${part.arguments === undefined ? "" : ` ${renderValue(part.arguments)}`}]`;
		}
		if (part.type === "toolResult" || part.type === "tool_result") return `[tool result]\n${renderValue(part.content)}`;
		return `[${String(part.type ?? "content")}] ${renderValue(part)}`;
	}).filter(Boolean).join("\n");
}

function runFor(runs: Map<string, ReviewerRun>, requestId: string, scope = "unknown"): ReviewerRun {
	let run = runs.get(requestId);
	if (!run) {
		run = { requestId, scope, messages: [] };
		runs.set(requestId, run);
	}
	return run;
}

/** Render persisted reviewer assistant/tool output and the proposal notice, if one was queued. */
export function renderReviewer(entries: Entry[]): string {
	const runs = new Map<string, ReviewerRun>();
	for (const entry of entries) {
		if (!entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as { reviewRequestId?: unknown; scope?: unknown; message?: unknown; content?: unknown; result?: unknown; reviewMemoryId?: unknown };
		const result = entry.customType === REVIEW_RESULT && data.result && typeof data.result === "object"
			? data.result as { reviewRequestId?: unknown; scope?: unknown; outcome?: unknown; id?: unknown }
			: undefined;
		let requestId: string | undefined;
		if (typeof data.reviewRequestId === "string") requestId = data.reviewRequestId;
		else if (typeof result?.reviewRequestId === "string") requestId = result.reviewRequestId;
		if (!requestId) continue;
		let scope = "unknown";
		if (typeof data.scope === "string") scope = data.scope;
		else if (typeof result?.scope === "string") scope = result.scope;
		const run = runFor(runs, requestId, scope);
		if (entry.customType === REVIEWER_MESSAGE && data.message && typeof data.message === "object") run.messages.push(data.message as StoredMessage);
		if (entry.customType === REVIEWER_NOTICE && typeof data.content === "string") run.notice = data.content;
		if (result) {
			if (typeof result.outcome === "string") run.outcome = result.outcome;
			if (typeof result.id === "string") run.memoryId = result.id;
		}
	}

	const lines = [`${DIM}STRUCTURAL REVIEWER · ${runs.size} review run${runs.size === 1 ? "" : "s"}${RESET}`, ""];
	if (runs.size === 0) {
		lines.push(`${DIM}No reviewer output recorded on this branch.${RESET}`);
		return lines.join("\n");
	}
	for (const run of runs.values()) {
		lines.push(`${DIM}── ${run.scope} review ${run.requestId}${run.outcome ? ` · ${run.outcome}` : " · pending"}${run.memoryId ? ` · [${run.memoryId}]` : ""} ──${RESET}`);
		if (run.messages.length === 0) lines.push(`${DIM}(no assistant output recorded)${RESET}`);
		for (const message of run.messages) {
			const role = typeof message.role === "string" ? message.role : "assistant";
			lines.push(`${DIM}${role}${RESET}\n${renderContent(message.content) || `${DIM}(empty message)${RESET}`}`);
		}
		if (run.notice) lines.push(`${DIM}Primary-agent notice queued${RESET}\n${run.notice}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
