import {
	isReviewResultEntry,
	observationRetention,
	type Entry,
	type MemoryStatus,
	type Relevance,
	type Retention,
	type ReviewOutcome,
	type ReviewScope,
} from "./types.js";
import { foldLedger } from "./fold.js";

export type MemorySearchResult = {
	kind: "observation" | "reflection" | "review";
	id: string;
	content: string;
	relevance?: Relevance;
	retention?: Retention;
	timestamp?: string;
	status?: MemoryStatus;
	deleteReason?: string;
	recallIf?: string;
	mergedInto?: string[];
	replacedBy?: string[];
	scope?: ReviewScope;
	outcome?: ReviewOutcome;
	title?: string;
	score: number;
};

export type MemorySearch = {
	query: string;
	results: MemorySearchResult[];
	observationsSearched: number;
	reflectionsSearched: number;
	reviewsSearched: number;
};

export type SearchMemoriesOptions = {
	/** Expose inactive status/cues only inside the librarian. */
	librarian?: boolean;
};

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

function candidates(entries: Entry[], options: SearchMemoriesOptions): {
	items: SearchCandidate[];
	observations: number;
	reflections: number;
	reviews: number;
} {
	const folded = foldLedger(entries);
	const sourceIndexByMemoryId = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) {
		const data = entries[i]?.data as { observations?: Array<{ id?: string }>; reflections?: Array<{ id?: string }> } | undefined;
		for (const item of [...(data?.observations ?? []), ...(data?.reflections ?? [])]) {
			if (typeof item.id === "string" && !sourceIndexByMemoryId.has(item.id)) sourceIndexByMemoryId.set(item.id, i);
		}
	}

	const items: SearchCandidate[] = [];
	for (const observation of folded.observations) {
		const lifecycle = folded.lifecycleByMemoryId.get(observation.id);
		const actualStatus = lifecycle?.status ?? "active";
		items.push({
			kind: "observation",
			id: observation.id,
			content: observation.content,
			relevance: observation.relevance,
			retention: observationRetention(observation),
			timestamp: observation.timestamp,
			status: actualStatus === "inactive" && !options.librarian ? "active" : actualStatus,
			...(actualStatus === "deleted" && lifecycle?.reason ? { deleteReason: lifecycle.reason } : {}),
			...(actualStatus === "inactive" && options.librarian && lifecycle?.recallIf ? { recallIf: lifecycle.recallIf } : {}),
			mergedInto: folded.mergedIntoByMemoryId.get(observation.id),
			replacedBy: folded.replacedByMemoryId.get(observation.id),
			sourceIndex: sourceIndexByMemoryId.get(observation.id) ?? 0,
		});
	}
	for (const reflection of folded.reflections) {
		const lifecycle = folded.lifecycleByMemoryId.get(reflection.id);
		const actualStatus = lifecycle?.status ?? "active";
		items.push({
			kind: "reflection",
			id: reflection.id,
			content: reflection.content,
			status: actualStatus === "inactive" && !options.librarian ? "active" : actualStatus,
			...(actualStatus === "deleted" && lifecycle?.reason ? { deleteReason: lifecycle.reason } : {}),
			...(actualStatus === "inactive" && options.librarian && lifecycle?.recallIf ? { recallIf: lifecycle.recallIf } : {}),
			mergedInto: folded.mergedIntoByMemoryId.get(reflection.id),
			replacedBy: folded.replacedByMemoryId.get(reflection.id),
			sourceIndex: sourceIndexByMemoryId.get(reflection.id) ?? 0,
		});
	}

	let reviews = 0;
	for (let sourceIndex = 0; sourceIndex < entries.length; sourceIndex++) {
		const entry = entries[sourceIndex];
		if (!isReviewResultEntry(entry)) continue;
		const review = entry.data.result;
		reviews++;
		const content = review.outcome === "proposal"
			? [review.scope, "proposal", review.title, review.summary, review.evidence, review.conceptualDesign].join("\n")
			: [review.scope, "review concluded with no proposal", review.reason, review.evidenceReviewed, review.reconsiderIf ?? ""].join("\n");
		items.push({ kind: "review", id: review.id, content, scope: review.scope, outcome: review.outcome, title: review.outcome === "proposal" ? review.title : undefined, sourceIndex });
	}

	return { items, observations: folded.observations.length, reflections: folded.reflections.length, reviews };
}

export function searchMemories(entries: Entry[], query: string, limit = 8, options: SearchMemoriesOptions = {}): MemorySearch {
	const normalizedQuery = query.trim();
	const queryTerms = terms(normalizedQuery);
	const searched = candidates(entries, options);
	const results = searched.items
		.map((candidate): MemorySearchResult | undefined => {
			const lexical = relevanceScore(candidate.content, normalizedQuery, queryTerms);
			if (lexical === 0) return undefined;
			const relevanceBoost = candidate.relevance ? RELEVANCE_BOOST[candidate.relevance] : 0;
			const kindBoost = candidate.kind === "reflection" ? 3 : 0;
			const recencyBoost = Math.min(candidate.sourceIndex / Math.max(entries.length, 1), 1);
			const { sourceIndex: _sourceIndex, ...result } = candidate;
			return { ...result, score: lexical + relevanceBoost + kindBoost + recencyBoost };
		})
		.filter((result): result is MemorySearchResult => result !== undefined)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, Math.max(1, Math.min(20, Math.floor(limit))));

	return { query: normalizedQuery, results, observationsSearched: searched.observations, reflectionsSearched: searched.reflections, reviewsSearched: searched.reviews };
}
