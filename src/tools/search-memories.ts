import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	searchMemories,
	type MemorySearchResult,
} from "../session-ledger/search.js";
import type { Entry } from "../session-ledger/index.js";
import { Text } from "@earendil-works/pi-tui";

export const SEARCH_MEMORIES_TOOL_NAME = "search_memories";
export const SEARCH_MEMORIES_DESCRIPTION =
	"Search recorded observational-memory observations, reflections, and advisory review results by topic or keywords on the current branch. Use the returned memory id with recall to recover exact source context or a full advisory proposal.";

export type SearchMemoriesArgs = Static<typeof SEARCH_MEMORIES_PARAMETERS>;

export type SearchDetails = {
	query: string;
	limit: number;
	observationsSearched: number;
	reflectionsSearched: number;
	reviewsSearched: number;
	results: MemorySearchResult[];
};

function formatResult(result: MemorySearchResult): string {
	if (result.kind === "review") {
		const label = result.outcome === "proposal"
			? `${result.scope} proposal${result.title ? ` — ${result.title}` : ""}`
			: `${result.scope} review concluded with no proposal`;
		return `- [${result.id}] ${label}: ${result.content}`;
	}
	const status = result.status === "dropped" ? " [dropped]" : "";
	const relevance = result.relevance ? ` [${result.relevance}]` : "";
	const timestamp = result.timestamp ? ` ${result.timestamp}` : "";
	return `- ${result.kind} [${result.id}]${status}${timestamp}${relevance}: ${result.content}`;
}

export const SEARCH_MEMORIES_PARAMETERS = Type.Object({
	query: Type.String({
		description: "Topic, phrase, or distinctive keywords to search for.",
	}),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 20,
			description: "Maximum results to return (default 8).",
		}),
	),
});

export function executeSearchMemories(branchEntries: Entry[], params: SearchMemoriesArgs): { content: [{ type: "text"; text: string }]; details: SearchDetails } {
	const query = params.query.trim();
	const limit = params.limit ?? 8;
	if (!query) {
		const details: SearchDetails = {
			query,
			limit,
			observationsSearched: 0,
			reflectionsSearched: 0,
			reviewsSearched: 0,
			results: [],
		};
		return { content: [{ type: "text", text: "Search query must not be empty." }], details };
	}

	const search = searchMemories(branchEntries, query, limit);
	const details: SearchDetails = { ...search, limit };
	const text = search.results.length
		? [
				`Found ${search.results.length} matching memories (searched ${search.observationsSearched} observations, ${search.reflectionsSearched} reflections, and ${search.reviewsSearched} review results):`,
				...search.results.map(formatResult),
				"Use recall(<id>) for exact source context.",
			].join("\n")
		: `No memories matched ${JSON.stringify(query)} (searched ${search.observationsSearched} observations, ${search.reflectionsSearched} reflections, and ${search.reviewsSearched} review results). Try alternate or more distinctive keywords.`;
	return { content: [{ type: "text", text }], details };
}

export function createSearchMemoriesAgentTool(getBranch: () => Entry[]): AgentTool<typeof SEARCH_MEMORIES_PARAMETERS> {
	return {
		name: SEARCH_MEMORIES_TOOL_NAME,
		label: "Search memories",
		description: SEARCH_MEMORIES_DESCRIPTION,
		parameters: SEARCH_MEMORIES_PARAMETERS,
		execute: async (_toolCallId, params) => executeSearchMemories(getBranch(), params),
	};
}

export const searchMemoriesTool = defineTool({
	name: SEARCH_MEMORIES_TOOL_NAME,
	label: "Search observational memories",
	description: SEARCH_MEMORIES_DESCRIPTION,
	promptSnippet:
		"Use search_memories(query) to find relevant older observations or reflections, then use recall(id) when exact source context matters.",
	promptGuidelines: [
		"Use search_memories when the current context may be missing earlier decisions, constraints, user preferences, completed work, or rationale.",
		"Search with a few distinctive keywords or a short topic phrase; the search covers both active and dropped observations plus reflections on the current branch.",
		"After finding a relevant memory, use recall with its exact 12-character id when you need supporting evidence or original source entries.",
		"Do not assume the absence of results means the fact never occurred; search with alternate wording or narrower keywords.",
	],
	parameters: SEARCH_MEMORIES_PARAMETERS,
	renderCall(args) {
		return new Text(`search_memories ${JSON.stringify(args.query)}`, 0, 0);
	},
	renderResult(result) {
		const details = result.details as SearchDetails | undefined;
		const text = result.content
			.filter(
				(part): part is { type: "text"; text: string } =>
					part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n");
		return new Text(
			text ||
				(details
					? `${details.results.length} memory results`
					: "search_memories"),
			0,
			0,
		);
	},
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return executeSearchMemories(ctx.sessionManager.getBranch() as Entry[], params);
	},
});

export function registerSearchMemoriesTool(pi: ExtensionAPI): void {
	pi.registerTool(searchMemoriesTool);
}
