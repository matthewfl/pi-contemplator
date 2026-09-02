import { describe, expect, it, vi } from "vitest";
import { modelsForSettingsSelector } from "../src/commands/settings.js";

describe("settings model selector", () => {
	it("uses the enabledModels session scope and preserves pinned thinking", async () => {
		const registry = { refresh: vi.fn(), getAvailable: vi.fn(), getAll: vi.fn() };
		const ctx = {
			scopedModels: [
				{ model: { provider: "anthropic", id: "claude-a" }, thinkingLevel: "high" },
				{ model: { provider: "openai", id: "gpt-b" } },
			],
			modelRegistry: registry,
		};

		await expect(modelsForSettingsSelector(ctx as any)).resolves.toEqual([
			{ provider: "anthropic", id: "claude-a", thinking: "high" },
			{ provider: "openai", id: "gpt-b" },
		]);
		expect(registry.refresh).not.toHaveBeenCalled();
		expect(registry.getAvailable).not.toHaveBeenCalled();
	});

	it("uses the available catalogue when enabledModels is not configured", async () => {
		const registry = {
			refresh: vi.fn(async () => {}),
			getAvailable: vi.fn(() => [{ provider: "available", id: "one" }]),
			getAll: vi.fn(() => [{ provider: "all", id: "fallback" }]),
		};
		const ctx = { scopedModels: [], modelRegistry: registry };

		await expect(modelsForSettingsSelector(ctx as any)).resolves.toEqual([{ provider: "available", id: "one" }]);
		expect(registry.refresh).toHaveBeenCalledOnce();
		expect(registry.getAll).not.toHaveBeenCalled();
	});
});
