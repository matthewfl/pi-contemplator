import type { ContemplatorRunState } from "../runtime.js";
import type { Entry } from "../session-ledger/index.js";

const CONTEMPLATOR_MESSAGE = "om.contemplator.message";
const CONTEMPLATOR_SUGGESTION = "om.contemplator.suggestion";
const REVIEW_REQUEST = "om.review.request";
const REVIEW_RESULT = "om.review.result";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type MessagePart = {
	type?: unknown;
	text?: unknown;
	name?: unknown;
	arguments?: unknown;
	content?: unknown;
};

type StoredMessage = {
	role?: unknown;
	content?: unknown;
};

function estimateTokens(value: unknown): number {
	return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function renderValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return JSON.stringify(value, null, 2);
}

function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return renderValue(content);
	return content
		.map((part: MessagePart) => {
			if (part.type === "text") return typeof part.text === "string" ? part.text : "";
			if (part.type === "toolCall" || part.type === "tool_use" || part.type === "toolUse") {
				const name = typeof part.name === "string" ? part.name : "unknown tool";
				const args = part.arguments === undefined ? "" : ` ${renderValue(part.arguments)}`;
				return `[tool call: ${name}${args}]`;
			}
			if (part.type === "toolResult" || part.type === "tool_result") {
				return `[tool result]\n${renderValue(part.content)}`;
			}
			return `[${String(part.type ?? "content")}] ${renderValue(part)}`;
		})
		.filter(Boolean)
		.join("\n");
}

function renderMessage(message: StoredMessage, compacted: boolean): string {
	const role = typeof message.role === "string" ? message.role : "unknown";
	const tokens = estimateTokens(message);
	const marker = compacted ? " [compacted summary]" : "";
	return `${DIM}── ${role}${marker} · ~${tokens} tokens ──${RESET}\n${renderContent(message.content) || `${DIM}(empty message)${RESET}`}`;
}

function liveStateLine(state: ContemplatorRunState): string {
	const pending = `${state.pendingObservations} observations / ${state.pendingReviews} reviews pending`;
	const timing = `Last start: ${state.lastStartedAt === undefined ? "not run this launch" : new Date(state.lastStartedAt).toISOString()} · Last end: ${state.lastCompletedAt === undefined ? "not completed this launch" : new Date(state.lastCompletedAt).toISOString()}`;
	const error = state.lastError ? `\nLast error: ${state.lastError}` : "";
	if (state.running) return `LIVE · running for ${Math.max(0, Math.floor((Date.now() - (state.lastStartedAt ?? Date.now())) / 60_000))}m · ${pending}\n${timing}${error}`;
	const reason = state.waitingFor === "observer"
		? "waiting for observer backlog"
		: state.waitingFor === "probe"
			? "waiting for queued probe delivery"
		: state.waitingFor === "memories"
			? "waiting for memory threshold"
			: state.waitingFor === "responses"
				? "waiting for response spacing"
				: state.waitingFor === "ready"
				? "ready to launch"
				: state.waitingFor === "disabled"
					? "disabled"
					: state.waitingFor === "passive"
						? "passive mode"
						: "idle";
	return `LIVE · ${reason} · ${pending} · ${state.responsesSinceRun} primary responses since cooldown anchor\n${timing}${error}`;
}

export function renderContemplator(entries: Entry[], state?: ContemplatorRunState): string {
	const messages: Array<{ message: StoredMessage; compacted: boolean }> = [];
	const suggestions: Array<{ suggestion: string; delivered: boolean }> = [];
	const reviews: Array<{ requestId: string; scope: string; outcome: string; memoryId?: string }> = [];
	const suggestionIndexByProbeId = new Map<string, number>();
	for (const entry of entries) {
		if (entry.customType === CONTEMPLATOR_MESSAGE && entry.data && typeof entry.data === "object") {
			const data = entry.data as { message?: unknown; compacted?: unknown };
			if (data.message && typeof data.message === "object") {
				messages.push({ message: data.message as StoredMessage, compacted: data.compacted === true });
			}
		}
		if (entry.customType === REVIEW_REQUEST && entry.data && typeof entry.data === "object") {
			const request = (entry.data as { request?: { id?: unknown; scope?: unknown } }).request;
			if (typeof request?.id === "string" && typeof request.scope === "string") reviews.push({ requestId: request.id, scope: request.scope, outcome: "pending" });
		}
		if (entry.customType === REVIEW_RESULT && entry.data && typeof entry.data === "object") {
			const result = (entry.data as { result?: { reviewRequestId?: unknown; scope?: unknown; outcome?: unknown; id?: unknown } }).result;
			if (typeof result?.reviewRequestId === "string" && typeof result.scope === "string" && typeof result.outcome === "string") {
				const existing = reviews.find((review) => review.requestId === result.reviewRequestId);
				const review = { requestId: result.reviewRequestId, scope: result.scope, outcome: result.outcome, memoryId: typeof result.id === "string" ? result.id : undefined };
				if (existing) Object.assign(existing, review); else reviews.push(review);
			}
		}
		if (entry.customType === CONTEMPLATOR_SUGGESTION && entry.data && typeof entry.data === "object") {
			const data = entry.data as { suggestion?: unknown; delivered?: unknown; probeId?: unknown };
			if (typeof data.suggestion !== "string") continue;
			const suggestion = { suggestion: data.suggestion, delivered: data.delivered === true };
			if (typeof data.probeId !== "string") {
				suggestions.push(suggestion);
				continue;
			}
			const existingIndex = suggestionIndexByProbeId.get(data.probeId);
			if (existingIndex === undefined) {
				suggestionIndexByProbeId.set(data.probeId, suggestions.length);
				suggestions.push(suggestion);
			} else {
				suggestions[existingIndex] = suggestion;
			}
		}
	}

	const totalTokens = messages.reduce((total, item) => total + estimateTokens(item.message), 0);
	const lines = [
		`${DIM}CONTEMPLATOR · ${messages.length} messages · ~${totalTokens} estimated tokens${RESET}`,
		...(state ? [`${DIM}${liveStateLine(state)}${RESET}`] : []),
		"",
	];
	if (messages.length === 0) {
		lines.push(`${DIM}No contemplator messages recorded on this branch.${RESET}`);
	} else {
		messages.forEach((item, index) => {
			if (index > 0) lines.push("");
			lines.push(renderMessage(item.message, item.compacted));
		});
	}
	if (suggestions.length > 0) {
		lines.push("", `${DIM}── Probes ──${RESET}`);
		for (const item of suggestions) lines.push(`${item.delivered ? "[delivered]" : "[pending]"} ${item.suggestion}`);
	}
	if (reviews.length > 0) {
		lines.push("", `${DIM}── Structural reviews ──${RESET}`);
		for (const review of reviews) lines.push(`[${review.outcome}] ${review.scope} ${review.requestId}${review.memoryId ? ` → [${review.memoryId}]` : ""}`);
	}
	return lines.join("\n");
}

export function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}
