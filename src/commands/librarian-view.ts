import type { LibrarianRunView } from "../runtime.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type StoredMessage = { role?: unknown; content?: unknown };
type ContentPart = { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; content?: unknown };

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

/** Render the most recent launch-local librarian transcript. */
export function renderLibrarian(run: LibrarianRunView | undefined): string {
	if (!run) return `${DIM}LIBRARIAN${RESET}\n\n${DIM}Librarian has not run yet during this launch.${RESET}`;
	const messages = run.messages.filter((message): message is StoredMessage => !!message && typeof message === "object");
	const totalTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	const lines = [
		`${DIM}LIBRARIAN · ${run.status} · ${messages.length} messages · ~${totalTokens.toLocaleString()} estimated tokens${RESET}`,
		`${DIM}Started ${new Date(run.startedAt).toISOString()}${RESET}`,
		"",
	];
	if (messages.length === 0) lines.push(`${DIM}(no librarian messages captured yet)${RESET}`);
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
