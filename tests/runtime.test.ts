import { describe, expect, it, vi } from "vitest";

import { computeSessionSettings, Runtime } from "../src/runtime.js";

function modelRegistry(args: { found?: unknown; auth?: unknown } = {}) {
	return {
		find: vi.fn(() => args.found),
		getApiKeyAndHeaders: vi.fn(async () => args.auth ?? { ok: true, apiKey: "key", headers: { test: "yes" } }),
	};
}

describe("Runtime V3 behavior", () => {
	it("uses configured model when present", async () => {
		const runtime = new Runtime();
		const configured = { provider: "anthropic", id: "configured" };
		const registry = modelRegistry({ found: configured });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "configured" } };

		const result = await runtime.resolveModel({ model: { provider: "openai" }, modelRegistry: registry, hasUI: false });

		expect(registry.find).toHaveBeenCalledWith("anthropic", "configured");
		expect(result).toEqual({ ok: true, model: configured, apiKey: "key", headers: { test: "yes" } });
	});

	it("uses the session model when an explicit caller opts out of the worker model", async () => {
		const runtime = new Runtime();
		const sessionModel = { provider: "openai", id: "session" };
		const registry = modelRegistry({ found: { provider: "anthropic", id: "worker" } });
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "worker" } };

		const result = await runtime.resolveModel({
			model: sessionModel,
			modelRegistry: registry,
			hasUI: false,
			configuredModel: null,
		});

		expect(registry.find).not.toHaveBeenCalled();
		expect(result).toMatchObject({ ok: true, model: sessionModel });
	});

	it("falls back to session model and notifies when configured model is missing", async () => {
		const runtime = new Runtime();
		const notify = vi.fn();
		const sessionModel = { provider: "openai" };
		const registry = modelRegistry();
		runtime.config = { ...runtime.config, model: { provider: "anthropic", id: "missing" } };

		const result = await runtime.resolveModel({ model: sessionModel, modelRegistry: registry, hasUI: true, ui: { notify } });

		expect(result).toMatchObject({ ok: true, model: sessionModel });
		expect(notify).toHaveBeenCalledWith(
			"Observational memory: configured model anthropic/missing not found, using session model",
			"warning",
		);
	});

	it("returns model resolution failures", async () => {
		const runtime = new Runtime();
		await expect(runtime.resolveModel({ model: undefined, modelRegistry: modelRegistry(), hasUI: false })).resolves.toEqual({
			ok: false,
			reason: "no model available (session has no model and no observational-memory model configured)",
		});

		const registry = modelRegistry({ auth: { ok: false } });
		await expect(runtime.resolveModel({ model: { provider: "anthropic" }, modelRegistry: registry, hasUI: false })).resolves.toEqual({
			ok: false,
			reason: 'no API key for provider "anthropic"',
		});
	});

	it("tracks consolidation task state", async () => {
		const runtime = new Runtime();
		let release: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			release = resolve;
		});

		const promise = runtime.launchConsolidationTask({ hasUI: false }, async () => {
			runtime.consolidationPhase = "observer";
			await work;
		});

		expect(runtime.consolidationInFlight).toBe(true);
		expect(runtime.consolidationPromise).toBe(promise);
		expect(runtime.consolidationPhase).toBe("observer");
		release?.();
		await promise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPromise).toBeNull();
		expect(runtime.consolidationPhase).toBeUndefined();
	});

	it("records stage-specific consolidation errors", () => {
		const runtime = new Runtime();
		const notify = vi.fn();

		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "observer", new Error("observe failed"))).toBe("observe failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "reflector", new Error("reflect failed"))).toBe("reflect failed");
		expect(runtime.recordConsolidationStageError({ hasUI: true, ui: { notify } }, "dropper", "drop failed")).toBe("drop failed");

		expect(runtime.lastObserverError).toBe("observe failed");
		expect(runtime.lastReflectorError).toBe("reflect failed");
		expect(runtime.lastDropperError).toBe("drop failed");
		expect(notify).toHaveBeenCalledWith("Observational memory: observer failed: observe failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: reflector failed: reflect failed", "warning");
		expect(notify).toHaveBeenCalledWith("Observational memory: dropper failed: drop failed", "warning");
	});

	it("restores session overrides retained in compaction details", () => {
		const runtime = new Runtime();
		runtime.restoreSessionSettings([
			{ type: "custom", customType: "om.settings", data: { contemplatorEnabled: false } },
			{ type: "compaction", details: { sessionSettings: { contemplatorEnabled: true, contemplatorMinTurns: 3 } } },
			{ type: "custom", customType: "om.settings", data: { contemplatorEnabled: false } },
		]);

		expect(runtime.getSessionSettings()).toMatchObject({ contemplatorEnabled: false, contemplatorMinTurns: 3 });
	});

	it("prefers live om.settings entries over a positionally-later stale compaction snapshot", () => {
		// A compaction baking a stale in-memory overlay (e.g. gates 1/1/1 left over
		// from an out-of-band append) must not override a newer om.settings entry
		// just because the snapshot lands later in the branch. Snapshot-only keys
		// (contemplatorMinTurns) are still preserved.
		const runtime = new Runtime();
		runtime.restoreSessionSettings([
			{ type: "custom", customType: "om.settings", data: { contemplatorEnabled: false, contemplatorMinTurns: 10 } },
			{ type: "custom", customType: "om.settings", data: { contemplatorEnabled: false } },
			{ type: "compaction", details: { sessionSettings: { contemplatorEnabled: true, contemplatorMinTurns: 1 } } },
		]);

		expect(runtime.getSessionSettings()).toMatchObject({ contemplatorEnabled: false, contemplatorMinTurns: 10 });
	});

	it("keeps snapshot-only keys when their om.settings entries were folded away", () => {
		// computeSessionSettings is also what the compaction hook bakes, so a
		// snapshot chain must preserve keys whose live entries are gone.
		expect(computeSessionSettings([
			{ type: "compaction", details: { sessionSettings: { contemplatorMinTurns: 7 } } },
		])).toMatchObject({ contemplatorMinTurns: 7 });

		expect(computeSessionSettings([
			{ type: "custom", customType: "om.settings", data: { contemplatorMinTurns: 8 } },
			{ type: "compaction", details: { sessionSettings: { contemplatorMinTurns: 7 } } },
		])).toMatchObject({ contemplatorMinTurns: 8 });
	});

	it("preserves a valid default pool target when only the maximum is overridden", () => {
		const runtime = new Runtime();
		runtime.setSessionSettings({ observationsPoolMaxTokens: 15_000 });

		expect(runtime.config.observationsPoolMaxTokens).toBe(15_000);
		expect(runtime.config.observationsPoolTargetTokens).toBe(10_000);
	});

	it("normalizes invalid observation pool overrides restored from a branch", () => {
		const runtime = new Runtime();
		runtime.restoreSessionSettings([
			{ type: "custom", customType: "om.settings", data: { observationsPoolMaxTokens: 5_000 } },
			{ type: "custom", customType: "om.settings", data: { observationsPoolTargetTokens: 10_000 } },
		]);

		expect(runtime.config.observationsPoolMaxTokens).toBe(5_000);
		expect(runtime.config.observationsPoolTargetTokens).toBe(2_500);
		expect(runtime.config.observationsPoolTargetTokens).toBeLessThan(runtime.config.observationsPoolMaxTokens);
	});

	it("keeps compaction flags independent", () => {
		const runtime = new Runtime();
		runtime.compactInFlight = true;
		runtime.compactHookInFlight = true;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
	});
});
