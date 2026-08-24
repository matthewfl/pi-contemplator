import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { recallMemorySources, type Entry, type RecallResult } from "../session-ledger/recall.js";
import type { MemoryVisibility, Observation, ReviewResult, Summary } from "../session-ledger/index.js";
import { renderRecallSourceEntries } from "../serialize.js";

export const RECALL_OBSERVATION_TOOL_NAME = "recall";
export const RECALL_DESCRIPTION =
	"Recover one exact observation, summary, or review memory and its immediate summary-graph links. Follow cited source or forward-pointer ids with additional recall calls.";

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

type RecallToolStatus = "ok" | "partial" | "invalid_id" | "not_found";

export type RecallObservationToolDetails = {
	status: RecallToolStatus;
	memoryId: string;
	collision: boolean;
	partial: boolean;
	observations: Array<{
		observation: Observation;
		visibility: MemoryVisibility;
		consumedBySummaryId?: string;
		citedBySummaryIds: string[];
		sourceEntryIds: string[];
		missingSourceEntryIds: string[];
		nonSourceEntryIds: string[];
	}>;
	summaries: Array<{
		summary: Summary;
		visibility: MemoryVisibility;
		consumedBySummaryId?: string;
		citedBySummaryIds: string[];
		missingSourceMemoryIds: string[];
	}>;
	reviews: ReviewResult[];
	sourceEntries: Entry[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
	missingSourceMemoryIds: string[];
	message?: string;
};

function emptyDetails(status: RecallToolStatus, memoryId: string, message: string): RecallObservationToolDetails {
	return { status, memoryId, collision: false, partial: false, observations: [], summaries: [], reviews: [], sourceEntries: [], missingSourceEntryIds: [], nonSourceEntryIds: [], missingSourceMemoryIds: [], message };
}

function textResult(text: string, details: RecallObservationToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function graphLines(citedBy: string[], consumedBy?: string): string[] {
	return [
		...(consumedBy ? [`Consumed from automatic context by summary [${consumedBy}].`] : []),
		`Cited by summaries: ${citedBy.length ? `[${citedBy.join(", ")}]` : "(none)"}.`,
	];
}

function reviewText(review: ReviewResult): string {
	if (review.outcome === "no_proposal") {
		return [`REVIEW [${review.id}] ${review.scope} — no proposal`, `Reason: ${review.reason}`, `Evidence reviewed: ${review.evidenceReviewed}`, ...(review.reconsiderIf ? [`Reconsider if: ${review.reconsiderIf}`] : [])].join("\n");
	}
	const scopeDetails = review.proposalKind === "workflow"
		? [`Inefficiency: ${review.inefficiency}`]
		: [`Structural issue: ${review.structuralIssue}`, `Preserved behavior: ${review.preservedBehavior}`];
	return [`REVIEW [${review.id}] ${review.scope} proposal — ${review.title}`, review.summary, `Evidence: ${review.evidence}`, ...scopeDetails, `Conceptual design: ${review.conceptualDesign}`, `Expected effect: ${review.expectedEffect}`, `Uncertainties: ${review.uncertainties}`].join("\n");
}

function renderFound(result: Extract<RecallResult, { status: "found" }>): ReturnType<typeof textResult> {
	const sections: string[] = [];
	for (const match of result.observations) {
		sections.push([
			`OBSERVATION [${match.observation.id}] [${match.visibility}] ${match.observation.timestamp} [${match.observation.relevance}]`,
			match.observation.content,
			...graphLines(match.citedBySummaryIds, match.consumedBySummaryId),
			`Source entry ids: [${match.sourceEntryIds.join(", ")}].`,
			match.sourceEntries.length ? `Exact source context:\n${renderRecallSourceEntries(match.sourceEntries)}` : "Exact source context is unavailable.",
		].join("\n"));
	}
	for (const match of result.summaries) {
		sections.push([
			`SUMMARY [${match.summary.id}] [${match.visibility}]`,
			match.summary.content,
			`Source memories: [${match.sourceMemoryIds.join(", ")}].`,
			`Consumed memories: [${match.consumedMemoryIds.join(", ")}].`,
			...graphLines(match.citedBySummaryIds, match.consumedBySummaryId),
		].join("\n"));
	}
	for (const match of result.reviews) sections.push(`${reviewText(match.review)}\n${graphLines(match.citedBySummaryIds).join("\n")}`);
	const details: RecallObservationToolDetails = {
		status: result.partial ? "partial" : "ok",
		memoryId: result.memoryId,
		collision: result.collision,
		partial: result.partial,
		observations: result.observations.map((match) => ({ observation: match.observation, visibility: match.visibility, ...(match.consumedBySummaryId ? { consumedBySummaryId: match.consumedBySummaryId } : {}), citedBySummaryIds: match.citedBySummaryIds, sourceEntryIds: match.sourceEntryIds, missingSourceEntryIds: match.missingSourceEntryIds, nonSourceEntryIds: match.nonSourceEntryIds })),
		summaries: result.summaries.map((match) => ({ summary: match.summary, visibility: match.visibility, ...(match.consumedBySummaryId ? { consumedBySummaryId: match.consumedBySummaryId } : {}), citedBySummaryIds: match.citedBySummaryIds, missingSourceMemoryIds: match.missingSourceMemoryIds })),
		reviews: result.reviews.map((match) => match.review),
		sourceEntries: result.sourceEntries,
		missingSourceEntryIds: result.missingSourceEntryIds,
		nonSourceEntryIds: result.nonSourceEntryIds,
		missingSourceMemoryIds: result.missingSourceMemoryIds,
	};
	if (result.collision) sections.unshift("WARNING: this id matched more than one durable record.");
	if (result.partial) sections.push(`WARNING: some linked evidence was unavailable (${[...result.missingSourceEntryIds, ...result.nonSourceEntryIds, ...result.missingSourceMemoryIds].join(", ")}).`);
	return textResult(sections.join("\n\n"), details);
}

export const RECALL_PARAMETERS = Type.Object({
	id: Type.String({ pattern: "^[a-f0-9]{12}$", description: "Exact 12-character lowercase hexadecimal memory id." }),
});
export type RecallArgs = Static<typeof RECALL_PARAMETERS>;
export type RecallAgentToolOptions = Record<string, never>;

export function executeRecall(params: RecallArgs, getBranch: () => Entry[], _options: RecallAgentToolOptions = {}) {
	const memoryId = params.id;
	if (!MEMORY_ID_PATTERN.test(memoryId)) {
		const message = `Memory id must be 12 lowercase hex characters. Received: ${memoryId}`;
		return textResult(message, emptyDetails("invalid_id", memoryId, message));
	}
	const result = recallMemorySources(getBranch(), memoryId);
	if (result.status === "not_found") {
		const message = `No observation, summary, or review with id ${memoryId} was found on the current branch.`;
		return textResult(message, emptyDetails("not_found", memoryId, message));
	}
	return renderFound(result);
}

export function createRecallAgentTool(getBranch: () => Entry[], options: RecallAgentToolOptions = {}): AgentTool<typeof RECALL_PARAMETERS> {
	return { name: RECALL_OBSERVATION_TOOL_NAME, label: "Recall memory", description: RECALL_DESCRIPTION, parameters: RECALL_PARAMETERS, execute: async (_id, params) => executeRecall(params, getBranch, options) };
}

export function formatRecallHeaderForTui(details: RecallObservationToolDetails): string {
	if (details.status === "invalid_id" || details.status === "not_found") return `✗ recall ${details.memoryId}`;
	const kind = details.summaries.length ? "summary" : details.reviews.length ? "review" : "observation";
	return `${details.partial ? "⚠" : "✓"} ${kind} ${details.memoryId}`;
}

export function formatRecallResultForTui(result: AgentToolResult<RecallObservationToolDetails>, _expanded: boolean): string {
	const text = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
	return result.details ? `${formatRecallHeaderForTui(result.details)}\n${text}` : text;
}

export function formatRecallCallForTui(id: string | undefined): string {
	return `recall ${id ?? ""}`.trimEnd();
}

export function formatRecallRenderedResultForTui(result: AgentToolResult<RecallObservationToolDetails>, expanded: boolean): string {
	return formatRecallResultForTui(result, expanded);
}

export const recallObservationTool = defineTool({
	name: RECALL_OBSERVATION_TOOL_NAME,
	label: "Recall memory evidence",
	description: RECALL_DESCRIPTION,
	promptSnippet: "Use recall(<id>) to inspect an exact observation, summary, or review and its immediate citation links.",
	promptGuidelines: [
		"Use recall when exact wording, rationale, paths, commands, errors, constraints, or provenance matter.",
		"For summaries, follow source memory ids with additional recall calls rather than recursively expanding the whole graph.",
		"Do not use recall as broad search; use search_memories first when you do not have an exact id.",
	],
	parameters: RECALL_PARAMETERS,
	renderCall(args) { return new Text(formatRecallCallForTui(args.id), 0, 0); },
	renderResult(result, options) { return new Text(formatRecallRenderedResultForTui(result as AgentToolResult<RecallObservationToolDetails>, options.expanded), 0, 0); },
	async execute(_id, params, _signal, _onUpdate, ctx) { return executeRecall(params, () => ctx.sessionManager.getBranch() as Entry[]); },
});

export function registerRecallTool(pi: ExtensionAPI): void {
	pi.registerTool(recallObservationTool);
}
