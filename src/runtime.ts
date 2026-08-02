import { type Config, type ConfiguredModel, DEFAULTS, loadConfig } from "./config.js";

export type ResolveResult =
	| { ok: true; model: unknown; apiKey: string; headers?: Record<string, string> }
	| { ok: false; reason: string };

type NotifyLevel = "warning" | "info" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;
export type ConsolidationPhase = "observer" | "reflector" | "dropper";

export const OM_SETTINGS = "om.settings";

function isConfiguredModel(value: unknown): value is ConfiguredModel {
	if (!value || typeof value !== "object") return false;
	const model = value as { provider?: unknown; id?: unknown; thinking?: unknown };
	return typeof model.provider === "string" && model.provider.length > 0 && typeof model.id === "string" && model.id.length > 0;
}

function normalizeSessionSettings(settings: SessionSettings, baseConfig: Config): SessionSettings {
	const normalized = { ...settings };
	if (normalized.observationsPoolMaxTokens !== undefined && normalized.observationsPoolMaxTokens < 2) {
		delete normalized.observationsPoolMaxTokens;
	}
	const maxTokens = normalized.observationsPoolMaxTokens ?? baseConfig.observationsPoolMaxTokens;
	const targetTokens = normalized.observationsPoolTargetTokens ?? baseConfig.observationsPoolTargetTokens;
	if (normalized.observationsPoolMaxTokens !== undefined && targetTokens >= maxTokens) {
		normalized.observationsPoolTargetTokens = Math.floor(maxTokens / 2);
	} else if (normalized.observationsPoolTargetTokens !== undefined && normalized.observationsPoolTargetTokens >= maxTokens) {
		delete normalized.observationsPoolTargetTokens;
	}
	return normalized;
}

export type SessionSettings = Partial<Pick<Config,
	| "observeAfterTokens" | "reflectAfterTokens" | "observerChunkMaxTokens" | "compactAfterTokens"
	| "compactAfterTokensMode" | "compactAfterTokensRatio"
	| "observationsPoolMaxTokens" | "observationsPoolTargetTokens" | "agentMaxTurns"
	| "showWorkerNotifications" | "passive" | "compactionObserverEnabled" | "contemplatorEnabled"
	| "contemplatorMinNewObservations" | "contemplatorMinNewReflections" | "contemplatorMinTurns" | "debugLog"
>> & {
	/** null explicitly means use the configured/session model. */
	model?: ConfiguredModel | null;
	contemplatorModel?: ConfiguredModel | null;
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

export interface LlmUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Number of LLM calls contributing to these totals. */
	runs: number;
}

export class Runtime {
	config: Config = { ...DEFAULTS };
	private baseConfig: Config = { ...DEFAULTS };
	private sessionSettings: SessionSettings = {};
	configLoaded = false;
	consolidationInFlight = false;
	consolidationPromise: Promise<void> | null = null;
	private memoryUpdateListener: ((ctx: MemoryUpdateCtx) => void) | undefined;
	private contextGeneration = 0;
	consolidationPhase: ConsolidationPhase | undefined;
	compactInFlight = false;
	compactHookInFlight = false;
	resolveFailureNotified = false;
	lastObserverError: string | undefined;
	lastReflectorError: string | undefined;
	lastDropperError: string | undefined;
	contemplatorUsage: LlmUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, runs: 0 };

	/** Accumulate usage from one background LLM call (contemplator flush or summary). */
	recordContemplatorUsage(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }): void {
		const totals = this.contemplatorUsage;
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
		const restored: SessionSettings = {};
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown; details?: unknown };
			const settingsSources: unknown[] = [];
			if (candidate.customType === OM_SETTINGS) settingsSources.push(candidate.data);
			if (candidate.type === "compaction" && candidate.details && typeof candidate.details === "object") {
				settingsSources.push((candidate.details as { sessionSettings?: unknown }).sessionSettings);
			}
			for (const source of settingsSources) {
				if (!source || typeof source !== "object") continue;
				const data = source as Record<string, unknown>;
			const booleanKeys = [
				"showWorkerNotifications", "passive", "compactionObserverEnabled", "contemplatorEnabled", "debugLog",
			] as const;
			const numberKeys = [
				"observeAfterTokens", "reflectAfterTokens", "observerChunkMaxTokens", "compactAfterTokens",
				"observationsPoolMaxTokens", "observationsPoolTargetTokens", "agentMaxTurns",
				"contemplatorMinNewObservations", "contemplatorMinNewReflections", "contemplatorMinTurns",
			] as const;
			for (const key of booleanKeys) if (typeof data[key] === "boolean") restored[key] = data[key];
			for (const key of numberKeys) if (typeof data[key] === "number" && Number.isInteger(data[key]) && data[key] > 0) restored[key] = data[key];
			if (data.compactAfterTokensMode === "calibrated" || data.compactAfterTokensMode === "ratio") restored.compactAfterTokensMode = data.compactAfterTokensMode;
			if (typeof data.compactAfterTokensRatio === "number" && data.compactAfterTokensRatio > 0 && data.compactAfterTokensRatio < 1) restored.compactAfterTokensRatio = data.compactAfterTokensRatio;
			if (data.model === null) restored.model = null;
			else if (isConfiguredModel(data.model)) restored.model = data.model;
				if (data.contemplatorModel === null) restored.contemplatorModel = null;
				else if (isConfiguredModel(data.contemplatorModel)) restored.contemplatorModel = data.contemplatorModel;
			}
		}
		this.sessionSettings = normalizeSessionSettings(restored, this.baseConfig);
		this.applySessionSettings();
	}

	private applySessionSettings(): void {
		const { model, contemplatorModel, ...scalarSettings } = this.sessionSettings;
		this.config = {
			...this.baseConfig,
			...scalarSettings,
			...(model === undefined ? {} : { model: model ?? undefined }),
			...(contemplatorModel === undefined ? {} : { contemplatorModel: contemplatorModel ?? undefined }),
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
					`Observational memory: configured model ${configuredModel.provider}/${configuredModel.id} not found, using session model`,
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

	launchConsolidationTask(ctx: LaunchCtx, work: () => Promise<void>): Promise<void> {
		this.consolidationInFlight = true;
		this.consolidationPhase = undefined;
		this.lastObserverError = undefined;
		this.lastReflectorError = undefined;
		this.lastDropperError = undefined;
		const promise = this.launchTrackedTask(ctx, "consolidation", work, () => {
			this.consolidationInFlight = false;
			this.consolidationPhase = undefined;
			if (this.consolidationPromise === promise) this.consolidationPromise = null;
		});
		this.consolidationPromise = promise;
		return promise;
	}

	recordConsolidationStageError(ctx: LaunchCtx, phase: ConsolidationPhase, error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		if (phase === "observer") this.lastObserverError = message;
		if (phase === "reflector") this.lastReflectorError = message;
		if (phase === "dropper") this.lastDropperError = message;
		if (ctx.hasUI && ctx.ui) ctx.ui.notify(`Observational memory: ${phase} failed: ${message}`, "warning");
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
				if (hasUI && ui) ui.notify(`Observational memory: ${label} failed: ${errorMessage}`, "warning");
			} finally {
				onFinally(errorMessage);
			}
		})();
	}
}
