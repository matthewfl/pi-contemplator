import {
	isMemoryDetails,
	isObservationsRecordedEntry,
	isReviewResultEntry,
	isSummarizerCommitEntry,
	observationRetention,
	type Entry,
	type MemoryVisibility,
	type Relevance,
	type Retention,
	type ReviewOutcome,
	type ReviewScope,
} from "./types.js";
import { foldLedger } from "./fold.js";

export type MemorySearchResult = {
	kind: "observation" | "summary" | "review";
	id: string;
	content: string;
	relevance?: Relevance;
	retention?: Retention;
	timestamp?: string;
	visibility?: MemoryVisibility;
	consumedBySummaryId?: string;
	citedBySummaryIds?: string[];
	sourceMemoryIds?: string[];
	consumedMemoryIds?: string[];
	scope?: ReviewScope;
	outcome?: ReviewOutcome;
	title?: string;
	score: number;
};

export type MemorySearch = {
	query: string;
	results: MemorySearchResult[];
	observationsSearched: number;
	summariesSearched: number;
	reviewsSearched: number;
};

export type SearchMemoriesOptions = Record<string, never>;

type SearchCandidate = Omit<MemorySearchResult, "score"> & { sourceIndex: number };

const RELEVANCE_BOOST: Record<Relevance, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function normalizeSearchText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase();
}

function terms(value: string): string[] {
	return Array.from(new Set(normalizeSearchText(value).match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}_./:-]*/gu) ?? []));
}

function relevanceScore(content: string, query: string, queryTerms: string[]): number {
	const normalizedContent = normalizeSearchText(content);
	const phrase = normalizeSearchText(query.trim());
	const termMatches = queryTerms.reduce((total, term) => total + (normalizedContent.includes(term) ? 1 : 0), 0);
	const phraseBoost = phrase.length > 0 && normalizedContent.includes(phrase) ? 5 : 0;
	if (termMatches === 0 && phraseBoost === 0) return 0;
	return termMatches * 10 + phraseBoost;
}

function reviewSearchContent(review: ReturnType<typeof foldLedger>["reviews"][number]): string {
	return review.outcome === "proposal"
		? [review.scope, "proposal", review.title, review.summary, review.evidence, review.conceptualDesign].join("\n")
		: [review.scope, "review concluded with no proposal", review.reason, review.evidenceReviewed, review.reconsiderIf ?? ""].join("\n");
}

function sourceIndexes(entries: Entry[]): Map<string, number> {
	const indexes = new Map<string, number>();
	const add = (id: string, index: number): void => { if (!indexes.has(id)) indexes.set(id, index); };
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "compaction" && isMemoryDetails(entry.details)) {
			for (const memory of entry.details.archive?.observations ?? entry.details.observations) add(memory.id, index);
			for (const memory of entry.details.archive?.summaries ?? entry.details.summaries) add(memory.id, index);
			for (const review of entry.details.reviews ?? []) add(review.id, index);
			continue;
		}
		if (isObservationsRecordedEntry(entry)) for (const memory of entry.data.observations) add(memory.id, index);
		else if (isSummarizerCommitEntry(entry)) for (const memory of entry.data.summaries) add(memory.id, index);
		else if (isReviewResultEntry(entry)) add(entry.data.result.id, index);
	}
	return indexes;
}

function candidates(entries: Entry[]): {
	items: SearchCandidate[];
	observations: number;
	summaries: number;
	reviews: number;
} {
	const folded = foldLedger(entries);
	const indexes = sourceIndexes(entries);
	const items: SearchCandidate[] = [];

	for (const observation of folded.observations) {
		const consumedBySummaryId = folded.consumedBySummaryId.get(observation.id);
		items.push({
			kind: "observation",
			id: observation.id,
			content: observation.content,
			relevance: observation.relevance,
			retention: observationRetention(observation),
			timestamp: observation.timestamp,
			visibility: consumedBySummaryId ? "summarized" : "visible",
			...(consumedBySummaryId ? { consumedBySummaryId } : {}),
			citedBySummaryIds: folded.citedBySummaryIds.get(observation.id) ?? [],
			sourceIndex: indexes.get(observation.id) ?? 0,
		});
	}
	for (const summary of folded.summaries) {
		const consumedBySummaryId = folded.consumedBySummaryId.get(summary.id);
		items.push({
			kind: "summary",
			id: summary.id,
			content: summary.content,
			visibility: consumedBySummaryId ? "summarized" : "visible",
			...(consumedBySummaryId ? { consumedBySummaryId } : {}),
			citedBySummaryIds: folded.citedBySummaryIds.get(summary.id) ?? [],
			sourceMemoryIds: summary.sourceMemoryIds,
			consumedMemoryIds: summary.consumedMemoryIds,
			sourceIndex: indexes.get(summary.id) ?? 0,
		});
	}
	for (const review of folded.reviews) {
		items.push({
			kind: "review",
			id: review.id,
			content: reviewSearchContent(review),
			citedBySummaryIds: folded.citedBySummaryIds.get(review.id) ?? [],
			scope: review.scope,
			outcome: review.outcome,
			title: review.outcome === "proposal" ? review.title : undefined,
			sourceIndex: indexes.get(review.id) ?? 0,
		});
	}
	return { items, observations: folded.observations.length, summaries: folded.summaries.length, reviews: folded.reviews.length };
}

export function searchMemories(entries: Entry[], query: string, limit = 8, _options: SearchMemoriesOptions = {}): MemorySearch {
	const normalizedQuery = query.trim();
	const queryTerms = terms(normalizedQuery);
	const searched = candidates(entries);
	const results = searched.items
		.map((candidate): MemorySearchResult | undefined => {
			const lexical = relevanceScore(candidate.content, normalizedQuery, queryTerms);
			if (lexical === 0) return undefined;
			const relevanceBoost = candidate.relevance ? RELEVANCE_BOOST[candidate.relevance] : 0;
			const kindBoost = candidate.kind === "summary" ? 3 : 0;
			const recencyBoost = Math.min(candidate.sourceIndex / Math.max(entries.length, 1), 1);
			const { sourceIndex: _sourceIndex, ...result } = candidate;
			return { ...result, score: lexical + relevanceBoost + kindBoost + recencyBoost };
		})
		.filter((result): result is MemorySearchResult => result !== undefined)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, Math.max(1, Math.min(20, Math.floor(limit))));

	return {
		query: normalizedQuery,
		results,
		observationsSearched: searched.observations,
		summariesSearched: searched.summaries,
		reviewsSearched: searched.reviews,
	};
}
