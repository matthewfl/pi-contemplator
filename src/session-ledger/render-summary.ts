import type { Observation, Summary } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Summaries: cited, compressed memories. Summary lines include their own ids in leading brackets and source citations inside the text.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or summary id. A summary's inline citations can be followed with recall. Do not use recall as broad search or inject raw source unless it is needed.`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function summaryToSummaryLine(summary: Summary): string {
	return `[${summary.id}] ${summary.content}`;
}

export function renderSummary(summaries: Summary[], observations: Observation[]): string {
	if (summaries.length === 0 && observations.length === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (summaries.length > 0) parts.push(`## Summaries\n${summaries.map(summaryToSummaryLine).join("\n")}`);
	if (observations.length > 0) parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
	return parts.join("\n\n");
}
