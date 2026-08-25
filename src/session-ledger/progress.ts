import { estimateEntryTokens } from "../tokens.js";
import {
	OM_AGENT_ACTIVITY,
	OM_OBSERVATIONS_RECORDED,
	OM_SUMMARIZER_COMMIT,
	type Entry,
	type MemoryCoverageCustomType,
} from "./types.js";

const SOURCE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export function isSourceEntry(entry: Entry): boolean {
	return SOURCE_ENTRY_TYPES.has(entry.type);
}

export function entryIndexById(entries: Entry[]): Map<string, number> {
	const idToIndex = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIndex.set(entries[i].id, i);
	return idToIndex;
}

export function entryIndexForId(entries: Entry[], entryId: string | undefined): number {
	if (!entryId) return -1;
	const idx = entryIndexById(entries).get(entryId);
	return idx ?? -1;
}

/** Sum all primary-agent output tokens visible on the current session branch. */
export function assistantOutputTokens(entries: Entry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (isObject(usage) && typeof usage.output === "number" && Number.isFinite(usage.output)) {
			total += Math.max(0, usage.output);
		}
	}
	return total;
}

/** Count all primary-agent tool calls visible on the current session branch. */
export function assistantToolCallCount(entries: Entry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (isObject(block) && block.type === "toolCall") total++;
		}
	}
	return total;
}

/** Sum persisted main-agent active wall-clock time on the current branch. */
export function agentActiveTimeMs(entries: Entry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== OM_AGENT_ACTIVITY || !isObject(entry.data)) continue;
		const durationMs = entry.data.durationMs;
		if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) total += durationMs;
	}
	return total;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0;
}

function isValidCoverageEntry(entry: Entry, customType: MemoryCoverageCustomType): entry is Entry & { data: { coversUpToId: string } } {
	if (entry.type !== "custom" || entry.customType !== customType) return false;
	if (!isObject(entry.data) || typeof entry.data.coversUpToId !== "string") return false;
	if (customType === OM_OBSERVATIONS_RECORDED) return Array.isArray(entry.data.observations);
	return customType === OM_SUMMARIZER_COMMIT && isNonEmptyArray(entry.data.summaries);
}

export function latestCoverageIndex(entries: Entry[], customType: MemoryCoverageCustomType): number {
	const idToIndex = entryIndexById(entries);
	let latest = -1;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latest) latest = coveredIndex;
	}

	return latest;
}

export function latestCoverageMarkerId(entries: Entry[], customType: MemoryCoverageCustomType): string | undefined {
	const idToIndex = entryIndexById(entries);
	let latestIndex = -1;
	let latestMarkerId: string | undefined;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latestIndex) {
			latestIndex = coveredIndex;
			latestMarkerId = entry.data.coversUpToId;
		}
	}

	return latestMarkerId;
}

export function earlierCoverageMarkerId(entries: Entry[], firstId: string | undefined, secondId: string | undefined): string | undefined {
	if (!firstId) return secondId;
	if (!secondId) return firstId;

	const idToIndex = entryIndexById(entries);
	const firstIndex = idToIndex.get(firstId);
	const secondIndex = idToIndex.get(secondId);
	if (firstIndex === undefined) return secondIndex === undefined ? undefined : secondId;
	if (secondIndex === undefined) return firstId;
	return firstIndex <= secondIndex ? firstId : secondId;
}

export function rawTokensAfterIndex(entries: Entry[], index: number): number {
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) {
		if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export function rawTokensSinceCoverage(entries: Entry[], customType: MemoryCoverageCustomType): number {
	return rawTokensAfterIndex(entries, latestCoverageIndex(entries, customType));
}

export function rawTokensSinceObservationCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_RECORDED);
}

export function findLastCompactionIndex(entries: Entry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return i;
	}
	return -1;
}

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	const compactionIndex = findLastCompactionIndex(entries);
	if (compactionIndex === -1) return rawTokensAfterIndex(entries, -1);

	const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
	const firstKeptIndex = entryIndexForId(entries, firstKeptEntryId);

	if (firstKeptIndex === -1) return rawTokensAfterIndex(entries, compactionIndex);
	return rawTokensAfterIndex(entries, firstKeptIndex - 1);
}
