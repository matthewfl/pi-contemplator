import { estimateStringTokens } from "../../tokens.js";
import { observationRetention, type MemoryStatus, type Observation, type Reflection } from "../../session-ledger/index.js";

export type LibrarianMemory =
	| { kind: "observation"; memory: Observation; status: MemoryStatus }
	| { kind: "reflection"; memory: Reflection; status: MemoryStatus };

export type InactiveCohort = {
	recallIf: string;
	memoryIds: string[];
};

export type SamplingFairness = {
	lastSampledAt?: number;
	sampleCount: number;
};

export type LibrarianSample = {
	activeMemories: LibrarianMemory[];
	inactiveCohorts: Array<InactiveCohort & { alias: string }>;
	aliasMembers: Map<string, string[]>;
	sampled: boolean;
	eligibleCount: number;
	selectedCount: number;
	eligibleTokens: number;
	selectedTokens: number;
	budgetTokens: number;
};

export type LibrarianSamplingArgs = {
	activeMemories: LibrarianMemory[];
	inactiveCohorts: InactiveCohort[];
	contextWindow: number;
	/** Fraction of the model context reserved for rendered memory input. */
	samplingThresholdRatio?: number;
	newMemoryIds?: ReadonlySet<string>;
	fairness?: Map<string, SamplingFairness>;
	now?: number;
	random?: () => number;
};

type Candidate = {
	key: string;
	tokens: number;
	weight: number;
	active?: LibrarianMemory;
	inactive?: InactiveCohort;
};

function timestampMs(item: LibrarianMemory): number | undefined {
	if (item.kind !== "observation") return undefined;
	const parsed = Date.parse(item.memory.timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function activeLine(item: LibrarianMemory): string {
	if (item.kind === "observation") {
		const observation = item.memory;
		return `[${observation.id}] observation ${observation.timestamp} relevance=${observation.relevance} retention=${observationRetention(observation)} tokens=${observation.tokenCount}: ${observation.content}`;
	}
	const sources = item.memory.sourceMemoryIds ?? item.memory.supportingObservationIds;
	return `[${item.memory.id}] reflection sources=[${sources.join(", ")}] tokens=${item.memory.tokenCount}: ${item.memory.content}`;
}

function inactiveLine(cohort: InactiveCohort): string {
	return `(inactive memories: ${cohort.memoryIds.length}) ${cohort.recallIf}`;
}

function tokenCost(text: string): number {
	// Include modest line/section overhead so the selected render remains below budget.
	return Math.max(1, estimateStringTokens(text) + 4);
}

function relevanceWeight(item: LibrarianMemory): number {
	if (item.kind === "reflection") return 2;
	return { low: 0.75, medium: 1, high: 1.5, critical: 2.25 }[item.memory.relevance];
}

function retentionWeight(item: LibrarianMemory): number {
	if (item.kind === "reflection") return 1.5;
	return { ephemeral: 0.7, contextual: 1, durable: 1.75 }[observationRetention(item.memory)];
}

function candidateWeight(
	item: LibrarianMemory,
	newMemoryIds: ReadonlySet<string>,
	fairness: Map<string, SamplingFairness> | undefined,
	now: number,
	oldestTimestamp: number | undefined,
	newestTimestamp: number | undefined,
): number {
	let weight = relevanceWeight(item) * retentionWeight(item);
	if (newMemoryIds.has(item.memory.id)) weight *= 8;
	const timestamp = timestampMs(item);
	if (timestamp !== undefined && oldestTimestamp !== undefined && newestTimestamp !== undefined && newestTimestamp > oldestTimestamp) {
		const recency = (timestamp - oldestTimestamp) / (newestTimestamp - oldestTimestamp);
		weight *= 1 + recency * 4;
		// Very old memories that remain active get a small review opportunity boost.
		if (recency <= 0.1) weight *= 1.35;
	}
	const prior = fairness?.get(item.memory.id);
	if (prior?.lastSampledAt !== undefined) {
		const hours = Math.max(0, now - prior.lastSampledAt) / 3_600_000;
		weight *= Math.min(3, 1 + hours / 24);
	} else if (prior === undefined || prior.sampleCount === 0) {
		weight *= 1.25;
	}
	return Math.max(0.05, weight);
}

function weightedOrder(candidates: Candidate[], random: () => number): Candidate[] {
	return candidates
		.map((candidate) => ({
			candidate,
			// Efraimidis-Spirakis weighted sampling without replacement.
			priority: -Math.log(Math.max(Number.EPSILON, random())) / candidate.weight,
		}))
		.sort((a, b) => a.priority - b.priority || a.candidate.key.localeCompare(b.candidate.key))
		.map(({ candidate }) => candidate);
}

export function buildInactiveCohorts(memories: LibrarianMemory[], recallIfById: ReadonlyMap<string, string>): InactiveCohort[] {
	const grouped = new Map<string, string[]>();
	for (const item of memories) {
		if (item.status !== "inactive") continue;
		const cue = recallIfById.get(item.memory.id)?.trim();
		if (!cue) continue;
		const normalized = cue.normalize("NFKC").replace(/\s+/g, " ").trim();
		const ids = grouped.get(normalized) ?? [];
		ids.push(item.memory.id);
		grouped.set(normalized, ids);
	}
	return Array.from(grouped, ([recallIf, memoryIds]) => ({ recallIf, memoryIds }));
}

export function sampleLibrarianMemories(args: LibrarianSamplingArgs): LibrarianSample {
	const now = args.now ?? Date.now();
	const random = args.random ?? Math.random;
	const thresholdRatio = args.samplingThresholdRatio ?? 0.5;
	const budgetTokens = Math.max(1, Math.floor(args.contextWindow * thresholdRatio));
	const newMemoryIds = args.newMemoryIds ?? new Set<string>();
	const timestamps = args.activeMemories.map(timestampMs).filter((value): value is number => value !== undefined);
	const oldestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : undefined;
	const newestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : undefined;
	const activeCandidates: Candidate[] = args.activeMemories.map((active) => ({
		key: active.memory.id,
		tokens: tokenCost(activeLine(active)),
		weight: candidateWeight(active, newMemoryIds, args.fairness, now, oldestTimestamp, newestTimestamp),
		active,
	}));
	const inactiveCandidates: Candidate[] = args.inactiveCohorts.map((inactive, index) => ({
		key: `inactive:${index}:${inactive.recallIf}`,
		tokens: tokenCost(inactiveLine(inactive)),
		weight: 1.25,
		inactive,
	}));
	const all = [...activeCandidates, ...inactiveCandidates];
	const eligibleTokens = all.reduce((sum, candidate) => sum + candidate.tokens, 0);
	const sampled = eligibleTokens > budgetTokens;
	const selected = sampled ? [] as Candidate[] : all;
	if (sampled) {
		let used = 0;
		for (const candidate of weightedOrder(all, random)) {
			if (candidate.tokens > budgetTokens - used) continue;
			selected.push(candidate);
			used += candidate.tokens;
		}
	}
	const selectedActiveKeys = new Set(selected.filter((item) => item.active).map((item) => item.key));
	const activeMemories = args.activeMemories.filter((item) => selectedActiveKeys.has(item.memory.id));
	const selectedInactive = selected.filter((item): item is Candidate & { inactive: InactiveCohort } => item.inactive !== undefined);
	const inactiveCohorts = selectedInactive.map((item, index) => ({ ...item.inactive, alias: `inactive_${index + 1}` }));
	const aliasMembers = new Map(inactiveCohorts.map((cohort) => [cohort.alias, [...cohort.memoryIds]]));
	const selectedTokens = selected.reduce((sum, candidate) => sum + candidate.tokens, 0);

	for (const item of activeMemories) {
		const prior = args.fairness?.get(item.memory.id) ?? { sampleCount: 0 };
		args.fairness?.set(item.memory.id, { lastSampledAt: now, sampleCount: prior.sampleCount + 1 });
	}

	return {
		activeMemories,
		inactiveCohorts,
		aliasMembers,
		sampled,
		eligibleCount: all.length,
		selectedCount: selected.length,
		eligibleTokens,
		selectedTokens,
		budgetTokens,
	};
}

export function renderLibrarianMemory(item: LibrarianMemory): string {
	return activeLine(item);
}
