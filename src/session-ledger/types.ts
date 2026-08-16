export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
/** Atomic output of one completed librarian pass (new reflections + lifecycle changes + checkpoint). */
export const OM_LIBRARIAN_COMMIT = "om.librarian.commit";
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
export type MemoryStatus = "active" | "inactive" | "deleted";

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
	/** Optional only for records written before the librarian migration; treat absence as contextual. */
	retention?: Retention;
	sourceEntryIds: string[];
	tokenCount: number;
};

export type Reflection = {
	id: string;
	content: string;
	/** Legacy observation-only provenance, retained for backwards compatibility. */
	supportingObservationIds: string[];
	/** Direct observation/reflection sources for librarian-created higher-order memories. */
	sourceMemoryIds?: string[];
	tokenCount: number;
};

export type MemoryLifecycleAction =
	| {
			type: "makeInactive";
			memoryIds: string[];
			recallIf: string;
			becauseOfMemoryIds: string[];
			createdAt: number;
	  }
	| {
			type: "makeActive";
			memoryIds: string[];
			becauseOfMemoryIds: string[];
			createdAt: number;
	  }
	| {
			type: "delete";
			memoryIds: string[];
			reason: string;
			becauseOfMemoryIds: string[];
			replacementMemoryIds: string[];
			createdAt: number;
	  };

export type LibrarianCommitEntryData = {
	version: 1;
	reflections: Reflection[];
	actions: MemoryLifecycleAction[];
	/** Entry id of the newest observation-record batch included in the run snapshot. */
	coversUpToId: string;
	summary: string;
	createdAt: number;
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

export type MemoryLifecycleSnapshot = {
	memoryId: string;
	status: MemoryStatus;
	recallIf?: string;
	reason?: string;
	becauseOfMemoryIds: string[];
	replacementMemoryIds: string[];
	changedAt?: number;
};

export type MemoryArchive = {
	observations: Observation[];
	reflections: Reflection[];
	lifecycle: MemoryLifecycleSnapshot[];
};

export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	fullFold: boolean;
	/** Active memories injected by this compaction. */
	observations: Observation[];
	reflections: Reflection[];
	/** Complete durable memory state at this compaction boundary. */
	archive?: MemoryArchive;
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

export function isRetention(value: unknown): value is Retention {
	return typeof value === "string" && (RETENTION_VALUES as readonly string[]).includes(value);
}

export function observationRetention(observation: Observation): Retention {
	return observation.retention ?? "contextual";
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
		(value.retention === undefined || isRetention(value.retention)) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isReflection(value: unknown): value is Reflection {
	if (!isPlainRecord(value)) return false;
	const legacySupport = isNonEmptyStringArray(value.supportingObservationIds);
	const librarianSources = Array.isArray(value.sourceMemoryIds) && value.sourceMemoryIds.length >= 2 && value.sourceMemoryIds.every(isMemoryId);
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		Array.isArray(value.supportingObservationIds) && value.supportingObservationIds.every(isMemoryId) &&
		(legacySupport || librarianSources) &&
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
		value.reflections.every(isReflection) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
	if (!isPlainRecord(value)) return false;
	return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
}

export function isMemoryLifecycleAction(value: unknown): value is MemoryLifecycleAction {
	if (!isPlainRecord(value) || !isNonEmptyStringArray(value.memoryIds) || !value.memoryIds.every(isMemoryId)) return false;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
	if (value.type === "makeInactive") {
		return isNonEmptyString(value.recallIf) && isNonEmptyStringArray(value.becauseOfMemoryIds) && value.becauseOfMemoryIds.every(isMemoryId);
	}
	if (value.type === "makeActive") {
		return isNonEmptyStringArray(value.becauseOfMemoryIds) && value.becauseOfMemoryIds.every(isMemoryId);
	}
	if (value.type === "delete") {
		return isNonEmptyString(value.reason) && isNonEmptyStringArray(value.becauseOfMemoryIds) && value.becauseOfMemoryIds.every(isMemoryId) &&
			Array.isArray(value.replacementMemoryIds) && value.replacementMemoryIds.every(isMemoryId);
	}
	return false;
}

export function isLibrarianCommitData(value: unknown): value is LibrarianCommitEntryData {
	if (!isPlainRecord(value)) return false;
	return value.version === 1 && Array.isArray(value.reflections) && value.reflections.every(isReflection) &&
		Array.isArray(value.actions) && value.actions.every(isMemoryLifecycleAction) &&
		isNonEmptyString(value.coversUpToId) && isNonEmptyString(value.summary) &&
		typeof value.createdAt === "number" && Number.isFinite(value.createdAt);
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

function isMemoryLifecycleSnapshot(value: unknown): value is MemoryLifecycleSnapshot {
	if (!isPlainRecord(value) || !isMemoryId(value.memoryId)) return false;
	if (value.status !== "active" && value.status !== "inactive" && value.status !== "deleted") return false;
	return (value.recallIf === undefined || isNonEmptyString(value.recallIf)) &&
		(value.reason === undefined || isNonEmptyString(value.reason)) &&
		Array.isArray(value.becauseOfMemoryIds) && value.becauseOfMemoryIds.every(isMemoryId) &&
		Array.isArray(value.replacementMemoryIds) && value.replacementMemoryIds.every(isMemoryId) &&
		(value.changedAt === undefined || (typeof value.changedAt === "number" && Number.isFinite(value.changedAt)));
}

function isMemoryArchive(value: unknown): value is MemoryArchive {
	if (!isPlainRecord(value)) return false;
	return Array.isArray(value.observations) && value.observations.every(isObservation) &&
		Array.isArray(value.reflections) && value.reflections.every(isReflection) &&
		Array.isArray(value.lifecycle) && value.lifecycle.every(isMemoryLifecycleSnapshot);
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
		(value.archive === undefined || isMemoryArchive(value.archive)) &&
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

export function isLibrarianCommitEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_LIBRARIAN_COMMIT;
	data: LibrarianCommitEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_LIBRARIAN_COMMIT && isLibrarianCommitData(entry.data);
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
	if (!isNonEmptyString(coversUpToId)) return undefined;
	// An empty list is a durable successful-pass checkpoint. Without it, a
	// reflector that correctly finds nothing new retries the same raw range on
	// every trigger and the over-target dropper never gets a maintenance pass.
	return { reflections, coversUpToId };
}

export function buildObservationsDroppedData(
	observationIds: string[],
	coversUpToId: string,
): ObservationsDroppedEntryData | undefined {
	if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observationIds, coversUpToId };
}

export function buildLibrarianCommitData(
	data: Omit<LibrarianCommitEntryData, "version">,
): LibrarianCommitEntryData | undefined {
	const candidate: LibrarianCommitEntryData = { version: 1, ...data };
	return isLibrarianCommitData(candidate) ? candidate : undefined;
}
