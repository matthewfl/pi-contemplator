import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { newMemoryIdsSinceLibrarianCoverage, runLibrarian } from "../agents/librarian/agent.js";
import { runObserver } from "../agents/observer/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import type { ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_LIBRARIAN_COMMIT,
	OM_OBSERVATIONS_RECORDED,
	buildObservationsRecordedData,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	observationToSummaryLine,
	rawTokensSinceObservationCoverage,
	reflectionToSummaryLine,
	type Entry,
} from "../session-ledger/index.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

export type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	sessionManager: {
		getBranch: () => readonly unknown[];
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function anyStageDue(entries: Entry[], runtime: Runtime): boolean {
	return rawTokensSinceObservationCoverage(entries) >= runtime.config.observeAfterTokens;
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer") => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			return cached;
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", (event, ctx) => {
		launch(event, ctx);
		syncAndScheduleLibrarian(pi, runtime, ctx as ConsolidationCtx);
	});
	pi.on("turn_end", (event, ctx) => {
		launch(event, ctx);
		syncAndScheduleLibrarian(pi, runtime, ctx as ConsolidationCtx);
	});
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime)) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

export function launchCompactionObserver(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	branchEntries: Entry[],
): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true || runtime.consolidationInFlight) return;

	const lastCoverageIdx = latestCoverageIndex(branchEntries, OM_OBSERVATIONS_RECORDED);
	if (sourceEntriesAfter(branchEntries, lastCoverageIdx).length === 0) return;

	const runId = `compaction-observer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, ctx, {
			forceObserver: true,
			observerEntries: branchEntries,
			observerOnly: true,
		});
	}));
}

export type ConsolidationPipelineOptions = {
	forceObserver?: boolean;
	observerEntries?: Entry[];
	observerOnly?: boolean;
};

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	options: ConsolidationPipelineOptions = {},
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);
	const contextGeneration = runtime.getContextGeneration();

	const beforeFold = foldLedger(ctx.sessionManager.getBranch() as Entry[]);
	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel, {
			force: options.forceObserver === true,
			entries: options.observerEntries,
			contextGeneration,
		});
		if (observerOutcome === "abort") return;
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}
	const afterFold = foldLedger(ctx.sessionManager.getBranch() as Entry[]);
	const beforeIds = new Set(beforeFold.observations.map((item) => item.id));
	const added = afterFold.observations.filter((item) => !beforeIds.has(item.id));
	if (added.length > 0 && typeof (runtime as Runtime & { markLibrarianDirty?: unknown }).markLibrarianDirty === "function") {
		runtime.markLibrarianDirty(added.length, added.reduce((sum, item) => sum + item.tokenCount, 0));
		scheduleLibrarian(pi, runtime, ctx);
	}
	if (contextGeneration === runtime.getContextGeneration()) runtime.notifyMemoryUpdate?.(ctx);
}

function activeMemoryTokens(entries: Entry[]): number {
	const folded = foldLedger(entries);
	return [...folded.activeObservations, ...folded.activeReflections].reduce((sum, item) => sum + item.tokenCount, 0);
}

export function librarianScheduleDelayMs(runtime: Runtime, activeTokens: number, now = Date.now()): number | undefined {
	if (!runtime.config.librarianEnabled || runtime.librarianDirtySince === undefined) return undefined;
	const minute = 60_000;
	// A very fast session can fill the active pool long before a wall-clock
	// interval expires. The emergency pending-token threshold therefore bypasses
	// the normal minimum interval and schedules the next available pass now.
	if (runtime.librarianPendingTokens >= runtime.config.librarianMaxPendingMemoryTokens) return 0;
	const minimumAt = (runtime.librarianLastStartedAt ?? Number.NEGATIVE_INFINITY) + runtime.config.librarianMinIntervalMinutes * minute;
	const pressureThreshold = runtime.config.observationsPoolTargetTokens * runtime.config.librarianPressureTriggerRatio;
	const thresholdReady = runtime.librarianPendingTokens >= runtime.config.librarianMinNewMemoryTokens || activeTokens >= pressureThreshold;
	const maximumAt = runtime.librarianDirtySince + runtime.config.librarianMaxDelayMinutes * minute;
	const desiredAt = thresholdReady ? now : maximumAt;
	return Math.max(0, Math.max(minimumAt, desiredAt) - now);
}

function syncAndScheduleLibrarian(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive || !runtime.config.librarianEnabled) return;
	if (runtime.librarianDirtySince === undefined) {
		const entries = ctx.sessionManager.getBranch() as Entry[];
		const newIds = newMemoryIdsSinceLibrarianCoverage(entries);
		if (newIds.size > 0) {
			const folded = foldLedger(entries);
			let tokens = 0;
			for (const id of newIds) tokens += folded.observationsById.get(id)?.tokenCount ?? folded.reflectionsById.get(id)?.tokenCount ?? 0;
			runtime.markLibrarianDirty(newIds.size, tokens);
		}
	}
	scheduleLibrarian(pi, runtime, ctx);
}

export function scheduleLibrarian(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx, now = Date.now()): void {
	if (runtime.config.passive || !runtime.config.librarianEnabled || runtime.librarianInFlight || runtime.librarianDirtySince === undefined) return;
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const delay = librarianScheduleDelayMs(runtime, activeMemoryTokens(entries), now);
	if (delay === undefined) return;
	if (runtime.librarianTimer !== undefined) clearTimeout(runtime.librarianTimer);
	const generation = runtime.getContextGeneration();
	if (delay > 0) {
		runtime.librarianTimer = setTimeout(() => {
			runtime.librarianTimer = undefined;
			if (generation !== runtime.getContextGeneration()) return;
			scheduleLibrarian(pi, runtime, ctx);
		}, delay);
		return;
	}

	const capturedCount = runtime.librarianPendingCount;
	const capturedTokens = runtime.librarianPendingTokens;
	runtime.clearLibrarianDirty();
	const runId = `librarian-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchLibrarianTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		let completed = false;
		try {
			const resolved = await runtime.resolveModel({ model: ctx.model, modelRegistry: ctx.modelRegistry, hasUI: ctx.hasUI, ui: ctx.ui });
			if (!resolved.ok) {
				debugLog("librarian.model_unavailable", { reason: resolved.reason });
				return;
			}
			if (generation !== runtime.getContextGeneration()) return;
			if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify("Observational memory: librarian running", "info");
			const result = await runLibrarian({
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				getBranch: () => ctx.sessionManager.getBranch() as Entry[],
				targetTokens: runtime.config.observationsPoolTargetTokens,
				samplingThresholdRatio: runtime.config.librarianSamplingThresholdRatio,
				fairness: runtime.librarianFairness,
				maxTurns: runtime.config.agentMaxTurns,
				thinkingLevel: runtime.config.model?.thinking ?? "low",
				recordUsage: (usage) => runtime.recordAgentUsage(usage),
			});
			if (generation !== runtime.getContextGeneration()) return;
			if (!result.completed || !result.commit) return;
			pi.appendEntry(OM_LIBRARIAN_COMMIT, result.commit);
			completed = true;
			debugLog("librarian.appended", { reflections: result.commit.reflections.length, actions: result.commit.actions.length, sampled: result.sample?.sampled ?? false });
			if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`Observational memory: librarian completed — ${result.commit.reflections.length} reflection${result.commit.reflections.length === 1 ? "" : "s"}, ${result.commit.actions.length} lifecycle action${result.commit.actions.length === 1 ? "" : "s"}`, "info");
			runtime.notifyMemoryUpdate(ctx);
		} finally {
			if (!completed && generation === runtime.getContextGeneration()) runtime.markLibrarianDirty(capturedCount, capturedTokens);
			setTimeout(() => {
				if (generation === runtime.getContextGeneration()) scheduleLibrarian(pi, runtime, ctx);
			}, 0);
		}
	}));
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
	options: { force?: boolean; entries?: Entry[]; contextGeneration?: number } = {},
): Promise<StageOutcome> {
	const entries = options.entries ?? (ctx.sessionManager.getBranch() as Entry[]);
	const tokens = rawTokensSinceObservationCoverage(entries);
	if (!options.force && tokens < runtime.config.observeAfterTokens) return "continue";

	// Resolve the model before building the chunk: the default chunk cap
	// derives from the resolved model's context window.
	const resolved = await resolveModel("observer");
	if (!resolved) return "abort";
	if (options.contextGeneration !== undefined && options.contextGeneration !== runtime.getContextGeneration()) {
		debugLog("observer.stale", { reason: "session_or_branch_changed" });
		return "abort";
	}

	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx);

	// Budget the text that is actually sent to the observer, including source
	// labels and rendered message content. Complete entries are kept intact.
	// Only a first entry that cannot fit by itself is represented by a clearly
	// marked head/tail excerpt; the original ledger entry remains untouched.
	const contextWindow = (resolved.model as { contextWindow?: number }).contextWindow;
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const {
		text: chunk,
		sourceEntryIds,
		estimatedTokens: chunkTokens,
		truncatedSourceEntryIds,
	} = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
	if (!chunk.trim() || sourceEntryIds.length === 0) return "continue";
	const coversUpToId = sourceEntryIds.at(-1);
	if (!coversUpToId) return "continue";

	if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
		debugLog("observer.chunk_capped", {
			maxChunkTokens,
			backlogEntries: backlogEntries.length,
			backlogTokens: tokens,
			chunkEntries: sourceEntryIds.length,
			chunkTokens,
			truncatedSourceEntryIds,
		});
	}

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
	});

	const observations = await runObserver({
		model: resolved.model as any,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
		priorReflections,
		priorObservations,
		chunk,
		allowedSourceEntryIds: sourceEntryIds,
		maxTurns: runtime.config.agentMaxTurns,
		thinkingLevel: runtime.config.model?.thinking ?? "low",
		recordUsage: (usage) => runtime.recordAgentUsage(usage),
	});
	if (options.contextGeneration !== undefined && options.contextGeneration !== runtime.getContextGeneration()) {
		debugLog("observer.stale", { reason: "session_or_branch_changed" });
		return "abort";
	}
	if (!observations || observations.length === 0) {
		debugLog("observer.empty", { coversUpToId });
		if (ctx.hasUI) ctx.ui?.notify(
			"Observational memory: observer returned no observations",
			"warning",
		);
		return "continue";
	}

	const currentEntries = ctx.sessionManager.getBranch() as Entry[];
	let effectiveCoversUpToId = coversUpToId;
	if (!currentEntries.some((entry) => entry.id === coversUpToId)) {
		// A fire-and-forget compaction observer may finish after compaction has
		// folded its source target away. Never append an unresolvable marker: it
		// would make these observations invisible to projection and recall.
		const compaction = [...currentEntries].reverse().find((entry) => entry.type === "compaction");
		effectiveCoversUpToId = compaction?.id ?? currentEntries.at(-1)?.id ?? coversUpToId;
		debugLog("observer.coverage_target_folded", {
			requestedCoversUpToId: coversUpToId,
			effectiveCoversUpToId,
			compactionId: compaction?.id,
		});
	}
	const data = buildObservationsRecordedData(observations, effectiveCoversUpToId);
	if (!data) return "continue";
	debugLog("observer.records", {
		count: observations.length,
		observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId: effectiveCoversUpToId,
	});
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: observations.length, coversUpToId: effectiveCoversUpToId });
	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
		"info",
	);
	return "continue";
}
