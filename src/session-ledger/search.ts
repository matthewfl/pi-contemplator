import {
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	isReviewResultEntry,
	type Entry,
	type Relevance,
	type ReviewOutcome,
	type ReviewScope,
} from "./types.js";

export type MemorySearchResult = {
	kind: "observation" | "reflection" | "review";
	id: string;
	content: string;
	relevance?: Relevance;
	timestamp?: string;
	status?: "active" | "dropped";
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

type SearchCandidate = Omit<MemorySearchResult, "score"> & {
	sourceIndex: number;
};

const RELEVANCE_BOOST: Record<Relevance, number> = {
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

function normalizeSearchText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase();
}

function terms(value: string): string[] {
	return Array.from(
		new Set(normalizeSearchText(value).match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}_./:-]*/gu) ?? []),
	);
}

function relevanceScore(
	content: string,
	query: string,
	queryTerms: string[],
): number {
	const normalizedContent = normalizeSearchText(content);
	const phrase = normalizeSearchText(query.trim());
	const termMatches = queryTerms.reduce(
		(total, term) => total + (normalizedContent.includes(term) ? 1 : 0),
		0,
	);
	const phraseBoost =
		phrase.length > 0 && normalizedContent.includes(phrase) ? 5 : 0;
	if (termMatches === 0 && phraseBoost === 0) return 0;
	return termMatches * 10 + phraseBoost;
}

function candidates(entries: Entry[]): {
	items: SearchCandidate[];
	observations: number;
	reflections: number;
	reviews: number;
} {
	const dropped = new Set<string>();
	for (const entry of entries) {
		if (isObservationsDroppedEntry(entry)) {
			for (const id of entry.data.observationIds) dropped.add(id);
		}
	}

	const items: SearchCandidate[] = [];
	let observations = 0;
	let reflections = 0;
	let reviews = 0;
	for (let sourceIndex = 0; sourceIndex < entries.length; sourceIndex++) {
		const entry = entries[sourceIndex];
		if (isObservationsRecordedEntry(entry)) {
			observations += entry.data.observations.length;
			for (const observation of entry.data.observations) {
				items.push({
					kind: "observation",
					id: observation.id,
					content: observation.content,
					relevance: observation.relevance,
					timestamp: observation.timestamp,
					status: dropped.has(observation.id) ? "dropped" : "active",
					sourceIndex,
				});
			}
		}
		if (isReflectionsRecordedEntry(entry)) {
			reflections += entry.data.reflections.length;
			for (const reflection of entry.data.reflections) {
				items.push({
					kind: "reflection",
					id: reflection.id,
					content: reflection.content,
					sourceIndex,
				});
			}
			continue;
		}
		if (isReviewResultEntry(entry)) {
			const review = entry.data.result;
			reviews++;
			const content = review.outcome === "proposal"
				? [review.scope, "proposal", review.title, review.summary, review.evidence, review.conceptualDesign].join("\n")
				: [review.scope, "review concluded with no proposal", review.reason, review.evidenceReviewed, review.reconsiderIf ?? ""].join("\n");
			items.push({
				kind: "review",
				id: review.id,
				content,
				scope: review.scope,
				outcome: review.outcome,
				title: review.outcome === "proposal" ? review.title : undefined,
				sourceIndex,
			});
		}
	}
	return { items, observations, reflections, reviews };
}

export function searchMemories(
	entries: Entry[],
	query: string,
	limit = 8,
): MemorySearch {
	const normalizedQuery = query.trim();
	const queryTerms = terms(normalizedQuery);
	const searched = candidates(entries);
	const results = searched.items
		.map((candidate): MemorySearchResult | undefined => {
			const lexical = relevanceScore(
				candidate.content,
				normalizedQuery,
				queryTerms,
			);
			if (lexical === 0) return undefined;
			const relevanceBoost = candidate.relevance
				? RELEVANCE_BOOST[candidate.relevance]
				: 0;
			const kindBoost = candidate.kind === "reflection" ? 3 : 0;
			const recencyBoost = Math.min(
				candidate.sourceIndex / Math.max(entries.length, 1),
				1,
			);
			return {
				kind: candidate.kind,
				id: candidate.id,
				content: candidate.content,
				relevance: candidate.relevance,
				timestamp: candidate.timestamp,
				status: candidate.status,
				scope: candidate.scope,
				outcome: candidate.outcome,
				title: candidate.title,
				score: lexical + relevanceBoost + kindBoost + recencyBoost,
			} satisfies MemorySearchResult;
		})
		.filter((result): result is MemorySearchResult => result !== undefined)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, Math.max(1, Math.min(20, Math.floor(limit))));

	return {
		query: normalizedQuery,
		results,
		observationsSearched: searched.observations,
		reflectionsSearched: searched.reflections,
		reviewsSearched: searched.reviews,
	};
}
