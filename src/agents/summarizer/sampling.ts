import { estimateStringTokens } from "../../tokens.js";
import type { Observation, Summary } from "../../session-ledger/index.js";

export type SummarizerMemory =
	| { kind: "observation"; memory: Observation }
	| { kind: "summary"; memory: Summary };

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
	/** Maximum rendered old-memory input tokens before sampling. */
	samplingThresholdTokens?: number;
	random?: () => number;
};

type Candidate = {
	item: SummarizerMemory;
	tokens: number;
	weight: number;
};

export function renderSummarizerMemory(item: SummarizerMemory): string {
	if (item.kind === "observation") {
		const memory = item.memory;
		return `[${memory.id}] observation ${memory.timestamp} relevance=${memory.relevance}: ${memory.content}`;
	}
	return `[${item.memory.id}] summary ${item.memory.timestamp} sources=[${item.memory.sourceMemoryIds.join(", ")}]: ${item.memory.content}`;
}

function tokenCost(item: SummarizerMemory): number {
	return Math.max(1, estimateStringTokens(renderSummarizerMemory(item)) + 4);
}

/** Weighted random order without replacement. Weight is exactly inverse length. */
function weightedOrder(candidates: Candidate[], random: () => number): Candidate[] {
	return candidates
		.map((candidate) => ({ candidate, priority: -Math.log(Math.max(Number.EPSILON, random())) / candidate.weight }))
		.sort((a, b) => a.priority - b.priority || a.candidate.item.memory.id.localeCompare(b.candidate.item.memory.id))
		.map(({ candidate }) => candidate);
}

export function sampleSummarizerMemories(args: SummarizerSamplingArgs): SummarizerSample {
	const random = args.random ?? Math.random;
	const budgetTokens = Math.max(1, Math.floor(args.samplingThresholdTokens ?? 60_000));
	const candidates = args.memories.map((item): Candidate => {
		const tokens = tokenCost(item);
		return { item, tokens, weight: 1 / tokens };
	});
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
