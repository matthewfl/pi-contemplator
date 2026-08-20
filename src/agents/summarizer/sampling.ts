import { estimateStringTokens } from "../../tokens.js";
import { observationRetention, type Observation, type Summary } from "../../session-ledger/index.js";

export type SummarizerMemory =
	| { kind: "observation"; memory: Observation }
	| { kind: "summary"; memory: Summary };

export type SamplingFairness = {
	lastSampledAt?: number;
	sampleCount: number;
};

export type SummarizerSample = {
	memories: SummarizerMemory[];
	sampled: boolean;
	eligibleCount: number;
	selectedCount: number;
	eligibleTokens: number;
	selectedTokens: number;
	budgetTokens: number;
};

export type SummarizerSamplingArgs = {
	memories: SummarizerMemory[];
	/** Maximum rendered memory-input tokens before sampling. */
	samplingThresholdTokens?: number;
	newMemoryIds?: ReadonlySet<string>;
	fairness?: Map<string, SamplingFairness>;
	now?: number;
	random?: () => number;
};

type Candidate = {
	item: SummarizerMemory;
	tokens: number;
	weight: number;
};

function timestampMs(item: SummarizerMemory): number | undefined {
	if (item.kind !== "observation") return undefined;
	const parsed = Date.parse(item.memory.timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function renderSummarizerMemory(item: SummarizerMemory): string {
	if (item.kind === "observation") {
		const memory = item.memory;
		return `[${memory.id}] observation ${memory.timestamp} relevance=${memory.relevance} retention=${observationRetention(memory)} tokens=${memory.tokenCount}: ${memory.content}`;
	}
	return `[${item.memory.id}] summary sources=[${item.memory.sourceMemoryIds.join(", ")}] tokens=${item.memory.tokenCount}: ${item.memory.content}`;
}

function tokenCost(item: SummarizerMemory): number {
	return Math.max(1, estimateStringTokens(renderSummarizerMemory(item)) + 4);
}

function baseWeight(item: SummarizerMemory): number {
	if (item.kind === "summary") return 3;
	const relevance = { low: 0.75, medium: 1, high: 1.5, critical: 2.25 }[item.memory.relevance];
	const retention = { ephemeral: 0.7, contextual: 1, durable: 1.75 }[observationRetention(item.memory)];
	return relevance * retention;
}

function candidateWeight(
	item: SummarizerMemory,
	newMemoryIds: ReadonlySet<string>,
	fairness: Map<string, SamplingFairness> | undefined,
	now: number,
	oldestTimestamp: number | undefined,
	newestTimestamp: number | undefined,
): number {
	let weight = baseWeight(item);
	if (newMemoryIds.has(item.memory.id)) weight *= 8;
	const timestamp = timestampMs(item);
	if (timestamp !== undefined && oldestTimestamp !== undefined && newestTimestamp !== undefined && newestTimestamp > oldestTimestamp) {
		const recency = (timestamp - oldestTimestamp) / (newestTimestamp - oldestTimestamp);
		weight *= 1 + recency * 4;
		if (recency <= 0.1) weight *= 1.35;
	}
	const prior = fairness?.get(item.memory.id);
	if (prior?.lastSampledAt !== undefined) {
		const hours = Math.max(0, now - prior.lastSampledAt) / 3_600_000;
		weight *= Math.min(3, 1 + hours / 24);
	} else if (!prior || prior.sampleCount === 0) weight *= 1.25;
	return Math.max(0.05, weight);
}

function weightedOrder(candidates: Candidate[], random: () => number): Candidate[] {
	return candidates
		.map((candidate) => ({ candidate, priority: -Math.log(Math.max(Number.EPSILON, random())) / candidate.weight }))
		.sort((a, b) => a.priority - b.priority || a.candidate.item.memory.id.localeCompare(b.candidate.item.memory.id))
		.map(({ candidate }) => candidate);
}

export function sampleSummarizerMemories(args: SummarizerSamplingArgs): SummarizerSample {
	const now = args.now ?? Date.now();
	const random = args.random ?? Math.random;
	const budgetTokens = Math.max(1, Math.floor(args.samplingThresholdTokens ?? 50_000));
	const newMemoryIds = args.newMemoryIds ?? new Set<string>();
	const timestamps = args.memories.map(timestampMs).filter((value): value is number => value !== undefined);
	const oldestTimestamp = timestamps.length ? Math.min(...timestamps) : undefined;
	const newestTimestamp = timestamps.length ? Math.max(...timestamps) : undefined;
	const candidates = args.memories.map((item): Candidate => ({
		item,
		tokens: tokenCost(item),
		weight: candidateWeight(item, newMemoryIds, args.fairness, now, oldestTimestamp, newestTimestamp),
	}));
	const eligibleTokens = candidates.reduce((sum, candidate) => sum + candidate.tokens, 0);
	const sampled = eligibleTokens > budgetTokens;
	const selected = sampled ? [] as Candidate[] : candidates;
	if (sampled) {
		let used = 0;
		for (const candidate of weightedOrder(candidates, random)) {
			if (candidate.tokens > budgetTokens - used) continue;
			selected.push(candidate);
			used += candidate.tokens;
		}
	}
	const selectedIds = new Set(selected.map((candidate) => candidate.item.memory.id));
	const memories = args.memories.filter((item) => selectedIds.has(item.memory.id));
	return {
		memories,
		sampled,
		eligibleCount: candidates.length,
		selectedCount: selected.length,
		eligibleTokens,
		selectedTokens: selected.reduce((sum, candidate) => sum + candidate.tokens, 0),
		budgetTokens,
	};
}
