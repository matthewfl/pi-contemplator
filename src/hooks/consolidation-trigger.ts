import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runSummarizer } from "../agents/summarizer/agent.js";
import { runObserver } from "../agents/observer/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import type { ResolveResult, Runtime } from "../runtime.js";
import { createWorkerStallWatchdog } from "../worker-watchdog.js";
import { boundedMaxTokens, OBSERVER_AGENT_LOOP_MAX_TOKENS } from "../model-budget.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_SUMMARIZER_COMMIT,
	OM_OBSERVATIONS_RECORDED,
	buildObservationsRecordedData,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	observationToSummaryLine,
	partitionMemoryPools,
	rawTokensSinceObservationCoverage,
	rawTokensSinceObservationCoverageThrough,
	summaryToSummaryLine,
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

/** Abort only when a summarizer produces no stream/message progress for this long. */
export const SUMMARIZER_STALL_TIMEOUT_MS = 15 * 60_000;

export function createSummarizerStallWatchdog(
	timeoutMs: number,
	onStall: (signal: AbortSignal) => void,
) {
	let watchdog!: ReturnType<typeof createWorkerStallWatchdog>;
	watchdog = createWorkerStallWatchdog("summarizer", timeoutMs, () => onStall(watchdog.signal));
	return watchdog;
}

function sourceEntriesAfter(entries: Entry[], index: number, throughEntryId?: string): Entry[] {
	const throughIndex = throughEntryId === undefined
		? entries.length - 1
		: entries.findIndex((entry) => entry.id === throughEntryId);
	if (throughIndex < 0 || throughIndex <= index) return [];
	return entries.slice(index + 1, throughIndex + 1).filter(isSourceEntry);
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

function configuredMemoryWorkerModel(runtime: Runtime, worker: "observer" | "summarizer") {
	return typeof runtime.configuredMemoryWorkerModel === "function"
		? runtime.configuredMemoryWorkerModel(worker)
		: runtime.config[worker === "observer" ? "observerModel" : "summarizerModel"] ?? runtime.config.model ?? null;
}

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): (stage: "observer") => Promise<ResolvedModel | undefined> {
	let cached: ResolveResult | undefined;
	return async (stage) => {
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
			configuredModel: configuredMemoryWorkerModel(runtime, "observer"),
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			return cached;
		}
		runtime.lastObserverError = cached.reason;
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`pi-contemplator: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("session_start", (event, ctx) => {
		launch(event, ctx);
		syncAndScheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
	pi.on("session_tree", (event, ctx) => {
		launch(event, ctx);
		syncAndScheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
	pi.on("agent_start", (event, ctx) => {
		launch(event, ctx);
		syncAndScheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
	pi.on("turn_end", (event, ctx) => {
		launch(event, ctx);
		syncAndScheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
	runtime.setAgentActivityListener((ctx) => {
		runtime.ensureConfig(ctx.cwd);
		// Long autonomous turns may run for hours without agent_start/turn_end.
		// Re-evaluate both source coverage and memory pressure at every primary
		// progress checkpoint so neither worker can silently stop for the turn.
		maybeLaunchConsolidation(pi, runtime, ctx as ConsolidationCtx);
		scheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
	});
	runtime.setSettingsUpdateListener((ctx, settings) => {
		const affectsScheduling = settings.summarizerEnabled !== undefined ||
			settings.newMemoryPoolMaxTokens !== undefined ||
			settings.oldMemoryPoolTargetTokens !== undefined ||
			settings.summarizerRetriggerTokens !== undefined;
		if (!affectsScheduling) return;
		runtime.ensureConfig(ctx.cwd);
		// A changed pool boundary starts a fresh threshold cycle.
		runtime.summarizerNextTriggerTokens = undefined;
		scheduleSummarizer(pi, runtime, ctx as ConsolidationCtx);
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
	const launchGeneration = runtime.getContextGeneration();
	const task = runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
	// launchTrackedTask releases its lock before this continuation. If observer
	// setup failed before coverage could move, wake the contemplator once in
	// degraded mode rather than leaving all advisory work gated forever. Future
	// primary activity still retries the observer.
	void task.then(() => {
		if (launchGeneration !== runtime.getContextGeneration()) return;
		if (runtime.lastObserverError) {
			runtime.notifyMemoryUpdate(ctx);
			return;
		}
		// Source appended while the finite catch-up snapshot was running belongs
		// to a later snapshot. Recheck after the lock is released; the completed
		// pipeline has already given the contemplator its memory-update opportunity.
		maybeLaunchConsolidation(pi, runtime, ctx);
	});
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

export function shouldScheduleSummarizerFromObserver(options: ConsolidationPipelineOptions): boolean {
	return options.observerOnly !== true;
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	options: ConsolidationPipelineOptions = {},
): Promise<void> {
	const resolveModel = makeModelResolver(runtime, ctx);
	const contextGeneration = runtime.getContextGeneration();

	const pipelineEntries = options.observerEntries ?? (ctx.sessionManager.getBranch() as Entry[]);
	const initialCoverage = latestCoverageIndex(pipelineEntries, OM_OBSERVATIONS_RECORDED);
	const catchUpThroughId = sourceEntriesAfter(pipelineEntries, initialCoverage).at(-1)?.id;
	runtime.consolidationPhase = "observer";
	runtime.observerBacklogBlocking = catchUpThroughId !== undefined;
	try {
		// Drain only the finite source snapshot captured at pipeline launch, using
		// bounded oldest-first chunks. Concurrent source belongs to a later pipeline,
		// so a fast primary agent cannot indefinitely extend this blocking backlog.
		// A static compaction snapshot is intentionally processed only once. Coverage
		// must advance on every iteration, otherwise stop rather than spin.
		while (true) {
			const beforeEntries = ctx.sessionManager.getBranch() as Entry[];
			const beforeCoverage = latestCoverageIndex(beforeEntries, OM_OBSERVATIONS_RECORDED);
			const beforeObservationIds = new Set(foldLedger(beforeEntries).observations.map((memory) => memory.id));
			const observerOutcome = await runObserverStage(pi, runtime, ctx, resolveModel, {
				force: options.forceObserver === true,
				entries: options.observerEntries,
				throughSourceEntryId: options.observerEntries ? undefined : catchUpThroughId,
				contextGeneration,
			});
			if (observerOutcome === "abort") return;

			const afterEntries = ctx.sessionManager.getBranch() as Entry[];
			if (shouldScheduleSummarizerFromObserver(options)) {
				const passAddedObservations = foldLedger(afterEntries).observations.some((memory) => !beforeObservationIds.has(memory.id));
				// A finite observer backlog can take hours to drain while the primary
				// agent is idle. Let each completed chunk feed the independent
				// summarizer; waiting for the entire observer pipeline can otherwise
				// leave an oversized old pool untouched indefinitely.
				if (passAddedObservations) scheduleSummarizer(pi, runtime, ctx);
			}
			if (options.observerEntries) break;

			const afterCoverage = latestCoverageIndex(afterEntries, OM_OBSERVATIONS_RECORDED);
			const remainingTokens = catchUpThroughId === undefined
				? 0
				: rawTokensSinceObservationCoverageThrough(afterEntries, catchUpThroughId);
			if (afterCoverage <= beforeCoverage || remainingTokens < runtime.config.observeAfterTokens) break;
			debugLog("observer.backlog_continue", { remainingTokens, afterCoverage });
		}
	} catch (error) {
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	} finally {
		// New source appended after catchUpThroughId was never part of this
		// pipeline's blocking backlog. Clear before notifying the contemplator.
		if (contextGeneration === runtime.getContextGeneration()) runtime.observerBacklogBlocking = false;
	}
	if (contextGeneration === runtime.getContextGeneration()) runtime.notifyMemoryUpdate?.(ctx);
}

export function currentMemoryPools(runtime: Runtime, entries: Entry[]) {
	const folded = foldLedger(entries);
	return partitionMemoryPools(
		folded.activeObservations,
		folded.activeSummaries,
		runtime.config.newMemoryPoolMaxTokens,
	);
}

export function summarizerTriggerTokens(runtime: Runtime): number {
	return runtime.summarizerNextTriggerTokens ?? runtime.config.oldMemoryPoolTargetTokens;
}

export function nextSummarizerTriggerTokens(targetTokens: number, postRunOldTokens: number, retriggerTokens: number): number {
	return postRunOldTokens <= targetTokens
		? targetTokens
		: Math.max(targetTokens, postRunOldTokens + retriggerTokens);
}

/** Failed/incomplete launches must remain eligible at the prior threshold. */
export function summarizerTriggerAfterRun(
	successfullyCompleted: boolean,
	currentTriggerTokens: number | undefined,
	targetTokens: number,
	postRunOldTokens: number,
	retriggerTokens: number,
	failedAttemptStartOldTokens?: number,
): number | undefined {
	if (successfullyCompleted) return nextSummarizerTriggerTokens(targetTokens, postRunOldTokens, retriggerTokens);
	if (failedAttemptStartOldTokens === undefined) return currentTriggerTokens;
	// Back off a model pass from the pool it actually received. Growth that
	// arrived while it was running must count toward the retry rather than being
	// swallowed by a threshold based on the larger post-run pool.
	return Math.max(currentTriggerTokens ?? targetTokens, failedAttemptStartOldTokens + retriggerTokens);
}

function syncAndScheduleSummarizer(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	scheduleSummarizer(pi, runtime, ctx);
}

export function scheduleSummarizer(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	if (runtime.config.passive || !runtime.config.summarizerEnabled) return;
	if (runtime.summarizerInFlight) {
		// Do not lose observer/activity checkpoints that arrive during a long run.
		// The tracked task rechecks once its single-flight lock has been released.
		runtime.summarizerRecheckPending = true;
		return;
	}
	runtime.summarizerRecheckPending = false;
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const pools = currentMemoryPools(runtime, entries);
	const targetTokens = runtime.config.oldMemoryPoolTargetTokens;
	const nextTriggerTokens = summarizerTriggerTokens(runtime);
	// Initial/healthy eligibility strictly exceeds the advisory target. Once a
	// growth backoff is installed, reaching that +N threshold is sufficient; it
	// must not require an accidental extra token beyond the configured amount.
	if (pools.oldTokens <= targetTokens || nextTriggerTokens > targetTokens && pools.oldTokens < nextTriggerTokens) return;
	const runStartOldTokens = pools.oldTokens;
	const generation = runtime.getContextGeneration();
	const runId = `summarizer-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const sessionMetadata = debugSessionMetadata(ctx);
	const task = runtime.launchSummarizerTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		let stalled = false;
		let successfullyCompleted = false;
		let modelRunAttempted = false;
		let disposeStallWatchdog = () => {};
		let acceptsSummarizerMessages = true;
		const startedAt = Date.now();
		runtime.lastSummarizerStartedAt = startedAt;
		runtime.lastSummarizerRun = { startedAt, status: "running", messages: [] };
		try {
			const resolved = await runtime.resolveModel({
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				hasUI: ctx.hasUI,
				ui: ctx.ui,
				configuredModel: configuredMemoryWorkerModel(runtime, "summarizer"),
			});
			if (!resolved.ok) {
				debugLog("summarizer.model_unavailable", { reason: resolved.reason });
				runtime.lastSummarizerRun = { startedAt, status: "failed", messages: [], error: resolved.reason };
				return;
			}
			if (generation !== runtime.getContextGeneration()) return;
			if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify("pi-contemplator: summarizer running", "info");
			const watchdog = createSummarizerStallWatchdog(SUMMARIZER_STALL_TIMEOUT_MS, (signal) => {
				stalled = true;
				const reason = signal.reason instanceof Error ? signal.reason.message : "summarizer stalled";
				debugLog("summarizer.stalled", { reason });
				if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`pi-contemplator: ${reason}; cancelling and leaving the backlog eligible for retry`, "warning");
			});
			disposeStallWatchdog = watchdog.dispose;
			modelRunAttempted = true;
			const result = await watchdog.race(runSummarizer({
				signal: watchdog.signal,
				model: resolved.model as any,
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				getBranch: () => ctx.sessionManager.getBranch() as Entry[],
				targetTokens: runtime.config.oldMemoryPoolTargetTokens,
				newPoolMaxTokens: runtime.config.newMemoryPoolMaxTokens,
				samplingThresholdTokens: runtime.config.summarizerSamplingThresholdTokens,
				maxTurns: runtime.config.agentMaxTurns,
				// Summarization is a bounded extraction/compression task. Extended
				// reasoning made models draft for too long instead of registering work.
				thinkingLevel: "off",
				recordUsage: (usage) => runtime.recordAgentUsage(usage),
				onMessages: (messages) => {
					watchdog.progress();
					if (acceptsSummarizerMessages && generation === runtime.getContextGeneration()) runtime.lastSummarizerRun = { startedAt, status: "running", messages: messages.slice() };
				},
			}));
			if (generation !== runtime.getContextGeneration()) return;
			if (!result.completed) {
				runtime.lastSummarizerRun = stalled
					? { ...runtime.lastSummarizerRun!, status: "failed", error: "Summarizer stalled and was cancelled; memory remains eligible for retry." }
					: { ...runtime.lastSummarizerRun!, status: "incomplete" };
				return;
			}
			if (result.commit) {
				pi.appendEntry(OM_SUMMARIZER_COMMIT, result.commit);
				successfullyCompleted = true;
				const summary = `${result.commit.summaries.length} summaries consumed ${result.commit.metrics.consumedMemoryCount} memories, reducing visible memory by ~${result.commit.metrics.estimatedTokenReduction.toLocaleString()} tokens.`;
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun!, status: "completed", summary };
				debugLog("summarizer.appended", { summaries: result.commit.summaries.length, consumed: result.commit.metrics.consumedMemoryCount, sampled: result.sample?.sampled ?? false });
				if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(`pi-contemplator: summarizer completed — ${summary}`, "info");
				// Summaries compact older memories; they are not new events and must not
				// wake or enter the contemplator's incremental update stream.
			} else {
				successfullyCompleted = true;
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun!, status: "completed", summary: "No safe summaries were created." };
				if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify("pi-contemplator: summarizer completed — no safe summaries", "info");
			}
		} catch (error) {
			if (generation === runtime.getContextGeneration() && runtime.lastSummarizerRun) {
				runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun, status: "failed", error: error instanceof Error ? error.message : String(error) };
			}
			throw error;
		} finally {
			acceptsSummarizerMessages = false;
			disposeStallWatchdog();
			if (generation === runtime.getContextGeneration()) {
				const completedAt = Date.now();
				runtime.lastSummarizerCompletedAt = completedAt;
				if (runtime.lastSummarizerRun) runtime.lastSummarizerRun = { ...runtime.lastSummarizerRun, completedAt };
				const postRunPools = currentMemoryPools(runtime, ctx.sessionManager.getBranch() as Entry[]);
				const target = runtime.config.oldMemoryPoolTargetTokens;
				runtime.summarizerNextTriggerTokens = summarizerTriggerAfterRun(
					successfullyCompleted,
					runtime.summarizerNextTriggerTokens,
					target,
					postRunPools.oldTokens,
					runtime.config.summarizerRetriggerTokens,
					// A failed/no-progress model pass should not retry an identical
					// prompt at every checkpoint. Anchor the growth backoff to the pool
					// seen at launch so concurrent growth is not accidentally erased.
					modelRunAttempted ? runStartOldTokens : undefined,
				);
			}
		}
	}));
	void task?.then(() => {
		if (generation !== runtime.getContextGeneration()) return;
		if (!runtime.summarizerRecheckPending) return;
		// launchTrackedTask has released summarizerInFlight before resolving.
		// Coalesce every checkpoint received during the old run into one fresh
		// ledger/threshold evaluation.
		runtime.summarizerRecheckPending = false;
		scheduleSummarizer(pi, runtime, ctx);
	});
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolveModel: (stage: "observer") => Promise<ResolvedModel | undefined>,
	options: { force?: boolean; entries?: Entry[]; throughSourceEntryId?: string; contextGeneration?: number } = {},
): Promise<StageOutcome> {
	const entries = options.entries ?? (ctx.sessionManager.getBranch() as Entry[]);
	const tokens = options.throughSourceEntryId === undefined
		? rawTokensSinceObservationCoverage(entries)
		: rawTokensSinceObservationCoverageThrough(entries, options.throughSourceEntryId);
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
	const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx, options.throughSourceEntryId);

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
	const priorSummaries = memory.summaries.map(summaryToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`pi-contemplator: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		requestedMaxOutputTokens: OBSERVER_AGENT_LOOP_MAX_TOKENS,
		effectiveMaxOutputTokens: boundedMaxTokens(resolved.model as any, OBSERVER_AGENT_LOOP_MAX_TOKENS),
		advertisedModelMaxTokens: (resolved.model as { maxTokens?: number }).maxTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorSummaries: priorSummaries.length,
		priorObservations: priorObservations.length,
	});

	const observerStartedAt = Date.now();
	runtime.lastObserverStartedAt = observerStartedAt;
	// Clear the previous end when a new chunk starts so /om:status never pairs
	// this chunk's start with the preceding chunk's completion.
	runtime.lastObserverCompletedAt = undefined;
	runtime.lastObserverRun = {
		startedAt: observerStartedAt,
		status: "running",
		messages: [],
		chunkTokens,
		backlogTokens: tokens,
		sourceEntryIds: sourceEntryIds.slice(),
	};
	let acceptsObserverMessages = true;
	let observations;
	let failedMessage: string | undefined;
	const observerWatchdog = createWorkerStallWatchdog("observer");
	try {
		observations = await observerWatchdog.race(runObserver({
			model: resolved.model as any,
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			priorSummaries,
			priorObservations,
			chunk,
			allowedSourceEntryIds: sourceEntryIds,
			maxTurns: runtime.config.agentMaxTurns,
			thinkingLevel: runtime.config.observerModel?.thinking ?? runtime.config.model?.thinking ?? "low",
			recordUsage: (usage) => runtime.recordAgentUsage(usage),
			onProgress: observerWatchdog.progress,
			onMessages: (messages) => {
				if (!acceptsObserverMessages || options.contextGeneration !== undefined && options.contextGeneration !== runtime.getContextGeneration()) return;
				runtime.lastObserverRun = {
					startedAt: observerStartedAt,
					status: "running",
					messages: messages.slice(),
					chunkTokens,
					backlogTokens: tokens,
					sourceEntryIds: sourceEntryIds.slice(),
				};
			},
			signal: observerWatchdog.signal,
		}));
	} catch (error) {
		// A permanently pathological old chunk must not pin every newer source
		// entry and block the contemplator forever. Accepted observations are
		// already returned normally by runObserver; only a zero-progress failure
		// reaches here. Record the failure visibly, then advance this bounded
		// range with an empty coverage marker so catch-up can continue.
		failedMessage = runtime.recordConsolidationStageError(ctx, "observer", error);
		debugLog("observer.failed_chunk_advanced", {
			failedMessage,
			coversUpToId,
			sourceEntryIds,
			chunkTokens,
		});
		observations = undefined;
		if (runtime.lastObserverRun?.startedAt === observerStartedAt) {
			runtime.lastObserverRun = { ...runtime.lastObserverRun, status: "failed", error: failedMessage };
		}
	} finally {
		acceptsObserverMessages = false;
		observerWatchdog.dispose();
		if (options.contextGeneration === undefined || options.contextGeneration === runtime.getContextGeneration()) {
			const completedAt = Date.now();
			runtime.lastObserverCompletedAt = completedAt;
			if (runtime.lastObserverRun?.startedAt === observerStartedAt) {
				runtime.lastObserverRun = { ...runtime.lastObserverRun, completedAt };
			}
		}
	}
	if (options.contextGeneration !== undefined && options.contextGeneration !== runtime.getContextGeneration()) {
		debugLog("observer.stale", { reason: "session_or_branch_changed" });
		return "abort";
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
	const accepted = observations ?? [];
	if (!failedMessage && runtime.lastObserverRun?.startedAt === observerStartedAt) {
		runtime.lastObserverRun = {
			...runtime.lastObserverRun,
			status: "completed",
			summary: accepted.length > 0
				? `${accepted.length} observation${accepted.length === 1 ? "" : "s"} recorded; chunk covered through ${effectiveCoversUpToId}.`
				: `No observations recorded; chunk covered through ${effectiveCoversUpToId}.`,
		};
	}
	const data = buildObservationsRecordedData(accepted, effectiveCoversUpToId);
	if (!data) return "continue";
	debugLog(failedMessage ? "observer.failed_coverage" : accepted.length > 0 ? "observer.records" : "observer.coverage_only", {
		count: accepted.length,
		observationTokens: accepted.reduce((sum, observation) => sum + observation.tokenCount, 0),
		coversUpToId: effectiveCoversUpToId,
		...(failedMessage ? { failedMessage } : {}),
	});
	// A clean zero-observation verdict and a zero-progress failed chunk both use
	// an empty coverage marker. This prevents low-information or pathological old
	// source from pinning the entire observer/contemplator pipeline forever.
	appendEntry(pi, OM_OBSERVATIONS_RECORDED, data);
	debugLog("observer.appended", { count: accepted.length, coversUpToId: effectiveCoversUpToId });
	if (!failedMessage && shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		accepted.length > 0
			? `pi-contemplator: ${accepted.length} observation${accepted.length === 1 ? "" : "s"} recorded`
			: "pi-contemplator: observer found no new information; processed chunk marked covered",
		"info",
	);
	return "continue";
}
