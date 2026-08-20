import {
	OM_FOLDED,
	isMemoryDetails,
	type Entry,
	type MemoryDetails,
	type Observation,
	type ReviewResult,
	type Summary,
} from "./types.js";
import { foldLedger } from "./fold.js";

export type Projection = {
	observations: Observation[];
	summaries: Summary[];
	/** Reviews are retained for search/recall and are never rendered into automatic memory. */
	reviews?: ReviewResult[];
};

export type ProjectionDiff = {
	observationsOnlyInFull: Observation[];
	summariesOnlyInFull: Summary[];
	observationsOnlyInVisible: Observation[];
	summariesOnlyInVisible: Summary[];
};

export type CompactionProjectionConfig = {
	observationsPoolMaxTokens: number;
};

export type CompactionProjection = Projection & {
	fullFold: boolean;
	details: MemoryDetails;
};

function projectionFromFold(entries: Entry[], upToEntryId?: string): Projection {
	const folded = foldLedger(entries, { upToEntryId });
	return {
		observations: folded.activeObservations,
		summaries: folded.activeSummaries,
		...(folded.reviews.length > 0 ? { reviews: folded.reviews } : {}),
	};
}

function projectionFromMemoryDetails(details: MemoryDetails): Projection {
	const reviews = details.reviews ?? [];
	return {
		observations: [...details.observations],
		summaries: [...details.summaries],
		...(reviews.length > 0 ? { reviews: [...reviews] } : {}),
	};
}

function latestCompactionDetails(entries: Entry[]): MemoryDetails | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction" && isMemoryDetails(entry.details)) return entry.details;
	}
	return undefined;
}

export function fullProjection(entries: Entry[], upToEntryId?: string): Projection {
	return projectionFromFold(entries, upToEntryId);
}

/** Memories already present in the latest compacted context. */
export function visibleProjection(entries: Entry[], upToEntryId?: string): Projection {
	if (upToEntryId) return projectionFromFold(entries, upToEntryId);
	const details = latestCompactionDetails(entries);
	return details ? projectionFromMemoryDetails(details) : { observations: [], summaries: [] };
}

export function latestFullFoldBoundaryId(entries: Entry[]): string | undefined {
	const entryIds = new Set(entries.map((entry) => entry.id));
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction" || !isMemoryDetails(entry.details)) continue;
		if (entry.details.fullFold && entry.firstKeptEntryId && entryIds.has(entry.firstKeptEntryId)) return entry.firstKeptEntryId;
	}
	return undefined;
}

export function buildCompactionProjection(
	entries: Entry[],
	firstKeptEntryId: string,
	config: CompactionProjectionConfig,
): CompactionProjection {
	const durable = foldLedger(entries, { upToEntryId: firstKeptEntryId });
	const observations = durable.activeObservations;
	const summaries = durable.activeSummaries;
	const observationTokens = observations.reduce((total, observation) => total + observation.tokenCount, 0);
	const fullFold = observationTokens >= config.observationsPoolMaxTokens;
	const details: MemoryDetails = {
		type: OM_FOLDED,
		version: 1,
		fullFold,
		observations,
		summaries,
		archive: {
			observations: durable.observations,
			summaries: durable.summaries,
		},
		...(durable.reviews.length > 0 ? { reviews: durable.reviews } : {}),
	};

	return {
		fullFold,
		observations,
		summaries,
		...(durable.reviews.length > 0 ? { reviews: durable.reviews } : {}),
		details,
	};
}

export function diffProjection(visible: Projection, full: Projection): ProjectionDiff {
	const visibleObservationIds = new Set(visible.observations.map((memory) => memory.id));
	const fullObservationIds = new Set(full.observations.map((memory) => memory.id));
	const visibleSummaryIds = new Set(visible.summaries.map((memory) => memory.id));
	const fullSummaryIds = new Set(full.summaries.map((memory) => memory.id));
	return {
		observationsOnlyInFull: full.observations.filter((memory) => !visibleObservationIds.has(memory.id)),
		summariesOnlyInFull: full.summaries.filter((memory) => !visibleSummaryIds.has(memory.id)),
		observationsOnlyInVisible: visible.observations.filter((memory) => !fullObservationIds.has(memory.id)),
		summariesOnlyInVisible: visible.summaries.filter((memory) => !fullSummaryIds.has(memory.id)),
	};
}
