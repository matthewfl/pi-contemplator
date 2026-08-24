import type { Observation, Summary } from "./types.js";

export type ActiveMemory =
	| { kind: "observation"; memory: Observation }
	| { kind: "summary"; memory: Summary };

export type MemoryPools = {
	/** Older active memories eligible for summarization. */
	old: ActiveMemory[];
	/** Newest contiguous active-memory suffix protected from summarization. */
	new: ActiveMemory[];
	oldTokens: number;
	newTokens: number;
	totalTokens: number;
};

function parsedTimestamp(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Sort observations and summaries together by their effective memory timestamp. */
export function chronologicalMemories(observations: readonly Observation[], summaries: readonly Summary[]): ActiveMemory[] {
	return [
		...observations.map((memory) => ({ kind: "observation" as const, memory })),
		...summaries.map((memory) => ({ kind: "summary" as const, memory })),
	].sort((a, b) => parsedTimestamp(a.memory.timestamp) - parsedTimestamp(b.memory.timestamp) || a.memory.id.localeCompare(b.memory.id));
}

/**
 * Derive accounting-only pools from active memory. Pool membership is not
 * persisted: the newest whole-memory suffix fitting the configured token cap
 * is protected, and every older record is summarizer-eligible. Because records
 * are indivisible, the newest record is always protected even when it alone
 * exceeds the cap.
 */
export function partitionMemoryPools(
	observations: readonly Observation[],
	summaries: readonly Summary[],
	newPoolMaxTokens: number,
): MemoryPools {
	const memories = chronologicalMemories(observations, summaries);
	const cap = Math.max(0, Math.floor(newPoolMaxTokens));
	let boundary = memories.length;
	let newTokens = 0;
	for (let index = memories.length - 1; index >= 0; index--) {
		const tokens = memories[index].memory.tokenCount;
		const isNewest = index === memories.length - 1;
		if (!isNewest && newTokens + tokens > cap) break;
		newTokens += tokens;
		boundary = index;
	}
	const old = memories.slice(0, boundary);
	const recent = memories.slice(boundary);
	const oldTokens = old.reduce((sum, item) => sum + item.memory.tokenCount, 0);
	return {
		old,
		new: recent,
		oldTokens,
		newTokens,
		totalTokens: oldTokens + newTokens,
	};
}

/** Effective timestamp for a new summary: newest timestamp among its sources. */
export function latestMemoryTimestamp(memories: readonly ActiveMemory[]): string | undefined {
	let latest: string | undefined;
	let latestMs = Number.NEGATIVE_INFINITY;
	for (const item of memories) {
		const ms = parsedTimestamp(item.memory.timestamp);
		if (latest === undefined || ms > latestMs || (ms === latestMs && item.memory.timestamp > latest)) {
			latest = item.memory.timestamp;
			latestMs = ms;
		}
	}
	return latest;
}
