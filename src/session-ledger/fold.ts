import {
	isLibrarianCommitData,
	isMemoryDetails,
	isObservationsDroppedData,
	isObservationsRecordedData,
	isReflectionsRecordedData,
	OM_LIBRARIAN_COMMIT,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	OM_REVIEW_RESULT,
	isReviewResultEntry,
	type Entry,
	type MemoryLifecycleAction,
	type MemoryStatus,
	type Observation,
	type Reflection,
	type ReviewResult,
} from "./types.js";

export type FoldLedgerOptions = {
	/** Fold entries from branch root through this entry id, inclusive. Omit to fold through branch tip. */
	upToEntryId?: string;
};

export type MemoryLifecycleState = {
	status: MemoryStatus;
	recallIf?: string;
	reason?: string;
	becauseOfMemoryIds: string[];
	replacementMemoryIds: string[];
	lastAction?: MemoryLifecycleAction["type"] | "legacyDrop";
	changedAt?: number;
};

export type FoldedLedger = {
	/** All first-valid observation records encountered through the fold boundary, including inactive/deleted observations. */
	observations: Observation[];
	activeObservations: Observation[];
	inactiveObservations: Observation[];
	deletedObservations: Observation[];
	/** Legacy alias retained for callers and old status output. */
	droppedObservationIds: Set<string>;
	/** All first-valid reflection records encountered through the fold boundary. */
	reflections: Reflection[];
	activeReflections: Reflection[];
	inactiveReflections: Reflection[];
	deletedReflections: Reflection[];
	observationsById: Map<string, Observation>;
	reflectionsById: Map<string, Reflection>;
	memoryStatusById: Map<string, MemoryStatus>;
	lifecycleByMemoryId: Map<string, MemoryLifecycleState>;
	/** Direct source -> reflection consolidation pointers. */
	mergedIntoByMemoryId: Map<string, string[]>;
	/** Deleted memory -> replacement pointers. */
	replacedByMemoryId: Map<string, string[]>;
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

function appendUnique(map: Map<string, string[]>, key: string, values: readonly string[]): void {
	const existing = map.get(key) ?? [];
	const seen = new Set(existing);
	for (const value of values) if (!seen.has(value)) {
		seen.add(value);
		existing.push(value);
	}
	map.set(key, existing);
}

function activeState(): MemoryLifecycleState {
	return { status: "active", becauseOfMemoryIds: [], replacementMemoryIds: [] };
}

function applyAction(
	action: MemoryLifecycleAction,
	knownIds: Set<string>,
	states: Map<string, MemoryLifecycleState>,
	replacedByMemoryId: Map<string, string[]>,
): void {
	for (const memoryId of action.memoryIds) {
		if (!knownIds.has(memoryId)) continue;
		const prior = states.get(memoryId) ?? activeState();
		if (action.type === "makeInactive") {
			if (prior.status !== "active") continue;
			states.set(memoryId, {
				status: "inactive",
				recallIf: action.recallIf,
				becauseOfMemoryIds: [...action.becauseOfMemoryIds],
				replacementMemoryIds: prior.replacementMemoryIds,
				lastAction: action.type,
				changedAt: action.createdAt,
			});
			continue;
		}
		if (action.type === "makeActive") {
			if (prior.status !== "inactive") continue;
			states.set(memoryId, {
				status: "active",
				becauseOfMemoryIds: [...action.becauseOfMemoryIds],
				replacementMemoryIds: prior.replacementMemoryIds,
				lastAction: action.type,
				changedAt: action.createdAt,
			});
			continue;
		}
		if (prior.status === "deleted") continue;
		appendUnique(replacedByMemoryId, memoryId, action.replacementMemoryIds);
		states.set(memoryId, {
			status: "deleted",
			reason: action.reason,
			becauseOfMemoryIds: [...action.becauseOfMemoryIds],
			replacementMemoryIds: [...action.replacementMemoryIds],
			lastAction: action.type,
			changedAt: action.createdAt,
		});
	}
}

/**
 * Fold valid memory entries from the branch root through the target entry.
 *
 * Old V3 reflection/drop records remain readable. New librarian commits are
 * atomic: their reflections are registered before their lifecycle actions are
 * applied, so a source deletion can point at a reflection from the same entry.
 */
export function foldLedger(entries: Entry[], options: FoldLedgerOptions = {}): FoldedLedger {
	const observationsById = new Map<string, Observation>();
	const reflectionsById = new Map<string, Reflection>();
	const reviewsById = new Map<string, ReviewResult>();
	const states = new Map<string, MemoryLifecycleState>();
	const mergedIntoByMemoryId = new Map<string, string[]>();
	const replacedByMemoryId = new Map<string, string[]>();
	const legacyDroppedIds = new Set<string>();
	const endIdx = foldEndIndex(entries, options.upToEntryId);

	const registerReflection = (reflection: Reflection): void => {
		if (reflectionsById.has(reflection.id)) return;
		reflectionsById.set(reflection.id, reflection);
		states.set(reflection.id, activeState());
		for (const sourceId of reflection.sourceMemoryIds ?? reflection.supportingObservationIds) {
			appendUnique(mergedIntoByMemoryId, sourceId, [reflection.id]);
		}
	};

	for (let i = 0; i <= endIdx; i++) {
		const entry = entries[i];
		if (!entry) continue;

		// Compaction snapshots provide compatibility when older custom records are
		// no longer on the active branch. Version-1 details contain active records.
		if (entry.type === "compaction" && isMemoryDetails(entry.details)) {
			const archivedObservations = entry.details.archive?.observations ?? entry.details.observations;
			const archivedReflections = entry.details.archive?.reflections ?? entry.details.reflections;
			for (const observation of archivedObservations) if (!observationsById.has(observation.id)) {
				observationsById.set(observation.id, observation);
				states.set(observation.id, activeState());
			}
			for (const reflection of archivedReflections) registerReflection(reflection);
			for (const snapshot of entry.details.archive?.lifecycle ?? []) {
				if (!observationsById.has(snapshot.memoryId) && !reflectionsById.has(snapshot.memoryId)) continue;
				states.set(snapshot.memoryId, {
					status: snapshot.status,
					recallIf: snapshot.recallIf,
					reason: snapshot.reason,
					becauseOfMemoryIds: [...snapshot.becauseOfMemoryIds],
					replacementMemoryIds: [...snapshot.replacementMemoryIds],
					changedAt: snapshot.changedAt,
				});
				appendUnique(replacedByMemoryId, snapshot.memoryId, snapshot.replacementMemoryIds);
			}
			for (const review of entry.details.reviews ?? []) if (!reviewsById.has(review.id)) reviewsById.set(review.id, review);
			continue;
		}

		if (isCustomEntry(entry, OM_OBSERVATIONS_RECORDED)) {
			if (!isObservationsRecordedData(entry.data)) continue;
			for (const observation of entry.data.observations) if (!observationsById.has(observation.id)) {
				observationsById.set(observation.id, observation);
				states.set(observation.id, activeState());
			}
			continue;
		}

		if (isCustomEntry(entry, OM_REFLECTIONS_RECORDED)) {
			if (!isReflectionsRecordedData(entry.data)) continue;
			for (const reflection of entry.data.reflections) registerReflection(reflection);
			continue;
		}

		if (isCustomEntry(entry, OM_OBSERVATIONS_DROPPED)) {
			if (!isObservationsDroppedData(entry.data)) continue;
			for (const observationId of entry.data.observationIds) {
				legacyDroppedIds.add(observationId);
				if (!observationsById.has(observationId)) continue;
				states.set(observationId, {
					status: "deleted",
					reason: "Removed from automatic memory by the legacy dropper.",
					becauseOfMemoryIds: [],
					replacementMemoryIds: [],
					lastAction: "legacyDrop",
				});
			}
			continue;
		}

		if (isCustomEntry(entry, OM_LIBRARIAN_COMMIT)) {
			if (!isLibrarianCommitData(entry.data)) continue;
			for (const reflection of entry.data.reflections) registerReflection(reflection);
			const knownIds = new Set([...observationsById.keys(), ...reflectionsById.keys()]);
			for (const action of entry.data.actions) applyAction(action, knownIds, states, replacedByMemoryId);
			continue;
		}

		if (entry.customType === OM_REVIEW_RESULT && isReviewResultEntry(entry) && !reviewsById.has(entry.data.result.id)) {
			reviewsById.set(entry.data.result.id, entry.data.result);
		}
	}

	const observations = Array.from(observationsById.values());
	const reflections = Array.from(reflectionsById.values());
	const status = (id: string): MemoryStatus => states.get(id)?.status ?? "active";
	const activeObservations = observations.filter((item) => status(item.id) === "active");
	const inactiveObservations = observations.filter((item) => status(item.id) === "inactive");
	const deletedObservations = observations.filter((item) => status(item.id) === "deleted");
	const activeReflections = reflections.filter((item) => status(item.id) === "active");
	const inactiveReflections = reflections.filter((item) => status(item.id) === "inactive");
	const deletedReflections = reflections.filter((item) => status(item.id) === "deleted");
	const droppedObservationIds = new Set(deletedObservations.map((item) => item.id));
	for (const id of legacyDroppedIds) droppedObservationIds.add(id);

	return {
		observations,
		activeObservations,
		inactiveObservations,
		deletedObservations,
		droppedObservationIds,
		reflections,
		activeReflections,
		inactiveReflections,
		deletedReflections,
		observationsById,
		reflectionsById,
		memoryStatusById: new Map(Array.from(states, ([id, state]) => [id, state.status])),
		lifecycleByMemoryId: states,
		mergedIntoByMemoryId,
		replacedByMemoryId,
		reviews: Array.from(reviewsById.values()),
		reviewsById,
	};
}
