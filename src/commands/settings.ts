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
type NumberSetting = "observeAfterTokens" | "reflectAfterTokens" | "compactAfterTokens" | "observerChunkMaxTokens" | "observationsPoolMaxTokens" | "observationsPoolTargetTokens" | "agentMaxTurns" | "contemplatorMinNewObservations" | "contemplatorMinNewReflections" | "contemplatorMinTurns";
type BooleanSetting = "contemplatorEnabled" | "compactionObserverEnabled" | "showWorkerNotifications" | "passive" | "debugLog";

function modelLabel(model: ConfiguredModel | undefined): string {
	return model ? `${model.provider}/${model.id}` : "current session model";
}

function branch(ctx: ExtensionContext): readonly unknown[] {
	return ctx.sessionManager.getBranch() as readonly unknown[];
}

function appendSettings(pi: ExtensionAPI, runtime: Runtime, settings: SessionSettings): void {
	runtime.setSessionSettings(settings);
	pi.appendEntry(OM_SETTINGS, { version: 1, ...settings });
}

function hasOverride(settings: SessionSettings, key: string): boolean {
	return  Object.hasOwn(settings, key);
}

function scalarLabel(runtime: Runtime, key: NumberSetting | BooleanSetting | "compactAfterTokensRatio"): string {
	const current = runtime.config[key];
	const defaultValue = runtime.getDefaultConfig()[key];
	const renderedDefault = defaultValue === undefined ? "derived" : String(defaultValue);
	return hasOverride(runtime.getSessionSettings(), key) ? String(current) : `default (${renderedDefault})`;
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
	const value = await ctx.ui.input(`${title} (current: ${scalarLabel(runtime, key)})`, "positive integer; blank cancels");
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) {
		ctx.ui.notify("Value must be a positive integer.", "warning");
		return undefined;
	}
	return parsed;
}

export function registerSettingsCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.restoreSessionSettings(branch(ctx));
	});

	pi.registerCommand("om:settings", {
		description: "Configure observational memory for this session",
		handler: async (args, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		runtime.restoreSessionSettings(branch(ctx));
		const argument = typeof args === "string" ? args.trim().toLowerCase() : "";
		if (argument === "on" || argument === "off") {
			appendSettings(pi, runtime, { contemplatorEnabled: argument === "on" });
			ctx.ui.notify(`Contemplation: ${argument === "on" ? "enabled" : "disabled"} for this session.`, "info");
			return;
		}
		if (argument === "compaction on" || argument === "compaction off") {
			appendSettings(pi, runtime, { compactionObserverEnabled: argument.endsWith("on") });
			ctx.ui.notify(`Compaction observer: ${argument.endsWith("on") ? "enabled" : "disabled"} for this session.`, "info");
			return;
		}
		if (argument) {
			ctx.ui.notify("Usage: /om:settings [on|off|compaction on|compaction off]", "info");
			return;
		}

		while (true) {
			const settings = runtime.getSessionSettings();
			const choice = await ctx.ui.select("Observational memory settings (session overrides)", [
				`Contemplation: ${scalarLabel(runtime, "contemplatorEnabled")}`,
				`Contemplation model: ${hasOverride(settings, "contemplatorModel") ? modelLabel(runtime.config.contemplatorModel) : `default (${modelLabel(runtime.getDefaultConfig().contemplatorModel)})`}`,
				`Compaction observer: ${scalarLabel(runtime, "compactionObserverEnabled")}`,
				`Memory worker model: ${hasOverride(settings, "model") ? modelLabel(runtime.config.model) : `default (${modelLabel(runtime.getDefaultConfig().model)})`}`,
				`Observation threshold: ${scalarLabel(runtime, "observeAfterTokens")}`,
				`Reflection threshold: ${scalarLabel(runtime, "reflectAfterTokens")}`,
				`Compaction threshold: ${scalarLabel(runtime, "compactAfterTokens")}`,
				`Compaction mode: ${hasOverride(settings, "compactAfterTokensMode") ? runtime.config.compactAfterTokensMode : `default (${runtime.getDefaultConfig().compactAfterTokensMode})`}`,
				`Compaction ratio: ${hasOverride(settings, "compactAfterTokensRatio") ? runtime.config.compactAfterTokensRatio : `default (${runtime.getDefaultConfig().compactAfterTokensRatio})`}`,
				`Observer chunk limit: ${scalarLabel(runtime, "observerChunkMaxTokens")}`,
				`Observation pool max: ${scalarLabel(runtime, "observationsPoolMaxTokens")}`,
				`Observation pool target: ${scalarLabel(runtime, "observationsPoolTargetTokens")}`,
				`Worker max turns: ${scalarLabel(runtime, "agentMaxTurns")}`,
				`Contemplation observation trigger: ${scalarLabel(runtime, "contemplatorMinNewObservations")}`,
				`Contemplation reflection trigger: ${scalarLabel(runtime, "contemplatorMinNewReflections")}`,
				`Contemplation turn interval: ${scalarLabel(runtime, "contemplatorMinTurns")}`,
				`Worker notifications: ${scalarLabel(runtime, "showWorkerNotifications")}`,
				`Passive mode: ${scalarLabel(runtime, "passive")}`,
				`Debug logging: ${scalarLabel(runtime, "debugLog")}`,
				"Done",
			]);
			if (!choice || choice === "Done") return;
			if (choice.startsWith("Contemplation:")) appendSettings(pi, runtime, { contemplatorEnabled: !runtime.config.contemplatorEnabled });
			else if (choice.startsWith("Compaction observer:")) appendSettings(pi, runtime, { compactionObserverEnabled: !runtime.config.compactionObserverEnabled });
			else if (choice.startsWith("Worker notifications:")) appendSettings(pi, runtime, { showWorkerNotifications: !runtime.config.showWorkerNotifications });
			else if (choice.startsWith("Passive mode:")) appendSettings(pi, runtime, { passive: !runtime.config.passive });
			else if (choice.startsWith("Debug logging:")) appendSettings(pi, runtime, { debugLog: !runtime.config.debugLog });
			else if (choice.startsWith("Contemplation model:")) {
				const model = await chooseModel(ctx, runtime.config.contemplatorModel, "Contemplation model");
				if (model !== undefined) appendSettings(pi, runtime, { contemplatorModel: model });
			} else if (choice.startsWith("Memory worker model:")) {
				const model = await chooseModel(ctx, runtime.config.model, "Memory worker model");
				if (model !== undefined) appendSettings(pi, runtime, { model });
			} else if (choice.startsWith("Compaction mode:")) {
				const mode = await ctx.ui.select("Compaction threshold mode", ["calibrated", "ratio"]);
				if (mode === "calibrated" || mode === "ratio") appendSettings(pi, runtime, { compactAfterTokensMode: mode });
			} else if (choice.startsWith("Compaction ratio:")) {
				const value = await ctx.ui.input(`Compaction ratio (current: ${scalarLabel(runtime, "compactAfterTokensRatio")})`, "decimal between 0 and 1");
				const ratio = value === undefined ? undefined : Number(value.trim());
				if (ratio !== undefined && Number.isFinite(ratio) && ratio > 0 && ratio < 1) appendSettings(pi, runtime, { compactAfterTokensRatio: ratio });
				else if (value !== undefined) ctx.ui.notify("Ratio must be a number between 0 and 1.", "warning");
			} else {
				const numberChoice: Array<[string, NumberSetting, string]> = [
					["Observation threshold:", "observeAfterTokens", "Observation threshold"],
					["Reflection threshold:", "reflectAfterTokens", "Reflection threshold"],
					["Compaction threshold:", "compactAfterTokens", "Compaction threshold"],
					["Observer chunk limit:", "observerChunkMaxTokens", "Observer chunk limit"],
					["Observation pool max:", "observationsPoolMaxTokens", "Observation pool max"],
					["Observation pool target:", "observationsPoolTargetTokens", "Observation pool target"],
					["Worker max turns:", "agentMaxTurns", "Worker max turns"],
					["Contemplation observation trigger:", "contemplatorMinNewObservations", "Contemplation observation trigger"],
					["Contemplation reflection trigger:", "contemplatorMinNewReflections", "Contemplation reflection trigger"],
					["Contemplation turn interval:", "contemplatorMinTurns", "Contemplation turn interval"],
				];
				const selected = numberChoice.find(([prefix]) => choice.startsWith(prefix));
				if (selected) {
					const value = await editNumber(ctx, runtime, selected[1], selected[2]);
					if (value !== undefined) appendSettings(pi, runtime, { [selected[1]]: value } as SessionSettings);
				}
			}
		}
	},
	});
}
