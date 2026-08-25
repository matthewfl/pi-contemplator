import type { ObserverRunView } from "../runtime.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type StoredMessage = { role?: unknown; content?: unknown };
type ContentPart = { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown; content?: unknown };

function renderValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return JSON.stringify(value, null, 2);
}

function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return renderValue(content);
	return content.map((part: ContentPart) => {
		if (part.type === "text") return typeof part.text === "string" ? part.text : "";
		if (part.type === "thinking") {
			const thinking = typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : renderValue(part);
			return `[thinking]\n${thinking}`;
		}
		if (part.type === "toolCall" || part.type === "tool_use" || part.type === "toolUse") {
			const name = typeof part.name === "string" ? part.name : "unknown tool";
			return `[tool call: ${name}${part.arguments === undefined ? "" : ` ${renderValue(part.arguments)}`}]`;
		}
		if (part.type === "toolResult" || part.type === "tool_result") return `[tool result]\n${renderValue(part.content)}`;
		return `[${String(part.type ?? "content")}] ${renderValue(part)}`;
	}).filter(Boolean).join("\n");
}

function estimateTokens(value: unknown): number {
	return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

/** Render the currently active observer chunk, or the most recently completed chunk. */
export function renderObserver(run: ObserverRunView | undefined, now = Date.now()): string {
	if (!run) return `${DIM}OBSERVER${RESET}\n\n${DIM}Observer has not run yet during this launch.${RESET}`;
	const messages = run.messages.filter((message): message is StoredMessage => !!message && typeof message === "object");
	const totalTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	const elapsedMs = Math.max(0, (run.completedAt ?? now) - run.startedAt);
	const lines = [
		`${DIM}OBSERVER · ${run.status} · ${messages.length} messages · ~${totalTokens.toLocaleString()} estimated transcript tokens${RESET}`,
		`${DIM}Chunk ~${run.chunkTokens.toLocaleString()} tokens · backlog at start ~${run.backlogTokens.toLocaleString()} tokens · ${run.sourceEntryIds.length} source entr${run.sourceEntryIds.length === 1 ? "y" : "ies"}${RESET}`,
		`${DIM}Started ${new Date(run.startedAt).toISOString()} · ${run.completedAt === undefined ? `running for ${Math.floor(elapsedMs / 1000)}s` : `ended ${new Date(run.completedAt).toISOString()} after ${Math.floor(elapsedMs / 1000)}s`}${RESET}`,
		"",
	];
	if (messages.length === 0) lines.push(`${DIM}(no observer messages captured yet)${RESET}`);
	for (const [index, message] of messages.entries()) {
		if (index > 0) lines.push("");
		const role = typeof message.role === "string" ? message.role : "unknown";
		lines.push(`${DIM}── ${role} · ~${estimateTokens(message).toLocaleString()} tokens ──${RESET}`);
		lines.push(renderContent(message.content) || `${DIM}(empty message)${RESET}`);
	}
	if (run.summary) lines.push("", `${DIM}── Completion summary ──${RESET}`, run.summary);
	if (run.error) lines.push("", `${DIM}── Failure ──${RESET}`, run.error);
	return lines.join("\n");
}
