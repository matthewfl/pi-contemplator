export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
/** Atomic output of one summarizer pass: new summaries and their consumption edges. */
export const OM_SUMMARIZER_COMMIT = "om.summarizer.commit";
export const OM_REVIEW_REQUEST = "om.review.request";
export const OM_REVIEW_RESULT = "om.review.result";
/** Persisted assistant/tool output from a short-lived structural reviewer. */
export const OM_REVIEWER_MESSAGE = "om.reviewer.message";
/** Compact checkpoint referencing reviewer transcript entries across primary-session compaction. */
export const OM_REVIEWER_STATE = "om.reviewer.state";
/** Compact proposal notice queued for the primary agent. */
export const OM_REVIEWER_NOTICE = "om.reviewer.notice";
/** Main-agent active wall-clock time, excluding idle waits for user input. */
export const OM_AGENT_ACTIVITY = "om.agent.activity";
export const OM_FOLDED = "om.folded";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const RETENTION_VALUES = ["ephemeral", "contextual", "durable"] as const;
export type Retention = (typeof RETENTION_VALUES)[number];
export type MemoryVisibility = "visible" | "summarized";

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

export type Entry = {
	type: string;
	id: string;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	fromId?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};

export type Observation = {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	/** Missing values safely default to contextual. */
	retention?: Retention;
	sourceEntryIds: string[];
	tokenCount: number;
};

/** A durable, cited summary. Its source bodies remain elsewhere in the ledger. */
export type Summary = {
	id: string;
	content: string;
	/** Every inline-cited memory id, deduplicated in first-occurrence order. */
	sourceMemoryIds: string[];
	/** Sources newly removed from automatic visibility by this summary. */
	consumedMemoryIds: string[];
	tokenCount: number;
};

export type SummarizerCommitMetrics = {
	consumedMemoryCount: number;
	sourceTokens: number;
	summaryTokens: number;
	estimatedTokenReduction: number;
};

export type SummarizerCommitEntryData = {
	version: 1;
	summaries: Summary[];
	/** Entry id of the newest observation batch included in the run snapshot. */
	coversUpToId: string;
	createdAt: number;
	completedWithDone: boolean;
	metrics: SummarizerCommitMetrics;
};

export type ObservationsRecordedEntryData = {
	observations: Observation[];
	coversUpToId: string;
};

export type ReviewScope = "workflow" | "software";
export type ReviewOutcome = "proposal" | "no_proposal";

export type StructuralReviewRequest = {
	id: string;
	scope: ReviewScope;
	evidence: string;
	concern: string;
	reviewFocus: string;
	constraints?: string;
	createdAt: number;
	requestedBy: "contemplator";
};

type ReviewResultBase = {
	id: string;
	version: 1;
	reviewRequestId: string;
	scope: ReviewScope;
	outcome: ReviewOutcome;
	createdAt: number;
	requestedBy: "contemplator";
};

export type WorkflowReviewProposal = ReviewResultBase & {
	outcome: "proposal";
	proposalKind: "workflow";
	title: string;
	summary: string;
	evidence: string;
	inefficiency: string;
	conceptualDesign: string;
	inputs?: string;
	outputs?: string;
	integration?: string;
	expectedEffect: string;
	uncertainties: string;
};

export type SoftwareReviewProposal = ReviewResultBase & {
	outcome: "proposal";
	proposalKind: "software";
	title: string;
	summary: string;
	evidence: string;
	structuralIssue: string;
	conceptualDesign: string;
	preservedBehavior: string;
	expectedEffect: string;
	uncertainties: string;
};

export type ReviewNoProposal = ReviewResultBase & {
	outcome: "no_proposal";
	reason: string;
	evidenceReviewed: string;
	reconsiderIf?: string;
};

export type ReviewResult = WorkflowReviewProposal | SoftwareReviewProposal | ReviewNoProposal;

export type ReviewRequestEntryData = { request: StructuralReviewRequest };
export type ReviewResultEntryData = { result: ReviewResult };

/** Full durable memory state at a compaction boundary. Bodies occur once in this archive. */
export type MemoryArchive = {
	observations: Observation[];
	summaries: Summary[];
};

export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	fullFold: boolean;
	/** Visible memories injected by this compaction. */
	observations: Observation[];
	summaries: Summary[];
	/** Complete durable graph nodes at this compaction boundary. */
	archive?: MemoryArchive;
	/** Reviews remain recallable/searchable but are never automatically injected. */
	reviews?: ReviewResult[];
};

export type MemoryCoverageCustomType =
	| typeof OM_OBSERVATIONS_RECORDED
	| typeof OM_SUMMARIZER_COMMIT;

export function isRelevance(value: unknown): value is Relevance {
	return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

export function isRetention(value: unknown): value is Retention {
	return typeof value === "string" && (RETENTION_VALUES as readonly string[]).includes(value);
}

export function observationRetention(observation: Observation): Retention {
	return observation.retention ?? "contextual";
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasUniqueMemoryIds(value: unknown, minimum = 0): value is string[] {
	return Array.isArray(value) && value.length >= minimum && value.every(isMemoryId) && new Set(value).size === value.length;
}

export function isObservation(value: unknown): value is Observation {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		isNonEmptyString(value.timestamp) &&
		isRelevance(value.relevance) &&
		(value.retention === undefined || isRetention(value.retention)) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isSummary(value: unknown): value is Summary {
	if (!isPlainRecord(value)) return false;
	if (!isMemoryId(value.id) || !isNonEmptyString(value.content) || !isTokenCount(value.tokenCount)) return false;
	if (!hasUniqueMemoryIds(value.sourceMemoryIds, 2) || !hasUniqueMemoryIds(value.consumedMemoryIds, 2)) return false;
	const sourceIds = new Set(value.sourceMemoryIds);
	return value.consumedMemoryIds.every((id) => sourceIds.has(id));
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		Array.isArray(value.observations) &&
		value.observations.length > 0 &&
		value.observations.every(isObservation) &&
		isNonEmptyString(value.coversUpToId)
	);
}

function isSummarizerCommitMetrics(value: unknown): value is SummarizerCommitMetrics {
	if (!isPlainRecord(value)) return false;
	return isCount(value.consumedMemoryCount) && isTokenCount(value.sourceTokens) &&
		isTokenCount(value.summaryTokens) && isTokenCount(value.estimatedTokenReduction);
}

export function isSummarizerCommitData(value: unknown): value is SummarizerCommitEntryData {
	if (!isPlainRecord(value)) return false;
	return value.version === 1 && Array.isArray(value.summaries) && value.summaries.length > 0 &&
		value.summaries.every(isSummary) && isNonEmptyString(value.coversUpToId) &&
		typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
		typeof value.completedWithDone === "boolean" && isSummarizerCommitMetrics(value.metrics);
}

function isReviewScope(value: unknown): value is ReviewScope {
	return value === "workflow" || value === "software";
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || isNonEmptyString(value);
}

export function isStructuralReviewRequest(value: unknown): value is StructuralReviewRequest {
	if (!isPlainRecord(value)) return false;
	return isNonEmptyString(value.id) && isReviewScope(value.scope) &&
		isNonEmptyString(value.evidence) && isNonEmptyString(value.concern) &&
		isNonEmptyString(value.reviewFocus) && isOptionalString(value.constraints) &&
		typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.requestedBy === "contemplator";
}

export function isReviewResult(value: unknown): value is ReviewResult {
	if (!isPlainRecord(value)) return false;
	const base = isMemoryId(value.id) && value.version === 1 && isNonEmptyString(value.reviewRequestId) &&
		isReviewScope(value.scope) && (value.outcome === "proposal" || value.outcome === "no_proposal") &&
		typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.requestedBy === "contemplator";
	if (!base) return false;
	if (value.outcome === "no_proposal") {
		return isNonEmptyString(value.reason) && isNonEmptyString(value.evidenceReviewed) && isOptionalString(value.reconsiderIf);
	}
	if (value.scope === "workflow") {
		return value.proposalKind === "workflow" && isNonEmptyString(value.title) && isNonEmptyString(value.summary) &&
			isNonEmptyString(value.evidence) && isNonEmptyString(value.inefficiency) && isNonEmptyString(value.conceptualDesign) &&
			isOptionalString(value.inputs) && isOptionalString(value.outputs) && isOptionalString(value.integration) &&
			isNonEmptyString(value.expectedEffect) && isNonEmptyString(value.uncertainties);
	}
	return value.proposalKind === "software" && isNonEmptyString(value.title) && isNonEmptyString(value.summary) &&
		isNonEmptyString(value.evidence) && isNonEmptyString(value.structuralIssue) && isNonEmptyString(value.conceptualDesign) &&
		isNonEmptyString(value.preservedBehavior) && isNonEmptyString(value.expectedEffect) && isNonEmptyString(value.uncertainties);
}

function isMemoryArchive(value: unknown): value is MemoryArchive {
	if (!isPlainRecord(value)) return false;
	return Array.isArray(value.observations) && value.observations.every(isObservation) &&
		Array.isArray(value.summaries) && value.summaries.every(isSummary);
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
	if (!isPlainRecord(value)) return false;
	return value.type === OM_FOLDED && value.version === 1 && typeof value.fullFold === "boolean" &&
		Array.isArray(value.observations) && value.observations.every(isObservation) &&
		Array.isArray(value.summaries) && value.summaries.every(isSummary) &&
		(value.archive === undefined || isMemoryArchive(value.archive)) &&
		(value.reviews === undefined || (Array.isArray(value.reviews) && value.reviews.every(isReviewResult)));
}

export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}

export function isSummarizerCommitEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_SUMMARIZER_COMMIT;
	data: SummarizerCommitEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_SUMMARIZER_COMMIT && isSummarizerCommitData(entry.data);
}

export function isReviewRequestEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_REVIEW_REQUEST;
	data: ReviewRequestEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_REVIEW_REQUEST && isPlainRecord(entry.data) && isStructuralReviewRequest(entry.data.request);
}

export function isReviewResultEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_REVIEW_RESULT;
	data: ReviewResultEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_REVIEW_RESULT && isPlainRecord(entry.data) && isReviewResult(entry.data.result);
}

export function buildObservationsRecordedData(
	observations: Observation[],
	coversUpToId: string,
): ObservationsRecordedEntryData | undefined {
	if (observations.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	const candidate = { observations, coversUpToId };
	return isObservationsRecordedData(candidate) ? candidate : undefined;
}

export function buildSummarizerCommitData(
	data: Omit<SummarizerCommitEntryData, "version">,
): SummarizerCommitEntryData | undefined {
	const candidate: SummarizerCommitEntryData = { version: 1, ...data };
	return isSummarizerCommitData(candidate) ? candidate : undefined;
}
