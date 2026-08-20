import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { searchMemories, type MemorySearchResult, type SearchMemoriesOptions } from "../session-ledger/search.js";
import type { Entry } from "../session-ledger/index.js";

export const SEARCH_MEMORIES_TOOL_NAME = "search_memories";
export const SEARCH_MEMORIES_DESCRIPTION =
	"Search recorded observations, cited summaries, and advisory review results by topic or keywords. Use recall with a result id to inspect exact evidence or walk summary citations.";

export type SearchMemoriesArgs = Static<typeof SEARCH_MEMORIES_PARAMETERS>;

export type SearchDetails = {
	query: string;
	limit: number;
	observationsSearched: number;
	summariesSearched: number;
	reviewsSearched: number;
	results: MemorySearchResult[];
};

function formatResult(result: MemorySearchResult): string {
	if (result.kind === "review") {
		const label = result.outcome === "proposal"
			? `${result.scope} proposal${result.title ? ` — ${result.title}` : ""}`
			: `${result.scope} review concluded with no proposal`;
		const forward = result.citedBySummaryIds?.length ? `\n  cited by summaries: [${result.citedBySummaryIds.join(", ")}]` : "";
		return `- [${result.id}] ${label}: ${result.content}${forward}`;
	}
	const visibility = result.visibility === "summarized" ? " [summarized away]" : " [visible]";
	const relevance = result.relevance ? ` [${result.relevance}]` : "";
	const retention = result.retention ? ` [${result.retention}]` : "";
	const timestamp = result.timestamp ? ` ${result.timestamp}` : "";
	const graph = [
		result.consumedBySummaryId ? `consumed by [${result.consumedBySummaryId}]` : undefined,
		result.citedBySummaryIds?.length ? `cited by [${result.citedBySummaryIds.join(", ")}]` : undefined,
	].filter(Boolean).join("; ");
	return `- ${result.kind} [${result.id}]${visibility}${timestamp}${relevance}${retention}: ${result.content}${graph ? `\n  ${graph}` : ""}`;
}

export const SEARCH_MEMORIES_PARAMETERS = Type.Object({
	query: Type.String({ description: "Topic, phrase, or distinctive keywords to search for." }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results to return (default 8)." })),
});

export function executeSearchMemories(branchEntries: Entry[], params: SearchMemoriesArgs, options: SearchMemoriesOptions = {}): { content: [{ type: "text"; text: string }]; details: SearchDetails } {
	const query = params.query.trim();
	const limit = params.limit ?? 8;
	if (!query) {
		const details: SearchDetails = { query, limit, observationsSearched: 0, summariesSearched: 0, reviewsSearched: 0, results: [] };
		return { content: [{ type: "text", text: "Search query must not be empty." }], details };
	}
	const search = searchMemories(branchEntries, query, limit, options);
	const details: SearchDetails = { ...search, limit };
	const counts = `${search.observationsSearched} observations, ${search.summariesSearched} summaries, and ${search.reviewsSearched} review results`;
	const text = search.results.length
		? [`Found ${search.results.length} matching memories (searched ${counts}):`, ...search.results.map(formatResult), "Use recall(<id>) for exact content and immediate graph links."].join("\n")
		: `No memories matched ${JSON.stringify(query)} (searched ${counts}). Try alternate or more distinctive keywords.`;
	return { content: [{ type: "text", text }], details };
}

export function createSearchMemoriesAgentTool(getBranch: () => Entry[], options: SearchMemoriesOptions = {}): AgentTool<typeof SEARCH_MEMORIES_PARAMETERS> {
	return { name: SEARCH_MEMORIES_TOOL_NAME, label: "Search memories", description: SEARCH_MEMORIES_DESCRIPTION, parameters: SEARCH_MEMORIES_PARAMETERS, execute: async (_id, params) => executeSearchMemories(getBranch(), params, options) };
}

export const searchMemoriesTool = defineTool({
	name: SEARCH_MEMORIES_TOOL_NAME,
	label: "Search observational memories",
	description: SEARCH_MEMORIES_DESCRIPTION,
	promptSnippet: "Use search_memories(query) to find older observations, summaries, or reviews, then use recall(id) when exact context matters.",
	promptGuidelines: [
		"Use search_memories when current context may be missing earlier decisions, constraints, preferences, outcomes, or rationale.",
		"Search with distinctive keywords; visible and summarized-away memories are both searched.",
		"Use recall with an exact 12-character id to inspect a node and walk its citation links.",
	],
	parameters: SEARCH_MEMORIES_PARAMETERS,
	renderCall(args) { return new Text(`search_memories ${JSON.stringify(args.query)}`, 0, 0); },
	renderResult(result) {
		const details = result.details as SearchDetails | undefined;
		const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
		return new Text(text || (details ? `${details.results.length} memory results` : "search_memories"), 0, 0);
	},
	async execute(_id, params, _signal, _onUpdate, ctx) { return executeSearchMemories(ctx.sessionManager.getBranch() as Entry[], params); },
});

export function registerSearchMemoriesTool(pi: ExtensionAPI): void {
	pi.registerTool(searchMemoriesTool);
}
