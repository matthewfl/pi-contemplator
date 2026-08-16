import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import type { LlmUsageInput } from "../../runtime.js";
import { truncateRecordContent } from "../../serialize.js";
import {
	foldLedger,
	isMemoryDetails,
	observationRetention,
	OM_LIBRARIAN_COMMIT,
	OM_OBSERVATIONS_RECORDED,
	type Entry,
	type LibrarianCommitEntryData,
	type MemoryLifecycleAction,
	type MemoryStatus,
	type Observation,
	type Reflection,
} from "../../session-ledger/index.js";
import { executeRecall } from "../../tools/recall-observation.js";
import { createSearchMemoriesAgentTool } from "../../tools/search-memories.js";
import { estimateStringTokens } from "../../tokens.js";
import { logAgentStreamError } from "../stream-errors.js";
import { LIBRARIAN_CONTINUE, LIBRARIAN_SYSTEM } from "./prompts.js";
import {
	buildInactiveCohorts,
	renderLibrarianMemory,
	sampleLibrarianMemories,
	type LibrarianMemory,
	type LibrarianSample,
	type SamplingFairness,
} from "./sampling.js";

export const LIBRARIAN_MAX_INVOCATIONS = 3;

export type RunLibrarianArgs = {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	getBranch: () => Entry[];
	targetTokens: number;
	samplingThresholdRatio?: number;
	fairness?: Map<string, SamplingFairness>;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
	recordUsage?: (usage: LlmUsageInput) => void;
	/** Launch-local transcript snapshots for diagnostics such as /om:view librarian. */
	onMessages?: (messages: readonly AgentMessage[]) => void;
	random?: () => number;
	now?: number;
};

export type LibrarianRunResult = {
	commit?: LibrarianCommitEntryData;
	completed: boolean;
	sample?: LibrarianSample;
};

const MemoryIdArray = Type.Array(Type.String({ pattern: "^[a-f0-9]{12}$" }), { minItems: 1 });
const EvidenceIds = Type.Array(Type.String({ pattern: "^[a-f0-9]{12}$" }), { minItems: 1 });

const RecordReflectionSchema = Type.Object({
	content: Type.String({ minLength: 1 }),
	sourceMemoryIds: Type.Array(Type.String({ pattern: "^[a-f0-9]{12}$" }), { minItems: 2 }),
	sourceDisposition: Type.Union([Type.Literal("keepActive"), Type.Literal("makeInactive"), Type.Literal("delete")]),
	sourceRecallIf: Type.Optional(Type.String({ minLength: 1 })),
	deleteReason: Type.Optional(Type.String({ minLength: 1 })),
	rationale: Type.String({ minLength: 1 }),
});
const DeleteMemoriesSchema = Type.Object({
	memoryIds: MemoryIdArray,
	becauseOfObservationIds: EvidenceIds,
	replacementMemoryIds: Type.Optional(Type.Array(Type.String({ pattern: "^[a-f0-9]{12}$" }))),
	reason: Type.String({ minLength: 1 }),
});
const MakeInactiveSchema = Type.Object({
	memoryIds: MemoryIdArray,
	becauseOfObservationIds: EvidenceIds,
	recallIf: Type.String({ minLength: 1 }),
});
const MakeActiveSchema = Type.Object({
	inactiveRefs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	becauseOfObservationIds: EvidenceIds,
});
const RecallSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const DoneSchema = Type.Object({ summary: Type.String({ minLength: 1 }) });

type RecordReflectionArgs = Static<typeof RecordReflectionSchema>;
type DeleteMemoriesArgs = Static<typeof DeleteMemoriesSchema>;
type MakeInactiveArgs = Static<typeof MakeInactiveSchema>;
type MakeActiveArgs = Static<typeof MakeActiveSchema>;
type RecallArgs = Static<typeof RecallSchema>;
type DoneArgs = Static<typeof DoneSchema>;

function unique(values: readonly string[]): string[] {
	return Array.from(new Set(values));
}

function latestObservationBatchEntryId(entries: Entry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED) return entry.id;
	}
	return undefined;
}

function latestLibrarianCoverageIndex(entries: Entry[]): number {
	const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
	// The newest successful pass supersedes older checkpoints. Its explicit
	// observation-batch boundary is preferred while that entry remains present.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== OM_LIBRARIAN_COMMIT || !entry.data || typeof entry.data !== "object") continue;
		const covered = (entry.data as { coversUpToId?: unknown }).coversUpToId;
		if (typeof covered !== "string") continue;
		const coveredIndex = indexes.get(covered);
		if (coveredIndex !== undefined) return coveredIndex;
		// Pi compaction can fold the referenced batch out while retaining this
		// commit. Falling back to the commit is less exact for observations appended
		// concurrently with that historical run, but avoids treating every retained
		// pre-commit batch as new forever after the boundary disappears.
		return i;
	}
	return -1;
}

export function newMemoryIdsSinceLibrarianCoverage(entries: Entry[]): Set<string> {
	const after = latestLibrarianCoverageIndex(entries);
	const previouslySeen = new Set<string>();
	// Compaction archives at or before the coverage boundary are authoritative
	// previously reviewed memory. Seed deduplication from them so an observer
	// retry is not considered new merely because its original custom record was
	// folded off the branch. Later archives may contain genuinely unreviewed work.
	for (let i = 0; i <= after; i++) {
		const entry = entries[i];
		if (!entry || entry.type !== "compaction" || !isMemoryDetails(entry.details)) continue;
		for (const observation of entry.details.archive?.observations ?? entry.details.observations) previouslySeen.add(observation.id);
	}
	const ids = new Set<string>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== OM_OBSERVATIONS_RECORDED || !entry.data || typeof entry.data !== "object") continue;
		const observations = (entry.data as { observations?: Array<{ id?: unknown }> }).observations;
		for (const observation of observations ?? []) {
			if (typeof observation.id !== "string") continue;
			// Observer retries can append the same content-addressed memory again.
			// A repeated ledger occurrence is not new work for the librarian.
			if (i > after && !previouslySeen.has(observation.id)) ids.add(observation.id);
			previouslySeen.add(observation.id);
		}
	}
	return ids;
}

function memoryLine(memory: Observation | Reflection, status: MemoryStatus, recallIf?: string, reason?: string): string {
	if ("timestamp" in memory) {
		return `[${memory.id}] observation status=${status} ${memory.timestamp} relevance=${memory.relevance} retention=${observationRetention(memory)} tokens=${memory.tokenCount}: ${memory.content}${recallIf ? `\n  recallIf: ${recallIf}` : ""}${reason ? `\n  deleted because: ${reason}` : ""}`;
	}
	const sources = memory.sourceMemoryIds ?? memory.supportingObservationIds;
	return `[${memory.id}] reflection status=${status} sources=[${sources.join(", ")}] tokens=${memory.tokenCount}: ${memory.content}${recallIf ? `\n  recallIf: ${recallIf}` : ""}${reason ? `\n  deleted because: ${reason}` : ""}`;
}

function median(values: number[]): number {
	if (values.length === 0) return 1;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 1;
}

export function buildLibrarianPrompt(sample: LibrarianSample, args: {
	activeTokens: number;
	targetTokens: number;
	contextWindow: number;
	newCount: number;
	newTokens: number;
	activeTokenSizes: number[];
}): string {
	const activePct = Math.round((args.activeTokens / Math.max(1, args.contextWindow)) * 1_000) / 10;
	const sections = [
		`LIBRARIAN RUN\nActive memories: ${sample.activeMemories.length.toLocaleString()} selected from ${sample.eligibleCount.toLocaleString()} eligible items.\nActive memory tokens: ~${args.activeTokens.toLocaleString()} (${activePct}% of librarian context); configured target: ~${args.targetTokens.toLocaleString()}.\nNew memory since the previous successful pass: ${args.newCount.toLocaleString()} records / ~${args.newTokens.toLocaleString()} tokens.\nInitial memory input: ~${sample.selectedTokens.toLocaleString()} / ${sample.budgetTokens.toLocaleString()} token cap (${sample.sampled ? `sampled from ~${sample.eligibleTokens.toLocaleString()} eligible tokens; recent evidence favored` : "complete eligible set; sampling not used"}).`,
	];
	if (args.activeTokens > args.targetTokens) {
		const excess = args.activeTokens - args.targetTokens;
		const approximateCount = Math.max(1, Math.ceil(excess / Math.max(1, median(args.activeTokenSizes))));
		sections.push(`${sample.sampled ? "SEVERE " : ""}MEMORY PRESSURE ADVISORY\nReducing automatic memory by roughly ${excess.toLocaleString()} tokens would return to target. At the current median memory size, that is approximately ${approximateCount.toLocaleString()} memories. Consider combining related memories, making currently irrelevant memories inactive, and deleting only obsolete or consumed temporal detail. This is guidance, not a quota: preserve uncertain or uniquely useful memories and defer unsafe decisions to a future librarian run.`);
	}
	sections.push(`ACTIVE MEMORIES (${sample.sampled ? "SAMPLED SUBSET" : "COMPLETE SET"})\n${sample.activeMemories.length ? sample.activeMemories.map(renderLibrarianMemory).join("\n") : "(none)"}`);
	sections.push(`INACTIVE MEMORY GROUPS\n${sample.inactiveCohorts.length ? sample.inactiveCohorts.map((cohort) => `[${cohort.alias}] (${cohort.memoryIds.length} memories) ${cohort.recallIf}`).join("\n") : "(none)"}`);
	sections.push("Curate only when clearly beneficial. Call done alone when finished, including when no changes are warranted.");
	return sections.join("\n\n");
}

function textResult(text: string, details: Record<string, unknown> = {}, terminate = false) {
	return { content: [{ type: "text" as const, text }], details, ...(terminate ? { terminate: true } : {}) };
}

export async function runLibrarian(args: RunLibrarianArgs): Promise<LibrarianRunResult> {
	const snapshot = args.getBranch();
	const coversUpToId = latestObservationBatchEntryId(snapshot);
	if (!coversUpToId) return { completed: false };
	const folded = foldLedger(snapshot);
	const allMemories: LibrarianMemory[] = [
		...folded.observations.map((memory) => ({ kind: "observation" as const, memory, status: folded.memoryStatusById.get(memory.id) ?? "active" })),
		...folded.reflections.map((memory) => ({ kind: "reflection" as const, memory, status: folded.memoryStatusById.get(memory.id) ?? "active" })),
	];
	const activeMemories = allMemories.filter((item) => item.status === "active");
	const recallIfById = new Map(Array.from(folded.lifecycleByMemoryId, ([id, state]) => [id, state.recallIf ?? ""]));
	const inactiveCohorts = buildInactiveCohorts(allMemories, recallIfById);
	const contextWindow = typeof args.model.contextWindow === "number" && args.model.contextWindow > 0 ? args.model.contextWindow : 128_000;
	const newMemoryIds = newMemoryIdsSinceLibrarianCoverage(snapshot);
	const sample = sampleLibrarianMemories({ activeMemories, inactiveCohorts, contextWindow, samplingThresholdRatio: args.samplingThresholdRatio, newMemoryIds, fairness: args.fairness, random: args.random, now: args.now });
	const inspected = new Set(sample.activeMemories.map((item) => item.memory.id));
	const memoryById = new Map<string, Observation | Reflection>([
		...folded.observations.map((item) => [item.id, item] as const),
		...folded.reflections.map((item) => [item.id, item] as const),
	]);
	const memoryCreationIndex = new Map<string, number>();
	const lifecycleChangeIndex = new Map<string, number>();
	for (let entryIndex = 0; entryIndex < snapshot.length; entryIndex++) {
		const entry = snapshot[entryIndex];
		const data = entry.data as { observations?: Array<{ id?: string }>; reflections?: Array<{ id?: string }>; actions?: Array<{ memoryIds?: string[] }> } | undefined;
		for (const item of [...(data?.observations ?? []), ...(data?.reflections ?? [])]) if (item.id && !memoryCreationIndex.has(item.id)) memoryCreationIndex.set(item.id, entryIndex);
		for (const action of data?.actions ?? []) for (const id of action.memoryIds ?? []) lifecycleChangeIndex.set(id, entryIndex);
		if (entry.type === "compaction" && entry.details && typeof entry.details === "object") {
			const archive = (entry.details as { archive?: { observations?: Array<{ id?: string }>; reflections?: Array<{ id?: string }> } }).archive;
			for (const item of [...(archive?.observations ?? []), ...(archive?.reflections ?? [])]) if (item.id && !memoryCreationIndex.has(item.id)) memoryCreationIndex.set(item.id, entryIndex);
		}
	}
	const stagedReflections = new Map<string, Reflection>();
	const stagedActions: MemoryLifecycleAction[] = [];
	const stagedStatus = new Map(folded.memoryStatusById);
	let doneSummary: string | undefined;

	const memoryExists = (id: string): boolean => memoryById.has(id) || stagedReflections.has(id);
	const statusOf = (id: string): MemoryStatus | undefined => stagedStatus.get(id) ?? (stagedReflections.has(id) ? "active" : undefined);
	const isObservationEvidence = (ids: readonly string[]): boolean => ids.length > 0 && ids.every((id) => inspected.has(id) && folded.observationsById.has(id));
	const validateShared = (evidenceIds: readonly string[], replacements: readonly string[] = []): string | undefined => {
		if (!isObservationEvidence(evidenceIds)) return "Every becauseOfObservationIds value must be an inspected observation in this run.";
		if (!replacements.every((id) => inspected.has(id) && memoryExists(id))) return "Every replacementMemoryIds value must be an inspected memory in this run.";
		return undefined;
	};
	const evidenceFollowsTarget = (targetId: string, evidenceIds: readonly string[]): boolean => {
		const stateIndex = lifecycleChangeIndex.get(targetId) ?? memoryCreationIndex.get(targetId) ?? -1;
		const targetObservation = folded.observationsById.get(targetId);
		const targetTime = targetObservation ? Date.parse(targetObservation.timestamp) : Number.NaN;
		return evidenceIds.every((evidenceId) => {
			const evidenceIndex = memoryCreationIndex.get(evidenceId) ?? -1;
			if (evidenceIndex > stateIndex) return true;
			if (evidenceIndex < stateIndex || lifecycleChangeIndex.has(targetId)) return false;
			const evidenceTime = Date.parse(folded.observationsById.get(evidenceId)?.timestamp ?? "");
			return Number.isFinite(targetTime) && Number.isFinite(evidenceTime) && evidenceTime > targetTime;
		});
	};
	const stageAction = (action: MemoryLifecycleAction): void => {
		stagedActions.push(action);
		for (const id of action.memoryIds) stagedStatus.set(id, action.type === "makeInactive" ? "inactive" : action.type === "makeActive" ? "active" : "deleted");
	};

	const recordReflection: AgentTool<typeof RecordReflectionSchema> = {
		name: "record_reflection",
		label: "Record reflection",
		description: "Atomically stage a higher-order reflection from at least two inspected memories and choose one disposition for all sources.",
		parameters: RecordReflectionSchema,
		execute: async (_id, params: RecordReflectionArgs) => {
			const sourceMemoryIds = unique(params.sourceMemoryIds);
			if (sourceMemoryIds.length < 2 || sourceMemoryIds.some((id) => !inspected.has(id) || !memoryExists(id))) return textResult("Rejected: every distinct sourceMemoryId must be an inspected memory in this run.", { rejected: sourceMemoryIds });
			if (params.sourceDisposition === "makeInactive" && (!params.sourceRecallIf?.trim() || params.deleteReason !== undefined)) return textResult("Rejected: makeInactive requires sourceRecallIf and forbids deleteReason.");
			if (params.sourceDisposition === "delete" && (!params.deleteReason?.trim() || params.sourceRecallIf !== undefined)) return textResult("Rejected: delete requires deleteReason and forbids sourceRecallIf.");
			if (params.sourceDisposition === "keepActive" && (params.sourceRecallIf !== undefined || params.deleteReason !== undefined)) return textResult("Rejected: keepActive forbids sourceRecallIf and deleteReason.");
			if (params.sourceDisposition !== "keepActive" && sourceMemoryIds.some((id) => statusOf(id) !== "active")) return textResult("Rejected: source disposition can change only currently active sources.");
			const content = truncateRecordContent(params.content.trim());
			if (!content || /\r|\n/.test(content)) return textResult("Rejected: reflection content must be non-empty single-line prose.");
			const reflectionId = hashId(content);
			if (memoryExists(reflectionId)) return textResult(`Duplicate reflection [${reflectionId}] already exists.`, { duplicate: reflectionId });
			const supportingObservationIds = sourceMemoryIds.filter((id) => folded.observationsById.has(id));
			const reflection: Reflection = { id: reflectionId, content, supportingObservationIds, sourceMemoryIds, tokenCount: estimateStringTokens(content) };
			stagedReflections.set(reflectionId, reflection);
			stagedStatus.set(reflectionId, "active");
			inspected.add(reflectionId);
			const createdAt = args.now ?? Date.now();
			if (params.sourceDisposition === "makeInactive") stageAction({ type: "makeInactive", memoryIds: sourceMemoryIds, recallIf: params.sourceRecallIf!.trim(), becauseOfMemoryIds: [reflectionId], createdAt });
			if (params.sourceDisposition === "delete") stageAction({ type: "delete", memoryIds: sourceMemoryIds, reason: params.deleteReason!.trim(), becauseOfMemoryIds: [reflectionId], replacementMemoryIds: [reflectionId], createdAt });
			return textResult(`Staged reflection [${reflectionId}] from ${sourceMemoryIds.length} sources with disposition ${params.sourceDisposition}.`, { reflectionId, sourceMemoryIds, sourceDisposition: params.sourceDisposition });
		},
	};

	const deleteMemories: AgentTool<typeof DeleteMemoriesSchema> = {
		name: "delete_memories",
		label: "Delete memories",
		description: "Logically delete obsolete, low-value, or consumed temporal memories. Durable records remain searchable with this reason.",
		parameters: DeleteMemoriesSchema,
		execute: async (_id, params: DeleteMemoriesArgs) => {
			const evidenceIds = unique(params.becauseOfObservationIds);
			const replacementIds = unique(params.replacementMemoryIds ?? []);
			const sharedError = validateShared(evidenceIds, replacementIds);
			if (sharedError) return textResult(`Rejected entire call: ${sharedError}`);
			const accepted: string[] = [];
			const rejected: string[] = [];
			for (const id of unique(params.memoryIds)) {
				if (!inspected.has(id) || !memoryExists(id) || statusOf(id) === "deleted" || evidenceIds.includes(id) || !evidenceFollowsTarget(id, evidenceIds)) rejected.push(id);
				else accepted.push(id);
			}
			if (accepted.length) stageAction({ type: "delete", memoryIds: accepted, reason: params.reason.trim(), becauseOfMemoryIds: evidenceIds, replacementMemoryIds: replacementIds, createdAt: args.now ?? Date.now() });
			return textResult(`Staged deletion for ${accepted.length} memories; rejected ${rejected.length}: ${rejected.join(", ") || "none"}.`, { accepted, rejected });
		},
	};

	const makeInactive: AgentTool<typeof MakeInactiveSchema> = {
		name: "make_inactive",
		label: "Make inactive",
		description: "Move still-valid active memories out of automatic context under one concise recallIf cue.",
		parameters: MakeInactiveSchema,
		execute: async (_id, params: MakeInactiveArgs) => {
			const evidenceIds = unique(params.becauseOfObservationIds);
			const sharedError = validateShared(evidenceIds);
			if (sharedError) return textResult(`Rejected entire call: ${sharedError}`);
			const accepted: string[] = [];
			const rejected: string[] = [];
			for (const id of unique(params.memoryIds)) {
				if (!inspected.has(id) || !memoryExists(id) || statusOf(id) !== "active" || evidenceIds.includes(id) || !evidenceFollowsTarget(id, evidenceIds)) rejected.push(id);
				else accepted.push(id);
			}
			if (accepted.length) stageAction({ type: "makeInactive", memoryIds: accepted, recallIf: params.recallIf.trim(), becauseOfMemoryIds: evidenceIds, createdAt: args.now ?? Date.now() });
			return textResult(`Staged ${accepted.length} memories as inactive; rejected ${rejected.length}: ${rejected.join(", ") || "none"}.`, { accepted, rejected });
		},
	};

	const resolveInactiveRef = (ref: string): string[] | undefined => {
		const alias = sample.aliasMembers.get(ref);
		if (alias) return alias;
		if (statusOf(ref) !== "inactive") return undefined;
		const cue = folded.lifecycleByMemoryId.get(ref)?.recallIf;
		if (!cue) return undefined;
		return allMemories.filter((item) => item.status === "inactive" && folded.lifecycleByMemoryId.get(item.memory.id)?.recallIf === cue).map((item) => item.memory.id);
	};

	const makeActive: AgentTool<typeof MakeActiveSchema> = {
		name: "make_active",
		label: "Make active",
		description: "Reactivate run-local inactive aliases or inactive memory ids; each reference restores its whole same-cue cohort.",
		parameters: MakeActiveSchema,
		execute: async (_id, params: MakeActiveArgs) => {
			const evidenceIds = unique(params.becauseOfObservationIds);
			const sharedError = validateShared(evidenceIds);
			if (sharedError) return textResult(`Rejected entire call: ${sharedError}`);
			const acceptedRefs: string[] = [];
			const rejectedRefs: string[] = [];
			const members: string[] = [];
			for (const ref of unique(params.inactiveRefs)) {
				const resolved = resolveInactiveRef(ref);
				if (!resolved?.length) rejectedRefs.push(ref);
				else { acceptedRefs.push(ref); members.push(...resolved); }
			}
			const acceptedMembers = unique(members).filter((id) => statusOf(id) === "inactive" && evidenceFollowsTarget(id, evidenceIds));
			if (acceptedMembers.length) stageAction({ type: "makeActive", memoryIds: acceptedMembers, becauseOfMemoryIds: evidenceIds, createdAt: args.now ?? Date.now() });
			for (const id of acceptedMembers) inspected.add(id);
			const bodies = acceptedMembers.map((id) => {
				const memory = memoryById.get(id)!;
				return memoryLine(memory, "active");
			}).join("\n");
			return textResult(`Reactivated ${acceptedMembers.length} memories from ${acceptedRefs.length} references; rejected: ${rejectedRefs.join(", ") || "none"}.${bodies ? `\n\nREACTIVATED MEMORIES\n${bodies}` : ""}`, { acceptedRefs, rejectedRefs, acceptedMembers });
		},
	};

	const recall: AgentTool<typeof RecallSchema> = {
		name: "recall",
		label: "Recall memory",
		description: "Recall a 12-character memory id or run-local inactive_N alias. Inactive references expand their whole same-cue cohort.",
		parameters: RecallSchema,
		execute: async (_id, params: RecallArgs) => {
			const ids = resolveInactiveRef(params.id) ?? (/^[a-f0-9]{12}$/.test(params.id) && memoryExists(params.id) ? [params.id] : undefined);
			if (!ids?.length) return textResult(`Memory or inactive alias ${params.id} was not found.`);
			const expanded = unique(ids);
			for (const id of expanded) inspected.add(id);
			const descriptions = expanded.map((id) => {
				const memory = memoryById.get(id) ?? stagedReflections.get(id)!;
				const lifecycle = folded.lifecycleByMemoryId.get(id);
				return memoryLine(memory, lifecycle?.status ?? statusOf(id) ?? "active", lifecycle?.recallIf, lifecycle?.reason);
			}).join("\n");
			// Preserve exact source behavior for a direct durable id. Group aliases
			// intentionally return concise member bodies rather than all raw sources.
			let exact = "";
			if (expanded.length === 1 && /^[a-f0-9]{12}$/.test(expanded[0]) && !stagedReflections.has(expanded[0])) {
				const recalled = executeRecall({ id: expanded[0] }, () => snapshot, { librarian: true });
				exact = recalled.content.map((part) => part.text).join("\n");
			}
			return textResult(`RECALLED MEMORIES\n${descriptions}${exact ? `\n\nSOURCE CONTEXT\n${exact}` : ""}`, { ids: expanded });
		},
	};

	const done: AgentTool<typeof DoneSchema> = {
		name: "done",
		label: "Finish librarian pass",
		description: "Commit the staged plan and complete this librarian pass. Call alone, after all other tool results are visible.",
		parameters: DoneSchema,
		executionMode: "sequential",
		execute: async (_id, params: DoneArgs) => {
			doneSummary = params.summary.trim();
			return textResult("Librarian pass completed.", { completed: true }, true);
		},
	};

	const search = createSearchMemoriesAgentTool(() => snapshot, { librarian: true });
	const tools: AgentTool<any>[] = [recordReflection, deleteMemories, makeInactive, makeActive, search, recall, done];
	const activeTokens = activeMemories.reduce((sum, item) => sum + item.memory.tokenCount, 0);
	const newTokens = activeMemories.filter((item) => newMemoryIds.has(item.memory.id)).reduce((sum, item) => sum + item.memory.tokenCount, 0);
	const initialPrompt = buildLibrarianPrompt(sample, {
		activeTokens,
		targetTokens: args.targetTokens,
		contextWindow,
		newCount: newMemoryIds.size,
		newTokens,
		activeTokenSizes: activeMemories.map((item) => item.memory.tokenCount),
	});
	const history: AgentMessage[] = [];
	const loop = args.agentLoop ?? agentLoop;
	const reasoning = (args.model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;

	const runOnce = async (text: string): Promise<void> => {
		const prompt: Message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
		const context: AgentContext = { systemPrompt: LIBRARIAN_SYSTEM, messages: history.slice(), tools };
		let turnCount = 0;
		const config: AgentLoopConfig = {
			model: args.model,
			apiKey: args.apiKey,
			headers: args.headers,
			maxTokens: boundedMaxTokens(args.model, AGENT_LOOP_MAX_TOKENS),
			convertToLlm: (messages) => messages as Message[],
			toolExecution: "parallel",
			beforeToolCall: async ({ toolCall, context: toolContext }) => {
				if (toolCall.name !== "done") return undefined;
				const latest = [...toolContext.messages].reverse().find((message) => message.role === "assistant") as { content?: unknown } | undefined;
				const calls = Array.isArray(latest?.content) ? latest.content.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall") : [];
				if (calls.length > 1) return { block: true, reason: "Call done alone in a later response after sibling tool results are visible." };
				return undefined;
			},
			shouldStopAfterTurn: () => doneSummary !== undefined || (effectiveMaxTurns !== undefined && ++turnCount >= effectiveMaxTurns),
			...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		};
		history.push(prompt as AgentMessage);
		args.onMessages?.(history.slice());
		const stream = loop([prompt], context, config, args.signal, streamSimple);
		for await (const event of stream) logAgentStreamError("librarian", event);
		const messages = await stream.result();
		history.push(...messages);
		args.onMessages?.(history.slice());
		if (args.recordUsage) for (const message of messages) if (message.role === "assistant" && message.usage) args.recordUsage(message.usage);
	};

	await runOnce(initialPrompt);
	for (let invocation = 1; !doneSummary && invocation < LIBRARIAN_MAX_INVOCATIONS; invocation++) await runOnce(LIBRARIAN_CONTINUE);
	if (!doneSummary) {
		debugLog("librarian.incomplete", { stagedReflections: stagedReflections.size, stagedActions: stagedActions.length });
		return { completed: false, sample };
	}
	return {
		completed: true,
		sample,
		commit: {
			version: 1,
			reflections: Array.from(stagedReflections.values()),
			actions: stagedActions,
			coversUpToId,
			summary: doneSummary,
			createdAt: args.now ?? Date.now(),
		},
	};
}
