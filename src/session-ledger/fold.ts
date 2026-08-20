import {
	isMemoryDetails,
	isObservationsRecordedData,
	isReviewResultEntry,
	isSummarizerCommitData,
	OM_OBSERVATIONS_RECORDED,
	OM_REVIEW_RESULT,
	OM_SUMMARIZER_COMMIT,
	type Entry,
	type Observation,
	type ReviewResult,
	type Summary,
} from "./types.js";

export type FoldLedgerOptions = {
	/** Fold entries from branch root through this entry id, inclusive. Omit to fold through branch tip. */
	upToEntryId?: string;
};

export type FoldedLedger = {
	/** All first-valid durable observation records through the fold boundary. */
	observations: Observation[];
	activeObservations: Observation[];
	/** All first-valid durable summary records through the fold boundary. */
	summaries: Summary[];
	activeSummaries: Summary[];
	observationsById: Map<string, Observation>;
	summariesById: Map<string, Summary>;
	/** Source -> every summary that cites it, including non-consuming citations. */
	citedBySummaryIds: Map<string, string[]>;
	/** Source -> the first summary that removed it from automatic visibility. */
	consumedBySummaryId: Map<string, string>;
	reviews: ReviewResult[];
	reviewsById: Map<string, ReviewResult>;
};

function foldEndIndex(entries: Entry[], upToEntryId: string | undefined): number {
	if (!upToEntryId) return entries.length - 1;
	const idx = entries.findIndex((entry) => entry.id === upToEntryId);
	return idx === -1 ? entries.length - 1 : idx;
}

function isCustomEntry(entry: Entry, customType: string): boolean {
	return entry.type === "custom" && entry.customType === customType;
}

function appendUnique(map: Map<string, string[]>, key: string, value: string): void {
	const existing = map.get(key);
	if (!existing) {
		map.set(key, [value]);
		return;
	}
	if (!existing.includes(value)) existing.push(value);
}

/**
 * Fold the append-only memory graph through a branch boundary.
 *
 * Summary bodies occur once. Visibility and forward pointers are derived from
 * their source/consumption edges. Compaction archives seed the same graph when
 * older custom records are no longer present on the current branch.
 */
export function foldLedger(entries: Entry[], options: FoldLedgerOptions = {}): FoldedLedger {
	const observationsById = new Map<string, Observation>();
	const summariesById = new Map<string, Summary>();
	const reviewsById = new Map<string, ReviewResult>();
	const citedBySummaryIds = new Map<string, string[]>();
	const consumedBySummaryId = new Map<string, string>();
	const endIdx = foldEndIndex(entries, options.upToEntryId);

	const registerObservation = (observation: Observation): void => {
		if (!observationsById.has(observation.id)) observationsById.set(observation.id, observation);
	};
	const registerReview = (review: ReviewResult): void => {
		if (!reviewsById.has(review.id)) reviewsById.set(review.id, review);
	};
	const registerSummaryNodes = (summaries: readonly Summary[]): Summary[] => {
		const newlyRegistered: Summary[] = [];
		for (const summary of summaries) {
			if (summariesById.has(summary.id)) continue;
			summariesById.set(summary.id, summary);
			newlyRegistered.push(summary);
		}
		return newlyRegistered;
	};
	const registerSummaryEdges = (summaries: readonly Summary[]): void => {
		for (const summary of summaries) {
			for (const sourceId of summary.sourceMemoryIds) appendUnique(citedBySummaryIds, sourceId, summary.id);
			for (const sourceId of summary.consumedMemoryIds) {
				// Reviews are deliberately non-consumable. Unknown/corrupt edges also
				// cannot hide a node. The first valid consumer wins.
				if (!observationsById.has(sourceId) && !summariesById.has(sourceId)) continue;
				if (!consumedBySummaryId.has(sourceId)) consumedBySummaryId.set(sourceId, summary.id);
			}
		}
	};

	for (let i = 0; i <= endIdx; i++) {
		const entry = entries[i];
		if (!entry) continue;

		if (entry.type === "compaction" && isMemoryDetails(entry.details)) {
			const archivedObservations = entry.details.archive?.observations ?? entry.details.observations;
			const archivedSummaries = entry.details.archive?.summaries ?? entry.details.summaries;
			for (const observation of archivedObservations) registerObservation(observation);
			for (const review of entry.details.reviews ?? []) registerReview(review);
			const registered = registerSummaryNodes(archivedSummaries);
			registerSummaryEdges(registered);
			continue;
		}

		if (isCustomEntry(entry, OM_OBSERVATIONS_RECORDED)) {
			if (!isObservationsRecordedData(entry.data)) continue;
			for (const observation of entry.data.observations) registerObservation(observation);
			continue;
		}

		if (isCustomEntry(entry, OM_SUMMARIZER_COMMIT)) {
			if (!isSummarizerCommitData(entry.data)) continue;
			// Register every node before edges so same-commit citation targets are
			// addressable. The summarizer itself prevents consuming same-run nodes.
			const registered = registerSummaryNodes(entry.data.summaries);
			registerSummaryEdges(registered);
			continue;
		}

		if (entry.customType === OM_REVIEW_RESULT && isReviewResultEntry(entry)) registerReview(entry.data.result);
	}

	const observations = Array.from(observationsById.values());
	const summaries = Array.from(summariesById.values());
	return {
		observations,
		activeObservations: observations.filter((memory) => !consumedBySummaryId.has(memory.id)),
		summaries,
		activeSummaries: summaries.filter((memory) => !consumedBySummaryId.has(memory.id)),
		observationsById,
		summariesById,
		citedBySummaryIds,
		consumedBySummaryId,
		reviews: Array.from(reviewsById.values()),
		reviewsById,
	};
}
