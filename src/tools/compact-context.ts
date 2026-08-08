import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";

export const COMPACT_CONTEXT_TOOL_NAME = "compact_context";
export const COMPACT_CONTEXT_DESCRIPTION =
	"Force manual compaction. Use sparingly when substantial work remains but the remaining context is insufficient, or when accumulated context has become noisy or stale enough to impair focus and reliable reasoning.";

export type CompactContextDetails = {
	status: "scheduled" | "already_pending" | "in_progress";
};

export function createCompactContextTool(runtime: Runtime) {
	return defineTool({
		name: COMPACT_CONTEXT_TOOL_NAME,
		label: "Compact context",
		description: COMPACT_CONTEXT_DESCRIPTION,
		promptSnippet:
			"Force manual context compaction when substantial work remains but context is running out, or when context degradation is impairing focus",
		promptGuidelines: [
			"Use compact_context sparingly when either substantial additional work remains and there is not enough context left to complete it, or accumulated past context has become noisy, stale, or distracting enough that you are struggling to focus on the current task or reason about it reliably.",
			"Do not use compact_context routinely, for short tasks, or merely because the conversation is long; use it for genuine context-capacity pressure or context degradation that is interfering with the work.",
			"Call compact_context by itself and stop the current turn; observational memory will compact the context and automatically resume the task.",
		],
		parameters: Type.Object({}),
		async execute() {
			if (runtime.compactInFlight) {
				return {
					content: [{ type: "text" as const, text: "Context compaction is already in progress. Stop this turn and wait for automatic resume." }],
					details: { status: "in_progress" } as CompactContextDetails,
					terminate: true,
				};
			}
			if (runtime.compactRequested) {
				return {
					content: [{ type: "text" as const, text: "Context compaction is already scheduled. Stop this turn and wait for automatic resume." }],
					details: { status: "already_pending" } as CompactContextDetails,
					terminate: true,
				};
			}

			runtime.compactRequested = true;
			return {
				content: [{ type: "text" as const, text: "Context compaction scheduled. Stop this turn; the task will resume automatically after compaction." }],
				details: { status: "scheduled" } as CompactContextDetails,
				terminate: true,
			};
		},
	});
}

export function registerCompactContextTool(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerTool(createCompactContextTool(runtime));
}
