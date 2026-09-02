import { type Config, type ConfiguredModel, DEFAULTS, loadConfig } from "./config.js";

export type ResolveResult =
	| { ok: true; model: unknown; apiKey: string; headers?: Record<string, string> }
	| { ok: false; reason: string };

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer";

export const OM_SETTINGS = "om.settings";

function isConfiguredModel(value: unknown): value is ConfiguredModel {
	if (!value || typeof value !== "object") return false;
	const model = value as { provider?: unknown; id?: unknown; thinking?: unknown };
	return typeof model.provider === "string" && model.provider.length > 0 && typeof model.id === "string" && model.id.length > 0;
}

function normalizeSessionSettings(settings: SessionSettings, _baseConfig: Config): SessionSettings {
	return { ...settings };
}

export type SessionSettings = Partial<Pick<Config,
	| "observeAfterTokens" | "observerChunkMaxTokens" | "compactAfterTokens"
	| "compactAfterTokensMode" | "compactAfterTokensRatio"
	| "newMemoryPoolMaxTokens" | "oldMemoryPoolTargetTokens" | "agentMaxTurns"
	| "showWorkerNotifications" | "passive" | "compactionObserverEnabled" | "contemplatorEnabled" | "showContemplatorMessages" | "reviewerEnabled"
	| "contemplatorMinNewObservations" | "contemplatorMinTurns"
	| "summarizerEnabled" | "summarizerRetriggerTokens" | "summarizerSamplingThresholdTokens"
	| "debugLog"
>> & {
	/** null explicitly means use the configured/session model. */
	model?: ConfiguredModel | null;
	contemplatorModel?: ConfiguredModel | null;
	reviewerModel?: ConfiguredModel | null;
};

export interface ResolveCtx {
	model: unknown;
	modelRegistry: any;
	hasUI: boolean;
	ui?: { notify: Notify };
}

export interface LaunchCtx {
	hasUI: boolean;
	ui?: { notify: Notify };
}

export interface MemoryUpdateCtx extends LaunchCtx {
	cwd: string;
	model: unknown;
	modelRegistry: ResolveCtx["modelRegistry"];
	sessionManager: { getBranch(): readonly unknown[] };
}

export type SettingsUpdate = Partial<SessionSettings>;

export interface ObserverRunView {
	startedAt: number;
	completedAt?: number;
	status: "running" | "completed" | "failed";
	messages: readonly unknown[];
	chunkTokens: number;
	backlogTokens: number;
	sourceEntryIds: readonly string[];
	summary?: string;
	error?: string;
}

export interface SummarizerRunView {
	startedAt: number;
	completedAt?: number;
	status: "running" | "completed" | "incomplete" | "failed";
	messages: readonly unknown[];
	summary?: string;
	error?: string;
}

export interface ContemplatorRunState {
	running: boolean;
	pendingObservations: number;
	pendingReviews: number;
	/** Completed primary-model responses since the current completion/probe-delivery spacing anchor. */
	responsesSinceRun: number;
	waitingFor: "disabled" | "passive" | "observer" | "probe" | "memories" | "responses" | "ready" | "running" | "idle";
	lastStartedAt?: number;
	lastCompletedAt?: number;
	lastError?: string;
}

export interface LlmUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Number of LLM calls contributing to these totals. */
	runs: number;
}

export interface LlmUsageInput {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

/**
 * Merge session-scoped settings from branch entries into a plain settings object.
 * Compaction details.sessionSettings snapshots are point-in-time backups of the
 * in-memory overlay, which can lag out-of-band om.settings appends, so live
 * om.settings entries always win: snapshots are applied first, then live entries
 * last, regardless of branch position. Per-key application means a source only
 * overwrites keys it actually carries, so snapshot-only keys (whose original
 * om.settings entries were folded away pre-boundary) are still preserved. Used
 * both by restoreSessionSettings and by the compaction hook when baking the
 * snapshot for a new compaction entry, so the two always agree.
 */
export function computeSessionSettings(entries: readonly unknown[]): SessionSettings {
	const restored: SessionSettings = {};
	const snapshotSources: unknown[] = [];
	const liveSources: unknown[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown; details?: unknown };
		if (candidate.customType === OM_SETTINGS) liveSources.push(candidate.data);
		if (candidate.type === "compaction" && candidate.details && typeof candidate.details === "object") {
			snapshotSources.push((candidate.details as { sessionSettings?: unknown }).sessionSettings);
		}
	}
	const applySource = (source: unknown): void => {
		if (!source || typeof source !== "object") return;
		const data = source as Record<string, unknown>;
		const booleanKeys = [
			"showWorkerNotifications", "passive", "compactionObserverEnabled", "contemplatorEnabled", "showContemplatorMessages", "reviewerEnabled", "summarizerEnabled", "debugLog",
		] as const;
		const numberKeys = [
			"observeAfterTokens", "observerChunkMaxTokens", "compactAfterTokens",
			"newMemoryPoolMaxTokens", "oldMemoryPoolTargetTokens", "agentMaxTurns",
			"contemplatorMinNewObservations", "contemplatorMinTurns",
			"summarizerRetriggerTokens", "summarizerSamplingThresholdTokens",
		] as const;
		for (const key of booleanKeys) if (typeof data[key] === "boolean") restored[key] = data[key];
		for (const key of numberKeys) if (typeof data[key] === "number" && Number.isInteger(data[key]) && data[key] > 0) restored[key] = data[key];
		if (data.compactAfterTokensMode === "calibrated" || data.compactAfterTokensMode === "ratio") restored.compactAfterTokensMode = data.compactAfterTokensMode;
		if (typeof data.compactAfterTokensRatio === "number" && data.compactAfterTokensRatio > 0 && data.compactAfterTokensRatio < 1) restored.compactAfterTokensRatio = data.compactAfterTokensRatio;
		if (data.model === null) restored.model = null;
		else if (isConfiguredModel(data.model)) restored.model = data.model;
		if (data.contemplatorModel === null) restored.contemplatorModel = null;
		else if (isConfiguredModel(data.contemplatorModel)) restored.contemplatorModel = data.contemplatorModel;
		if (data.reviewerModel === null) restored.reviewerModel = null;
		else if (isConfiguredModel(data.reviewerModel)) restored.reviewerModel = data.reviewerModel;
	};
	for (const source of snapshotSources) applySource(source);
	for (const source of liveSources) applySource(source);
	return restored;
}

export class Runtime {
	config: Config = { ...DEFAULTS };
	private baseConfig: Config = { ...DEFAULTS };
	private sessionSettings: SessionSettings = {};
	configLoaded = false;
	consolidationInFlight = false;
	consolidationPromise: Promise<void> | null = null;
	reviewInFlight = false;
	reviewPromise: Promise<void> | null = null;
	/**
	 * Process-local single-flight lock for this session runtime. Every launch path
	 * must go through launchSummarizerTask; a second summarizer cannot start until
	 * the tracked promise's finally handler releases this lock.
	 */
	summarizerInFlight = false;
	summarizerPromise: Promise<void> | null = null;
	/** Old-pool token threshold for the next pass; undefined means configured target. */
	summarizerNextTriggerTokens: number | undefined;
	/** A scheduling checkpoint arrived while the single-flight summarizer lock was held. */
	summarizerRecheckPending = false;
	private memoryUpdateListener: ((ctx: MemoryUpdateCtx) => void) | undefined;
	private agentActivityListener: ((ctx: MemoryUpdateCtx) => void) | undefined;
	private settingsUpdateListener: ((ctx: MemoryUpdateCtx, settings: SettingsUpdate) => void) | undefined;
	private contextGeneration = 0;
	consolidationPhase: ConsolidationPhase | undefined;
	/** True only while the observer is draining the finite source snapshot captured at pipeline start. */
	observerBacklogBlocking = false;
	compactInFlight = false;
	compactRequested = false;
	/** Agent-authored instructions to deliver after an explicit compact_context request. */
	compactContinuationPrompt: string | undefined;
	compactOrigin: "proactive" | "agent-requested" | "length-stop" | undefined;
	compactHookInFlight = false;
	compactionResumePending = false;
	compactionResumeGeneration = 0;
	compactionResumeTimer: ReturnType<typeof setTimeout> | undefined;
	resolveFailureNotified = false;
	lastObserverError: string | undefined;
	lastSummarizerError: string | undefined;
	/** Wall-clock worker boundaries for launch-local status diagnostics. */
	lastObserverStartedAt: number | undefined;
	lastObserverCompletedAt: number | undefined;
	lastSummarizerStartedAt: number | undefined;
	lastSummarizerCompletedAt: number | undefined;
	/** Current or most recent observer chunk transcript in this launch/session context. */
	lastObserverRun: ObserverRunView | undefined;
	/** Most recent summarizer transcript in this extension launch/session context. */
	lastSummarizerRun: SummarizerRunView | undefined;
	/** Launch-local liveness and trigger diagnostics published by the contemplator. */
	contemplatorState: ContemplatorRunState = {
		running: false,
		pendingObservations: 0,
		pendingReviews: 0,
		responsesSinceRun: 0,
		waitingFor: "idle",
	};
	agentUsage: LlmUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, runs: 0 };

	/** Accumulate usage from one background LLM call. */
	recordAgentUsage(usage: LlmUsageInput): void {
		const totals = this.agentUsage;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.cost += usage.cost?.total ?? 0;
		totals.runs += 1;
	}

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.baseConfig = loadConfig(cwd);
		this.config = { ...this.baseConfig };
		this.configLoaded = true;
	}

	restoreSessionSettings(entries: readonly unknown[]): void {
		this.sessionSettings = normalizeSessionSettings(computeSessionSettings(entries), this.baseConfig);
		this.applySessionSettings();
	}

	private applySessionSettings(): void {
		const { model, contemplatorModel, reviewerModel, ...scalarSettings } = this.sessionSettings;
		this.config = {
			...this.baseConfig,
			...scalarSettings,
			...(model === undefined ? {} : { model: model ?? undefined }),
			...(contemplatorModel === undefined ? {} : { contemplatorModel: contemplatorModel ?? undefined }),
			...(reviewerModel === undefined ? {} : { reviewerModel: reviewerModel ?? undefined }),
		};
	}

	setSessionSettings(settings: SessionSettings): void {
		this.sessionSettings = normalizeSessionSettings({ ...this.sessionSettings, ...settings }, this.baseConfig);
		this.applySessionSettings();
	}

	getSessionSettings(): SessionSettings {
		return { ...this.sessionSettings };
	}

	getDefaultConfig(): Config {
		return { ...this.baseConfig };
	}

	advanceContextGeneration(): void {
		this.contextGeneration++;
		// A session switch (or reload/shutdown) invalidates any in-flight or pending
		// compaction state: compactRequested/compactInFlight/compactOrigin were set
		// against a different branch and would otherwise leak across sessions
		// (e.g. a request made in session A compacting session B's branch, or a
		// never-cleared compactInFlight bricking all future compactions).
		// Detach stale background tasks immediately. Their promise finalizers are
		// identity-guarded below, so an old session can never retain or later clear
		// a lock owned by the new session.
		this.consolidationInFlight = false;
		this.consolidationPromise = null;
		this.consolidationPhase = undefined;
		this.observerBacklogBlocking = false;
		this.summarizerInFlight = false;
		this.summarizerPromise = null;
		this.summarizerRecheckPending = false;
		this.reviewInFlight = false;
		this.reviewPromise = null;
		this.compactInFlight = false;
		this.compactRequested = false;
		this.compactContinuationPrompt = undefined;
		this.compactOrigin = undefined;
		this.compactionResumePending = false;
		this.compactionResumeGeneration += 1;
		if (this.compactionResumeTimer !== undefined) clearTimeout(this.compactionResumeTimer);
		this.compactionResumeTimer = undefined;
		this.summarizerNextTriggerTokens = undefined;
		this.lastObserverStartedAt = undefined;
		this.lastObserverCompletedAt = undefined;
		this.lastSummarizerStartedAt = undefined;
		this.lastSummarizerCompletedAt = undefined;
		this.lastObserverRun = undefined;
		this.lastSummarizerRun = undefined;
		this.contemplatorState = {
			running: false,
			pendingObservations: 0,
			pendingReviews: 0,
			responsesSinceRun: 0,
			waitingFor: "idle",
		};
	}

	getContextGeneration(): number {
		return this.contextGeneration;
	}

	async resolveModel(ctx: ResolveCtx & { configuredModel?: ConfiguredModel | null }): Promise<ResolveResult> {
		let model = ctx.model;
		const configuredModel = ctx.configuredModel === null
			? undefined
			: ctx.configuredModel ?? this.config.model;
		if (configuredModel) {
			const configured = ctx.modelRegistry.find(configuredModel.provider, configuredModel.id);
			if (configured) {
				model = configured;
			} else if (ctx.hasUI && ctx.ui) {
				ctx.ui.notify(
					`pi-contemplator: configured model ${configuredModel.provider}/${configuredModel.id} not found, using session model`,
					"warning",
				);
			}
		}
		if (!model) return { ok: false, reason: "no model available (session has no model and no observational-memory model configured)" };
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			const provider = (model as { provider?: string }).provider ?? "unknown";
			return { ok: false, reason: `no API key for provider "${provider}"` };
		}
		return { ok: true, model, apiKey: auth.apiKey as string, headers: auth.headers as Record<string, string> | undefined };
	}

	setMemoryUpdateListener(listener: (ctx: MemoryUpdateCtx) => void): void {
		this.memoryUpdateListener = listener;
	}

	notifyMemoryUpdate(ctx: MemoryUpdateCtx): void {
		this.memoryUpdateListener?.(ctx);
	}

	setAgentActivityListener(listener: (ctx: MemoryUpdateCtx) => void): void {
		this.agentActivityListener = listener;
	}

	notifyAgentActivity(ctx: MemoryUpdateCtx): void {
		this.agentActivityListener?.(ctx);
	}

	setSettingsUpdateListener(listener: (ctx: MemoryUpdateCtx, settings: SettingsUpdate) => void): void {
		this.settingsUpdateListener = listener;
	}

	notifySettingsUpdate(ctx: MemoryUpdateCtx, settings: SettingsUpdate): void {
		this.settingsUpdateListener?.(ctx, settings);
	}

	launchConsolidationTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> {
		this.consolidationInFlight = true;
		this.consolidationPhase = undefined;
		this.lastObserverError = undefined;
		const promise = this.launchTrackedTask(ctx, "consolidation", work, () => {
			if (this.consolidationPromise !== promise) return;
			this.consolidationInFlight = false;
			this.consolidationPhase = undefined;
			this.consolidationPromise = null;
		});
		this.consolidationPromise = promise;
		return promise;
	}

	launchSummarizerTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> | undefined {
		// This is the authoritative single-flight gate, not merely a UI flag.
		// Keep it here even though callers also avoid redundant launch attempts.
		if (this.summarizerInFlight) return undefined;
		this.summarizerInFlight = true;
		this.lastSummarizerError = undefined;
		const promise = this.launchTrackedTask(ctx, "summarizer", work, (error) => {
			if (this.summarizerPromise !== promise) return;
			this.summarizerInFlight = false;
			this.lastSummarizerError = error;
			this.summarizerPromise = null;
		});
		this.summarizerPromise = promise;
		return promise;
	}

	launchReviewTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> | undefined {
		// Structural reviews are intentionally serialized. Pending requests are
		// persisted in the session ledger and resumed after the active task exits.
		if (this.reviewInFlight) return undefined;
		this.reviewInFlight = true;
		const promise = this.launchTrackedTask(ctx, "structural review", work, () => {
			if (this.reviewPromise !== promise) return;
			this.reviewInFlight = false;
			this.reviewPromise = null;
		});
		this.reviewPromise = promise;
		return promise;
	}

	recordConsolidationStageError(ctx: LaunchCtx, phase: ConsolidationPhase, error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		this.lastObserverError = message;
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(`pi-contemplator: ${phase} failed: ${message}`, "warning");
		return message;
	}

	private launchTrackedTask(
		ctx: LaunchCtx,
		label: string,
		work: () => Promise<void>,
		onFinally: (error: string | undefined) => void,
	): Promise<void> {
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		return (async () => {
			let errorMessage: string | undefined;
			try {
				await work();
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				if (hasUI && ui) ui.notify(`pi-contemplator: ${label} failed: ${errorMessage}`, "warning");
			} finally {
				onFinally(errorMessage);
			}
		})();
	}
}
