import {
	isMemoryDetails,
	OM_LIBRARIAN_COMMIT,
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	isReviewResultEntry,
	type Entry,
	type Observation,
	type Reflection,
	type ReviewResult,
} from "./types.js";
import { foldLedger } from "./fold.js";

const SOURCE_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export type { Entry, Observation, Reflection };

type ObservationLedgerLocation = {
	entryId: string;
	entryIndex: number;
	recordIndex: number;
};

type ReflectionLedgerLocation = {
	entryId: string;
	entryIndex: number;
	recordIndex: number;
};

export type RecalledObservation = {
	observation: Observation;
	observationEntryId: string;
	observationRecordIndex: number;
	status: "active" | "inactive" | "deleted";
	deleteReason?: string;
	recallIf?: string;
	sourceEntryIds: string[];
	sourceEntries: Entry[];
	missingSourceEntryIds: string[];
	nonSourceEntryIds: string[];
};

export type RecalledReflection = {
	reflection: Reflection;
	reflectionEntryId: string;
	reflectionRecordIndex: number;
	status: "active" | "inactive" | "deleted";
	deleteReason?: string;
	recallIf?: string;
	mergedInto: string[];
	replacedBy: string[];
};

export type RecalledReviewResult = {
	review: ReviewResult;
	reviewEntryId: string;
};

export type RecallResult =
	| {
			status: "not_found";
			memoryId: string;
			kind: undefined;
			reflections: [];
			reviews: [];
			observations: [];
			sourceEntries: [];
			missingSourceEntryIds: [];
			nonSourceEntryIds: [];
			missingSupportingObservationIds: [];
			collision: false;
			partial: false;
	  }
	| {
			status: "found";
			memoryId: string;
			kind: "observation" | "reflection" | "review" | "mixed";
			reflections: RecalledReflection[];
			reviews: RecalledReviewResult[];
			observations: RecalledObservation[];
			sourceEntries: Entry[];
			missingSourceEntryIds: string[];
			nonSourceEntryIds: string[];
			missingSupportingObservationIds: string[];
			collision: boolean;
			partial: boolean;
	  };

type IndexedObservation = ObservationLedgerLocation & { observation: Observation };
type IndexedReflection = ReflectionLedgerLocation & { reflection: Reflection };
type IndexedReviewResult = { review: ReviewResult; entryId: string };

function isSourceEntry(entry: Entry): boolean {
	return SOURCE_TYPES.has(entry.type);
}

function uniqueById(entries: Entry[]): Entry[] {
	const seen = new Set<string>();
	const result: Entry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		result.push(entry);
	}
	return result;
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

function indexLedger(entries: Entry[]): {
	observations: IndexedObservation[];
	reflections: IndexedReflection[];
	reviews: IndexedReviewResult[];
} {
	const observations: IndexedObservation[] = [];
	const reflections: IndexedReflection[] = [];
	const reviews: IndexedReviewResult[] = [];
	// Deduplicate snapshots/retries of the same record without collapsing true
	// content-address collisions that point at different source evidence.
	const observationKeys = new Set<string>();
	const reflectionKeys = new Set<string>();
	const observationKey = (observation: Observation) => `${observation.id}:${uniqueStrings(observation.sourceEntryIds).sort().join(",")}`;
	const reflectionKey = (reflection: Reflection) => `${reflection.id}:${uniqueStrings(reflection.sourceMemoryIds ?? reflection.supportingObservationIds).sort().join(",")}`;

	for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
		const entry = entries[entryIndex];
		if (entry.type === "compaction" && isMemoryDetails(entry.details) && entry.details.archive) {
			entry.details.archive.observations.forEach((observation, recordIndex) => {
				const key = observationKey(observation);
				if (observationKeys.has(key)) return;
				observationKeys.add(key);
				observations.push({ observation, entryId: entry.id, entryIndex, recordIndex });
			});
			entry.details.archive.reflections.forEach((reflection, recordIndex) => {
				const key = reflectionKey(reflection);
				if (reflectionKeys.has(key)) return;
				reflectionKeys.add(key);
				reflections.push({ reflection, entryId: entry.id, entryIndex, recordIndex });
			});
			continue;
		}
		if (isObservationsRecordedEntry(entry)) {
			entry.data.observations.forEach((observation, recordIndex) => {
				const key = observationKey(observation);
				if (observationKeys.has(key)) return;
				observationKeys.add(key);
				observations.push({ observation, entryId: entry.id, entryIndex, recordIndex });
			});
			continue;
		}
		if (isReflectionsRecordedEntry(entry) || (entry.type === "custom" && entry.customType === OM_LIBRARIAN_COMMIT && entry.data && typeof entry.data === "object" && Array.isArray((entry.data as { reflections?: unknown }).reflections))) {
			const records = isReflectionsRecordedEntry(entry) ? entry.data.reflections : (entry.data as { reflections: Reflection[] }).reflections;
			records.forEach((reflection, recordIndex) => {
				const key = reflectionKey(reflection);
				if (reflectionKeys.has(key)) return;
				reflectionKeys.add(key);
				reflections.push({ reflection, entryId: entry.id, entryIndex, recordIndex });
			});
			continue;
		}
		if (isObservationsDroppedEntry(entry)) continue;
		if (isReviewResultEntry(entry)) reviews.push({ review: entry.data.result, entryId: entry.id });
	}

	return { observations, reflections, reviews };
}

function resolveObservationSources(entries: Entry[], observation: Observation, location: ObservationLedgerLocation): RecalledObservation {
	const sourceEntryIds = uniqueStrings(observation.sourceEntryIds);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const sourceEntries: Entry[] = [];
	const missingSourceEntryIds: string[] = [];
	const nonSourceEntryIds: string[] = [];

	for (const sourceEntryId of sourceEntryIds) {
		const sourceEntry = byId.get(sourceEntryId);
		if (!sourceEntry) {
			missingSourceEntryIds.push(sourceEntryId);
			continue;
		}
		if (!isSourceEntry(sourceEntry)) {
			nonSourceEntryIds.push(sourceEntryId);
			continue;
		}
		sourceEntries.push(sourceEntry);
	}

	return {
		observation,
		observationEntryId: location.entryId,
		observationRecordIndex: location.recordIndex,
		status: "active",
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
		reflections: [],
		reviews: [],
		observations: [],
		sourceEntries: [],
		missingSourceEntryIds: [],
		nonSourceEntryIds: [],
		missingSupportingObservationIds: [],
		collision: false,
		partial: false,
	};
}

export function recallMemorySources(entries: Entry[], memoryId: string): RecallResult {
	const { observations: indexedObservations, reflections: indexedReflections, reviews: indexedReviews } = indexLedger(entries);
	const folded = foldLedger(entries);
	const directObservationMatches = indexedObservations.filter(({ observation }) => observation.id === memoryId);
	const reflectionMatches = indexedReflections.filter(({ reflection }) => reflection.id === memoryId);
	const reviewMatches = indexedReviews.filter(({ review }) => review.id === memoryId);

	if (directObservationMatches.length === 0 && reflectionMatches.length === 0 && reviewMatches.length === 0) return notFound(memoryId);

	const observationsById = new Map<string, IndexedObservation>();
	for (const indexed of indexedObservations) {
		if (!observationsById.has(indexed.observation.id)) observationsById.set(indexed.observation.id, indexed);
	}

	const recalledByKey = new Map<string, RecalledObservation>();
	const missingSupportingObservationIds: string[] = [];

	function addObservation(indexed: IndexedObservation): void {
		const key = `${indexed.entryId}:${indexed.recordIndex}`;
		if (recalledByKey.has(key)) return;
		const recalled = resolveObservationSources(entries, indexed.observation, indexed);
		const lifecycle = folded.lifecycleByMemoryId.get(indexed.observation.id);
		recalled.status = lifecycle?.status ?? "active";
		recalled.deleteReason = lifecycle?.reason;
		recalled.recallIf = lifecycle?.recallIf;
		recalledByKey.set(key, recalled);
	}

	for (const match of directObservationMatches) addObservation(match);

	const reflectionsById = new Map(indexedReflections.map((indexed) => [indexed.reflection.id, indexed]));
	const includedReflections = new Map(reflectionMatches.map((indexed) => [indexed.reflection.id, indexed]));
	for (const { reflection } of reflectionMatches) {
		for (const sourceId of uniqueStrings(reflection.sourceMemoryIds ?? reflection.supportingObservationIds)) {
			const sourceReflection = reflectionsById.get(sourceId);
			if (sourceReflection) {
				includedReflections.set(sourceReflection.reflection.id, sourceReflection);
				continue;
			}
			const observationId = sourceId;
			const indexed = observationsById.get(observationId);
			if (!indexed) {
				missingSupportingObservationIds.push(observationId);
				continue;
			}
			addObservation(indexed);
		}
	}

	const recalledObservations = Array.from(recalledByKey.values());
	const recalledReflections: RecalledReflection[] = Array.from(includedReflections.values()).map(({ reflection, entryId, recordIndex }) => {
		const lifecycle = folded.lifecycleByMemoryId.get(reflection.id);
		return {
			reflection,
			reflectionEntryId: entryId,
			reflectionRecordIndex: recordIndex,
			status: lifecycle?.status ?? "active",
			deleteReason: lifecycle?.reason,
			recallIf: lifecycle?.recallIf,
			mergedInto: folded.mergedIntoByMemoryId.get(reflection.id) ?? [],
			replacedBy: folded.replacedByMemoryId.get(reflection.id) ?? [],
		};
	});
	const recalledReviews: RecalledReviewResult[] = reviewMatches.map(({ review, entryId }) => ({ review, reviewEntryId: entryId }));
	const sourceEntries = uniqueById(recalledObservations.flatMap((match) => match.sourceEntries));
	const missingSourceEntryIds = uniqueStrings(recalledObservations.flatMap((match) => match.missingSourceEntryIds));
	const nonSourceEntryIds = uniqueStrings(recalledObservations.flatMap((match) => match.nonSourceEntryIds));
	const uniqueMissingSupportingObservationIds = uniqueStrings(missingSupportingObservationIds);
	const matchCount = directObservationMatches.length + reflectionMatches.length + reviewMatches.length;
	const kinds = [directObservationMatches.length > 0, reflectionMatches.length > 0, reviewMatches.length > 0].filter(Boolean).length;

	return {
		status: "found",
		memoryId,
		kind: kinds > 1
			? "mixed"
			: reviewMatches.length > 0
				? "review"
				: reflectionMatches.length > 0
					? "reflection"
					: "observation",
		reflections: recalledReflections,
		reviews: recalledReviews,
		observations: recalledObservations,
		sourceEntries,
		missingSourceEntryIds,
		nonSourceEntryIds,
		missingSupportingObservationIds: uniqueMissingSupportingObservationIds,
		collision: matchCount > 1,
		partial: missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0 || uniqueMissingSupportingObservationIds.length > 0,
	};
}
