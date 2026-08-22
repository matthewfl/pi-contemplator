import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, SelectList, Spacer, Text, fuzzyFilter, type Focusable, type SelectItem } from "@earendil-works/pi-tui";
import type { ConfiguredModel } from "../config.js";
import { OM_SETTINGS, type Runtime, type SessionSettings } from "../runtime.js";

type ModelRegistryLike = {
	refresh?(): Promise<void>;
	getAvailable(): Array<{ provider: string; id: string }>;
	getAll(): Array<{ provider: string; id: string }>;
};
type NumberSetting = "observeAfterTokens" | "compactAfterTokens" | "observerChunkMaxTokens" | "newMemoryPoolMaxTokens" | "oldMemoryPoolTargetTokens" | "agentMaxTurns" | "contemplatorMinNewObservations" | "contemplatorMinNewSummaries" | "contemplatorMinTurns" | "summarizerRetriggerTokens" | "summarizerSamplingThresholdTokens";
type BooleanSetting = "contemplatorEnabled" | "showContemplatorMessages" | "reviewerEnabled" | "summarizerEnabled" | "compactionObserverEnabled" | "showWorkerNotifications" | "passive" | "debugLog";

function modelLabel(model: ConfiguredModel | undefined): string {
	return model ? `${model.provider}/${model.id}` : "current session model";
}

function branch(ctx: ExtensionContext): readonly unknown[] {
	return ctx.sessionManager.getBranch() as readonly unknown[];
}

function appendSettings(pi: ExtensionAPI, runtime: Runtime, settings: SessionSettings, ctx?: ExtensionContext): void {
	runtime.setSessionSettings(settings);
	pi.appendEntry(OM_SETTINGS, { version: 1, ...settings });
	// Settings that affect worker eligibility should take effect immediately,
	// rather than waiting for an unrelated observer batch or session restart.
	if (ctx) runtime.notifySettingsUpdate(ctx, settings);
}

function hasOverride(settings: SessionSettings, key: string): boolean {
	return  Object.hasOwn(settings, key);
}

function scalarLabel(runtime: Runtime, key: NumberSetting | BooleanSetting | "compactAfterTokensRatio"): string {
	const current = runtime.config[key];
	const defaultValue = runtime.getDefaultConfig()[key];
	const renderedDefault = defaultValue === undefined ? "derived" : String(defaultValue);
	return hasOverride(runtime.getSessionSettings(), key) ? String(current) : `${renderedDefault} (default)`;
}

function extensionEnabledLabel(runtime: Runtime): string {
	const enabled = !runtime.config.passive;
	return hasOverride(runtime.getSessionSettings(), "passive") ? String(enabled) : `${enabled} (default)`;
}

interface ModelOption extends SelectItem {
	configuredModel: ConfiguredModel | null;
}

class FilterableModelSelector extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly allItems: ModelOption[];
	private readonly done: (value: ConfiguredModel | null | undefined) => void;
	private list!: SelectList;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		title: string,
		models: ConfiguredModel[],
		current: ConfiguredModel | undefined,
		done: (value: ConfiguredModel | null | undefined) => void,
	) {
		super();
		this.done = done;
		this.allItems = [
			{ value: "", label: "Use current session model", description: current ? `(current: ${modelLabel(current)})` : "(current session model)", configuredModel: null },
			...models.map((model) => ({
				value: `${model.provider}/${model.id}`,
				label: `${model.provider}/${model.id}`,
				description: current && model.provider === current.provider && model.id === current.id ? "(current)" : undefined,
				configuredModel: model,
			})),
		];
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${title} — type to filter; ↑/↓ to scroll; Enter to select`, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.searchInput.onSubmit = () => {
			const selected = this.list.getSelectedItem();
			if (selected) done((selected as ModelOption).configuredModel);
		};
		this.updateList();
	}

	private updateList(): void {
		const query = this.searchInput.getValue();
		const filtered = query ? fuzzyFilter(this.allItems, query, (item) => item.value || item.label) : this.allItems;
		this.list = new SelectList(filtered, 5, getSelectListTheme());
		this.list.onSelect = (item) => this.done((item as ModelOption).configuredModel);
		this.list.onCancel = () => this.done(undefined);
		this.listContainer.clear();
		this.listContainer.addChild(this.list);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "tui.select.down") || kb.matches(keyData, "tui.select.confirm") || kb.matches(keyData, "tui.select.cancel")) {
			this.list.handleInput(keyData);
			return;
		}
		this.searchInput.handleInput(keyData);
		this.updateList();
	}
}

async function chooseModel(ctx: ExtensionContext, current: ConfiguredModel | undefined, title: string): Promise<ConfiguredModel | null | undefined> {
	const registry = ctx.modelRegistry as unknown as ModelRegistryLike;
	await registry.refresh?.();
	const available = registry.getAvailable();
	const models = available.length > 0 ? available : registry.getAll();
	if (models.length === 0) {
		ctx.ui.notify("No configured models are available.", "warning");
		return undefined;
	}
	return ctx.ui.custom((_tui, _theme, _keybindings, done) => new FilterableModelSelector(title, models, current, done));
}

async function editNumber(ctx: ExtensionContext, runtime: Runtime, key: NumberSetting, title: string): Promise<number | undefined> {
	const requirement = "positive integer";
	const value = await ctx.ui.input(`${title} (current: ${scalarLabel(runtime, key)})`, `${requirement}; blank cancels`);
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) {
		ctx.ui.notify(`Value must be a ${requirement}.`, "warning");
		return undefined;
	}
	return parsed;
}

export function registerSettingsCommand(pi: ExtensionAPI, runtime: Runtime): void {
	const restoreSettings = (_event: unknown, ctx: ExtensionContext) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.restoreSessionSettings(branch(ctx));
	};
	pi.on("session_start", restoreSettings);
	pi.on("session_tree", restoreSettings);

	pi.registerCommand("om:settings", {
		description: "Configure pi-contemplator for this session",
		handler: async (args, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.restoreSessionSettings(branch(ctx));
		const argument = typeof args === "string" ? args.trim().toLowerCase() : "";
		if (argument === "on" || argument === "off") {
			appendSettings(pi, runtime, { contemplatorEnabled: argument === "on" });
			ctx.ui.notify(`Contemplator: ${argument === "on" ? "enabled" : "disabled"} for this session.`, "info");
			return;
		}
		if (argument === "compaction on" || argument === "compaction off") {
			appendSettings(pi, runtime, { compactionObserverEnabled: argument.endsWith("on") });
			ctx.ui.notify(`Observe source during compaction: ${argument.endsWith("on") ? "enabled" : "disabled"} for this session.`, "info");
			return;
		}
		if (argument === "summarizer on" || argument === "summarizer off") {
			appendSettings(pi, runtime, { summarizerEnabled: argument.endsWith("on") }, ctx);
			ctx.ui.notify(`Summarizer: ${argument.endsWith("on") ? "enabled" : "disabled"} for this session.`, "info");
			return;
		}
		if (argument === "reviewer on" || argument === "reviewer off") {
			appendSettings(pi, runtime, { reviewerEnabled: argument.endsWith("on") });
			ctx.ui.notify(`Structural reviewer: ${argument.endsWith("on") ? "enabled" : "disabled"} for this session.`, "info");
			return;
		}
		if (argument === "messages on" || argument === "messages off") {
			appendSettings(pi, runtime, { showContemplatorMessages: argument.endsWith("on") });
			ctx.ui.notify(`Contemplator messages: ${argument.endsWith("on") ? "visible" : "hidden"} for this session.`, "info");
			return;
		}
		if (argument) {
			ctx.ui.notify("Usage: /om:settings [on|off|messages on|messages off|summarizer on|summarizer off|reviewer on|reviewer off|compaction on|compaction off]", "info");
			return;
		}

		while (true) {
			const settings = runtime.getSessionSettings();
			const choice = await ctx.ui.select("pi-contemplator settings (session overrides)", [
				`Pi-contemplator Enabled: ${extensionEnabledLabel(runtime)}`,
				`Contemplator enabled: ${scalarLabel(runtime, "contemplatorEnabled")}`,
				`Contemplator model: ${hasOverride(settings, "contemplatorModel") ? modelLabel(runtime.config.contemplatorModel) : `${modelLabel(runtime.getDefaultConfig().contemplatorModel)} (default)`}`,
				`Show contemplator messages: ${scalarLabel(runtime, "showContemplatorMessages")}`,
				`Contemplator new-observation trigger (count): ${scalarLabel(runtime, "contemplatorMinNewObservations")}`,
				`Contemplator new-summary trigger (count): ${scalarLabel(runtime, "contemplatorMinNewSummaries")}`,
				`Contemplator response spacing (count): ${scalarLabel(runtime, "contemplatorMinTurns")}`,
				`Summarizer enabled: ${scalarLabel(runtime, "summarizerEnabled")}`,
				`New memory pool protection budget (tokens): ${scalarLabel(runtime, "newMemoryPoolMaxTokens")}`,
				`Old memory pool target (tokens, advisory): ${scalarLabel(runtime, "oldMemoryPoolTargetTokens")}`,
				`Summarizer old-pool retrigger growth (tokens): ${scalarLabel(runtime, "summarizerRetriggerTokens")}`,
				`Summarizer input cap before sampling (tokens): ${scalarLabel(runtime, "summarizerSamplingThresholdTokens")}`,
				`Structural reviewer enabled: ${scalarLabel(runtime, "reviewerEnabled")}`,
				`Structural reviewer model: ${hasOverride(settings, "reviewerModel") ? modelLabel(runtime.config.reviewerModel) : `${modelLabel(runtime.getDefaultConfig().reviewerModel)} (default)`}`,
				`Observe source during compaction: ${scalarLabel(runtime, "compactionObserverEnabled")}`,
				`Observer and summarizer model: ${hasOverride(settings, "model") ? modelLabel(runtime.config.model) : `${modelLabel(runtime.getDefaultConfig().model)} (default)`}`,
				`Observer source backlog trigger (tokens): ${scalarLabel(runtime, "observeAfterTokens")}`,
				`Observer input cap (tokens): ${scalarLabel(runtime, "observerChunkMaxTokens")}`,
				`Observer and summarizer max rounds: ${scalarLabel(runtime, "agentMaxTurns")}`,
				`Automatic compaction trigger: ${scalarLabel(runtime, "compactAfterTokens")}`,
				`Automatic compaction threshold mode: ${hasOverride(settings, "compactAfterTokensMode") ? runtime.config.compactAfterTokensMode : `${runtime.getDefaultConfig().compactAfterTokensMode} (default)`}`,
				`Automatic compaction context ratio: ${hasOverride(settings, "compactAfterTokensRatio") ? runtime.config.compactAfterTokensRatio : `${runtime.getDefaultConfig().compactAfterTokensRatio} (default)`}`,
				`Worker notifications: ${scalarLabel(runtime, "showWorkerNotifications")}`,
				`Debug logging: ${scalarLabel(runtime, "debugLog")}`,
				"Done",
			]);
			if (!choice || choice === "Done") return;
			if (choice.startsWith("Pi-contemplator Enabled:")) appendSettings(pi, runtime, { passive: !runtime.config.passive });
			else if (choice.startsWith("Contemplator enabled:")) appendSettings(pi, runtime, { contemplatorEnabled: !runtime.config.contemplatorEnabled });
			else if (choice.startsWith("Summarizer enabled:")) appendSettings(pi, runtime, { summarizerEnabled: !runtime.config.summarizerEnabled }, ctx);
			else if (choice.startsWith("Show contemplator messages:")) appendSettings(pi, runtime, { showContemplatorMessages: !runtime.config.showContemplatorMessages });
			else if (choice.startsWith("Structural reviewer enabled:")) appendSettings(pi, runtime, { reviewerEnabled: !runtime.config.reviewerEnabled });
			else if (choice.startsWith("Observe source during compaction:")) appendSettings(pi, runtime, { compactionObserverEnabled: !runtime.config.compactionObserverEnabled });
			else if (choice.startsWith("Worker notifications:")) appendSettings(pi, runtime, { showWorkerNotifications: !runtime.config.showWorkerNotifications });
			else if (choice.startsWith("Debug logging:")) appendSettings(pi, runtime, { debugLog: !runtime.config.debugLog });
			else if (choice.startsWith("Contemplator model:")) {
				const model = await chooseModel(ctx, runtime.config.contemplatorModel, "Contemplator model");
				if (model !== undefined) appendSettings(pi, runtime, { contemplatorModel: model });
			} else if (choice.startsWith("Structural reviewer model:")) {
				const model = await chooseModel(ctx, runtime.config.reviewerModel, "Structural reviewer model");
				if (model !== undefined) appendSettings(pi, runtime, { reviewerModel: model });
			} else if (choice.startsWith("Observer and summarizer model:")) {
				const model = await chooseModel(ctx, runtime.config.model, "Observer and summarizer model");
				if (model !== undefined) appendSettings(pi, runtime, { model });
			} else if (choice.startsWith("Automatic compaction threshold mode:")) {
				const mode = await ctx.ui.select("Automatic compaction threshold mode", ["calibrated", "ratio"]);
				if (mode === "calibrated" || mode === "ratio") appendSettings(pi, runtime, { compactAfterTokensMode: mode });
			} else if (choice.startsWith("Automatic compaction context ratio:")) {
				const value = await ctx.ui.input(`Automatic compaction context ratio (current: ${scalarLabel(runtime, "compactAfterTokensRatio")})`, "decimal between 0 and 1");
				const ratio = value === undefined ? undefined : Number(value.trim());
				if (ratio !== undefined && Number.isFinite(ratio) && ratio > 0 && ratio < 1) appendSettings(pi, runtime, { compactAfterTokensRatio: ratio });
				else if (value !== undefined) ctx.ui.notify("Ratio must be a number between 0 and 1.", "warning");
			} else {
				const numberChoice: Array<[string, NumberSetting, string]> = [
					["Observer source backlog trigger (tokens):", "observeAfterTokens", "Observer source backlog trigger (tokens)"],
					["Observer input cap (tokens):", "observerChunkMaxTokens", "Observer input cap (tokens)"],
					["Observer and summarizer max rounds:", "agentMaxTurns", "Observer and summarizer max rounds"],
					["Automatic compaction trigger:", "compactAfterTokens", "Automatic compaction trigger"],
					["New memory pool protection budget (tokens):", "newMemoryPoolMaxTokens", "New memory pool protection budget (tokens)"],
					["Old memory pool target (tokens, advisory):", "oldMemoryPoolTargetTokens", "Old memory pool target (tokens, advisory)"],
					["Contemplator new-observation trigger (count):", "contemplatorMinNewObservations", "Contemplator new-observation trigger (count)"],
					["Contemplator new-summary trigger (count):", "contemplatorMinNewSummaries", "Contemplator new-summary trigger (count)"],
					["Contemplator response spacing (count):", "contemplatorMinTurns", "Contemplator response spacing (count)"],
					["Summarizer old-pool retrigger growth (tokens):", "summarizerRetriggerTokens", "Summarizer old-pool retrigger growth (tokens)"],
					["Summarizer input cap before sampling (tokens):", "summarizerSamplingThresholdTokens", "Summarizer input cap before sampling (tokens)"],
				];
				const selected = numberChoice.find(([prefix]) => choice.startsWith(prefix));
				if (selected) {
					const value = await editNumber(ctx, runtime, selected[1], selected[2]);
					if (value !== undefined) appendSettings(pi, runtime, { [selected[1]]: value } as SessionSettings, ctx);
				}
			}
		}
	},
	});
}
