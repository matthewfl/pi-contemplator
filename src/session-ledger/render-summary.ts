import { chronologicalMemories } from "./pools.js";
import type { Observation, Summary } from "./types.js";

const CONTEXT_USAGE_INSTRUCTIONS = `These are memories from earlier in this session, shown together in chronological order.

- Summaries are cited, compressed memories. Their lines include their own ids in leading brackets and source citations inside the text.
- Observations are timestamped records from conversation history. Their lines include ids in leading brackets.

Treat these as past records. When entries conflict, the most recent memory reflects the latest known state. Work that a memory describes as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or summary id. A summary's inline citations can be followed with recall. Do not use recall as broad search or inject raw source unless it is needed.`;

export function observationToSummaryLine(observation: Observation): string {
	return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

export function summaryToSummaryLine(summary: Summary): string {
	return `[${summary.id}] ${summary.timestamp} [summary] ${summary.content}`;
}

export function renderSummary(summaries: Summary[], observations: Observation[]): string {
	if (summaries.length === 0 && observations.length === 0) return "";

	const memories = chronologicalMemories(observations, summaries).map((item) =>
		item.kind === "observation" ? observationToSummaryLine(item.memory) : summaryToSummaryLine(item.memory),
	);
	return [
		CONTEXT_USAGE_INSTRUCTIONS,
		`## Memories (chronological)\n${memories.join("\n")}`,
		"Remember: you can look up the details of a memory by using the recall tool with a memory id contained in square brackets.",
	].join("\n\n");
}
