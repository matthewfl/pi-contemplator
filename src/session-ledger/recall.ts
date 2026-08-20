import {
	isMemoryDetails,
	isObservationsRecordedEntry,
	isReviewResultEntry,
	isSummarizerCommitEntry,
	type Entry,
	type MemoryVisibility,
	type Observation,
	type ReviewResult,
	type Summary,
} from "./types.js";
import { foldLedger } from "./fold.js";

const SOURCE_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export type { Entry, Observation, Summary };

type LedgerLocation = {
	entryId: string;
	entryIndex: number;
	recordIndex: number;
};

export type RecalledObservation = {
	observation: Observation;
	observationEntryId: string;
	observationRecordIndex: number;
	visibility: MemoryVisibility;
	consumedBySummaryId?: string;
	citedBySummaryIds: string[];
	sourceEntryIds: string[];
	sourceEntries: Entry[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
};

export type RecalledSummary = {
	summary: Summary;
	summaryEntryId: string;
	summaryRecordIndex: number;
	visibility: MemoryVisibility;
	consumedBySummaryId?: string;
	citedBySummaryIds: string[];
	sourceMemoryIds: string[];
	consumedMemoryIds: string[];
	missingSourceMemoryIds: string[];
};

export type RecalledReviewResult = {
	review: ReviewResult;
	reviewEntryId: string;
	citedBySummaryIds: string[];
};

export type RecallResult =
	| {
			status: "not_found";
			memoryId: string;
			kind: undefined;
			summaries: [];
			reviews: [];
			observations: [];
			sourceEntries: [];
			missingSourceEntryIds: [];
			nonSourceEntryIds: [];
			missingSourceMemoryIds: [];
			collision: false;
			partial: false;
	  }
	| {
			status: "found";
			memoryId: string;
			kind: "observation" | "summary" | "review" | "mixed";
			summaries: RecalledSummary[];
			reviews: RecalledReviewResult[];
			observations: RecalledObservation[];
			sourceEntries: Entry[];
			missingSourceEntryIds: string[];
			nonSourceEntryIds: string[];
			missingSourceMemoryIds: string[];
			collision: boolean;
			partial: boolean;
	  };

type IndexedObservation = LedgerLocation & { observation: Observation };
type IndexedSummary = LedgerLocation & { summary: Summary };
type IndexedReviewResult = { review: ReviewResult; entryId: string; entryIndex: number };

function isSourceEntry(entry: Entry): boolean {
	return SOURCE_TYPES.has(entry.type);
}

function uniqueById(entries: Entry[]): Entry[] {
	const seen = new Set<string>();
	return entries.filter((entry) => {
		if (seen.has(entry.id)) return false;
		seen.add(entry.id);
		return true;
	});
}

function uniqueStrings(values: readonly string[]): string[] {
	return Array.from(new Set(values));
}

function indexLedger(entries: Entry[]): {
	observations: IndexedObservation[];
	summaries: IndexedSummary[];
	reviews: IndexedReviewResult[];
} {
	const observations: IndexedObservation[] = [];
	const summaries: IndexedSummary[] = [];
	const reviews: IndexedReviewResult[] = [];
	const observationKeys = new Set<string>();
	const summaryKeys = new Set<string>();
	const reviewKeys = new Set<string>();
	const addObservation = (observation: Observation, location: LedgerLocation): void => {
		const key = `${observation.id}:${uniqueStrings(observation.sourceEntryIds).sort().join(",")}`;
		if (observationKeys.has(key)) return;
		observationKeys.add(key);
		observations.push({ observation, ...location });
	};
	const addSummary = (summary: Summary, location: LedgerLocation): void => {
		const key = `${summary.id}:${summary.sourceMemoryIds.join(",")}:${summary.consumedMemoryIds.join(",")}`;
		if (summaryKeys.has(key)) return;
		summaryKeys.add(key);
		summaries.push({ summary, ...location });
	};
	const addReview = (review: ReviewResult, entryId: string, entryIndex: number): void => {
		if (reviewKeys.has(review.id)) return;
		reviewKeys.add(review.id);
		reviews.push({ review, entryId, entryIndex });
	};

	for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
		const entry = entries[entryIndex];
		if (entry.type === "compaction" && isMemoryDetails(entry.details)) {
			const archivedObservations = entry.details.archive?.observations ?? entry.details.observations;
			const archivedSummaries = entry.details.archive?.summaries ?? entry.details.summaries;
			archivedObservations.forEach((observation, recordIndex) => addObservation(observation, { entryId: entry.id, entryIndex, recordIndex }));
			archivedSummaries.forEach((summary, recordIndex) => addSummary(summary, { entryId: entry.id, entryIndex, recordIndex }));
			for (const review of entry.details.reviews ?? []) addReview(review, entry.id, entryIndex);
			continue;
		}
		if (isObservationsRecordedEntry(entry)) {
			entry.data.observations.forEach((observation, recordIndex) => addObservation(observation, { entryId: entry.id, entryIndex, recordIndex }));
			continue;
		}
		if (isSummarizerCommitEntry(entry)) {
			entry.data.summaries.forEach((summary, recordIndex) => addSummary(summary, { entryId: entry.id, entryIndex, recordIndex }));
			continue;
		}
		if (isReviewResultEntry(entry)) addReview(entry.data.result, entry.id, entryIndex);
	}
	return { observations, summaries, reviews };
}

function resolveObservationSources(entries: Entry[], indexed: IndexedObservation): Omit<RecalledObservation, "visibility" | "consumedBySummaryId" | "citedBySummaryIds"> {
	const sourceEntryIds = uniqueStrings(indexed.observation.sourceEntryIds);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const sourceEntries: Entry[] = [];
	const missingSourceEntryIds: string[] = [];
	const nonSourceEntryIds: string[] = [];
	for (const sourceEntryId of sourceEntryIds) {
		const sourceEntry = byId.get(sourceEntryId);
		if (!sourceEntry) missingSourceEntryIds.push(sourceEntryId);
		else if (!isSourceEntry(sourceEntry)) nonSourceEntryIds.push(sourceEntryId);
		else sourceEntries.push(sourceEntry);
	}
	return {
		observation: indexed.observation,
		observationEntryId: indexed.entryId,
		observationRecordIndex: indexed.recordIndex,
		sourceEntryIds,
		sourceEntries,
		missingSourceEntryIds,
		nonSourceEntryIds,
	};
}

function notFound(memoryId: string): RecallResult {
	return {
		status: "not_found",
		memoryId,
		kind: undefined,
		summaries: [],
		reviews: [],
		observations: [],
		sourceEntries: [],
		missingSourceEntryIds: [],
		nonSourceEntryIds: [],
		missingSourceMemoryIds: [],
		collision: false,
		partial: false,
	};
}

/** Recall exactly one graph node plus immediate backward/forward pointers. */
export function recallMemorySources(entries: Entry[], memoryId: string): RecallResult {
	const indexed = indexLedger(entries);
	const folded = foldLedger(entries);
	const observationMatches = indexed.observations.filter(({ observation }) => observation.id === memoryId);
	const summaryMatches = indexed.summaries.filter(({ summary }) => summary.id === memoryId);
	const reviewMatches = indexed.reviews.filter(({ review }) => review.id === memoryId);
	if (observationMatches.length === 0 && summaryMatches.length === 0 && reviewMatches.length === 0) return notFound(memoryId);

	const knownMemoryIds = new Set([
		...folded.observationsById.keys(),
		...folded.summariesById.keys(),
		...folded.reviewsById.keys(),
	]);
	const observations: RecalledObservation[] = observationMatches.map((match) => {
		const consumedBySummaryId = folded.consumedBySummaryId.get(match.observation.id);
		return {
			...resolveObservationSources(entries, match),
			visibility: consumedBySummaryId ? "summarized" : "visible",
			...(consumedBySummaryId ? { consumedBySummaryId } : {}),
			citedBySummaryIds: folded.citedBySummaryIds.get(match.observation.id) ?? [],
		};
	});
	const summaries: RecalledSummary[] = summaryMatches.map((match) => {
		const consumedBySummaryId = folded.consumedBySummaryId.get(match.summary.id);
		return {
			summary: match.summary,
			summaryEntryId: match.entryId,
			summaryRecordIndex: match.recordIndex,
			visibility: consumedBySummaryId ? "summarized" : "visible",
			...(consumedBySummaryId ? { consumedBySummaryId } : {}),
			citedBySummaryIds: folded.citedBySummaryIds.get(match.summary.id) ?? [],
			sourceMemoryIds: match.summary.sourceMemoryIds,
			consumedMemoryIds: match.summary.consumedMemoryIds,
			missingSourceMemoryIds: match.summary.sourceMemoryIds.filter((id) => !knownMemoryIds.has(id)),
		};
	});
	const reviews: RecalledReviewResult[] = reviewMatches.map(({ review, entryId }) => ({
		review,
		reviewEntryId: entryId,
		citedBySummaryIds: folded.citedBySummaryIds.get(review.id) ?? [],
	}));
	const sourceEntries = uniqueById(observations.flatMap((match) => match.sourceEntries));
	const missingSourceEntryIds = uniqueStrings(observations.flatMap((match) => match.missingSourceEntryIds));
	const nonSourceEntryIds = uniqueStrings(observations.flatMap((match) => match.nonSourceEntryIds));
	const missingSourceMemoryIds = uniqueStrings(summaries.flatMap((match) => match.missingSourceMemoryIds));
	const kinds = [observationMatches.length > 0, summaryMatches.length > 0, reviewMatches.length > 0].filter(Boolean).length;
	const matchCount = observationMatches.length + summaryMatches.length + reviewMatches.length;
	return {
		status: "found",
		memoryId,
		kind: kinds > 1 ? "mixed" : reviewMatches.length > 0 ? "review" : summaryMatches.length > 0 ? "summary" : "observation",
		summaries,
		reviews,
		observations,
		sourceEntries,
		missingSourceEntryIds,
		nonSourceEntryIds,
		missingSourceMemoryIds,
		collision: matchCount > 1,
		partial: missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0 || missingSourceMemoryIds.length > 0,
	};
}
