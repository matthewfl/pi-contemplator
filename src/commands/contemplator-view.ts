import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyTextToClipboard } from "../clipboard.js";
import type { Entry } from "../session-ledger/index.js";

const CONTEMPLATOR_MESSAGE = "om.contemplator.message";
const CONTEMPLATOR_SUGGESTION = "om.contemplator.suggestion";
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

function renderContemplator(entries: Entry[]): string {
	const messages: Array<{ message: StoredMessage; compacted: boolean }> = [];
	const suggestions: Array<{ suggestion: string; delivered: boolean }> = [];
	for (const entry of entries) {
		if (entry.customType === CONTEMPLATOR_MESSAGE && entry.data && typeof entry.data === "object") {
			const data = entry.data as { message?: unknown; compacted?: unknown };
			if (data.message && typeof data.message === "object") {
				messages.push({ message: data.message as StoredMessage, compacted: data.compacted === true });
			}
		}
		if (entry.customType === CONTEMPLATOR_SUGGESTION && entry.data && typeof entry.data === "object") {
			const data = entry.data as { suggestion?: unknown; delivered?: unknown };
			if (typeof data.suggestion === "string") suggestions.push({ suggestion: data.suggestion, delivered: data.delivered === true });
		}
	}

	const totalTokens = messages.reduce((total, item) => total + estimateTokens(item.message), 0);
	const lines = [
		`${DIM}CONTEMPLATOR · ${messages.length} messages · ~${totalTokens} estimated tokens${RESET}`,
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
	return lines.join("\n");
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function registerContemplatorViewCommand(pi: ExtensionAPI): void {
	pi.registerCommand("om:view-contemplator", {
		description: "View the contemplator's messages, tool calls, probes, and estimated tokens",
		handler: async (_args: unknown, ctx: ExtensionContext) => {
			const output = renderContemplator(ctx.sessionManager.getBranch() as Entry[]);
			const copied = await copyTextToClipboard(stripAnsi(output)).catch(() => false);
			ctx.ui.notify(
				`${output}\n\n${copied ? "Copied /om:view-contemplator output to clipboard." : "Warning: failed to copy /om:view-contemplator output to clipboard."}`,
				"info",
			);
		},
	});
}
