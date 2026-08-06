export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const OM_REVIEW_REQUEST = "om.review.request";
export const OM_REVIEW_RESULT = "om.review.result";
/** Persisted assistant/tool output from a short-lived structural reviewer. */
export const OM_REVIEWER_MESSAGE = "om.reviewer.message";
/** Snapshot of a reviewer transcript retained across primary-session compaction. */
export const OM_REVIEWER_STATE = "om.reviewer.state";
/** Compact proposal notice queued for the primary agent. */
export const OM_REVIEWER_NOTICE = "om.reviewer.notice";
export const OM_FOLDED = "om.folded";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

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
	sourceEntryIds: string[];
	tokenCount: number;
};

export type Reflection = {
	id: string;
	content: string;
	supportingObservationIds: string[];
	tokenCount: number;
};

export type ObservationsRecordedEntryData = {
	observations: Observation[];
	coversUpToId: string;
};

export type ReflectionsRecordedEntryData = {
	reflections: Reflection[];
	coversUpToId: string;
};

export type ObservationsDroppedEntryData = {
	observationIds: string[];
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

export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	fullFold: boolean;
	observations: Observation[];
	reflections: Reflection[];
	/** Optional so compactions written before review results remain readable. */
	reviews?: ReviewResult[];
};

export type V3MemoryCustomType =
	| typeof OM_OBSERVATIONS_RECORDED
	| typeof OM_REFLECTIONS_RECORDED
	| typeof OM_OBSERVATIONS_DROPPED
	| typeof OM_REVIEW_REQUEST
	| typeof OM_REVIEW_RESULT;

export function isRelevance(value: unknown): value is Relevance {
	return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function isObservation(value: unknown): value is Observation {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		isNonEmptyString(value.timestamp) &&
		isRelevance(value.relevance) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isReflection(value: unknown): value is Reflection {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		isNonEmptyStringArray(value.supportingObservationIds) &&
		isTokenCount(value.tokenCount)
	);
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

export function isReflectionsRecordedData(value: unknown): value is ReflectionsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		Array.isArray(value.reflections) &&
		value.reflections.length > 0 &&
		value.reflections.every(isReflection) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
	if (!isPlainRecord(value)) return false;
	return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
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

export function isMemoryDetails(value: unknown): value is MemoryDetails {
	if (!isPlainRecord(value)) return false;
	return (
		value.type === OM_FOLDED &&
		value.version === 1 &&
		typeof value.fullFold === "boolean" &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation) &&
		Array.isArray(value.reflections) &&
		value.reflections.every(isReflection) &&
		(value.reviews === undefined || (Array.isArray(value.reviews) && value.reviews.every(isReviewResult)))
	);
}

export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}

export function isReflectionsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_REFLECTIONS_RECORDED;
	data: ReflectionsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_REFLECTIONS_RECORDED && isReflectionsRecordedData(entry.data);
}

export function isObservationsDroppedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_DROPPED;
	data: ObservationsDroppedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
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
	return { observations, coversUpToId };
}

export function buildReflectionsRecordedData(
	reflections: Reflection[],
	coversUpToId: string,
): ReflectionsRecordedEntryData | undefined {
	if (reflections.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { reflections, coversUpToId };
}

export function buildObservationsDroppedData(
	observationIds: string[],
	coversUpToId: string,
): ObservationsDroppedEntryData | undefined {
	if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observationIds, coversUpToId };
}
