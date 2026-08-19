import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ agentDir: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => mock.agentDir,
}));

import { DEFAULTS, loadConfig, readEnvConfig, resolveCompactAfterTokens } from "../src/config.js";

function writeJson(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf-8");
}

describe("V3 config", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = `${tmpdir()}/om-v3-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mock.agentDir = agentDir;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("uses V3 defaults", () => {
		expect(DEFAULTS).toEqual({
			observeAfterTokens: 10000,
			compactAfterTokens: 81000,
			compactAfterTokensMode: "calibrated",
			compactAfterTokensRatio: 0.68,
			observationsPoolMaxTokens: 20000,
			observationsPoolTargetTokens: 10000,
			agentMaxTurns: 16,
			showWorkerNotifications: true,
			passive: false,
			compactionObserverEnabled: true,
			contemplatorEnabled: true,
			showContemplatorMessages: true,
			reviewerEnabled: true,
			contemplatorMinNewObservations: 8,
			contemplatorMinNewReflections: 1,
			contemplatorMinTurns: 10,
			librarianEnabled: true,
			librarianMinIntervalMinutes: 10,
			librarianMaxDelayMinutes: 180,
			librarianMinNewMemoryTokens: 5000,
			librarianMaxPendingMemoryTokens: 20000,
			librarianPressureTriggerRatio: 1,
			librarianSamplingThresholdTokens: 40000,
			debugLog: false,
		});
		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("merges global, project, and env V3 settings in order", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 10,
				compactAfterTokens: 30,
				observationsPoolMaxTokens: 40,
				observationsPoolTargetTokens: 15,
				agentMaxTurns: 5,
				model: { provider: "anthropic", id: "global", thinking: "medium" },
				showWorkerNotifications: true,
				passive: false,
				debugLog: true,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: 100,
				model: { provider: "openai", id: "project", thinking: "low" },
				showWorkerNotifications: false,
			},
		});

		expect(loadConfig(cwd, { PI_OBSERVATIONAL_MEMORY_PASSIVE: "true" })).toMatchObject({
			observeAfterTokens: 100,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 15,
			agentMaxTurns: 5,
			model: { provider: "openai", id: "project", thinking: "low" },
			showWorkerNotifications: false,
			passive: true,
			debugLog: true,
		});
	});

	it("ignores the retired reflector threshold", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": { reflectAfterTokens: 1 },
		});
		expect(loadConfig(cwd, {})).not.toHaveProperty("reflectAfterTokens");
	});

	it("loads contemplator message visibility and reviewer overrides", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				showContemplatorMessages: false,
				reviewerEnabled: false,
				reviewerModel: { provider: "openai", id: "reviewer", thinking: "medium" },
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			showContemplatorMessages: false,
			reviewerEnabled: false,
			reviewerModel: { provider: "openai", id: "reviewer", thinking: "medium" },
		});
	});

	it("ignores invalid V3 values", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observeAfterTokens: -1,
				compactAfterTokens: 1.5,
				observationsPoolMaxTokens: "20000",
				observationsPoolTargetTokens: "10000",
				agentMaxTurns: null,
				model: { provider: "anthropic", id: "", thinking: "huge" },
				showWorkerNotifications: "no",
				passive: "yes",
				debugLog: "true",
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("derives observation pool target from the final max when omitted", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("falls back to derived target when explicit target is invalid for the final max", () => {
		writeJson(join(agentDir, "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 100,
				observationsPoolTargetTokens: 80,
			},
		});
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationsPoolMaxTokens: 40,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
		});
	});

	it("ignores old V2 settings without warnings or aliases", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				observationThresholdTokens: 10,
				compactionThresholdTokens: 20,
				reflectionThresholdTokens: 30,
				compactionModel: { provider: "anthropic", id: "old" },
				thinkingLevel: "high",
				observerMaxTurnsPerRun: 2,
				reflectorMaxTurnsPerPass: 3,
				prunerMaxTurnsPerPass: 4,
				compactionMaxToolCalls: 5,
			},
		});

		expect(loadConfig(cwd, {})).toEqual(DEFAULTS);
	});

	it("loads the librarian sampling token threshold", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": { librarianSamplingThresholdTokens: 32000 },
		});
		expect(loadConfig(cwd, {})).toMatchObject({ librarianSamplingThresholdTokens: 32000 });
	});

	it("allows zero-minute librarian delays for immediate scheduling", () => {
		writeJson(join(cwd, ".pi", "settings.json"), {
			"observational-memory": {
				librarianMinIntervalMinutes: 0,
				librarianMaxDelayMinutes: 0,
			},
		});

		expect(loadConfig(cwd, {})).toMatchObject({
			librarianMinIntervalMinutes: 0,
			librarianMaxDelayMinutes: 0,
		});
	});

	it("parses passive and compaction observer env overrides", () => {
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "on" })).toEqual({ passive: true });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "0" })).toEqual({ passive: false });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "maybe" })).toEqual({});
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_COMPACTION_OBSERVER: "off" })).toEqual({ compactionObserverEnabled: false });
		expect(readEnvConfig({ PI_OBSERVATIONAL_MEMORY_PASSIVE: "on", PI_OBSERVATIONAL_MEMORY_COMPACTION_OBSERVER: "off" })).toEqual({ passive: true, compactionObserverEnabled: false });
	});

	describe("compactAfterTokens ratio mode", () => {
		it("accepts compactAfterTokensMode and compactAfterTokensRatio", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensMode: "ratio",
					compactAfterTokensRatio: 0.5,
				},
			});

			expect(loadConfig(cwd, {})).toMatchObject({
				compactAfterTokensMode: "ratio",
				compactAfterTokensRatio: 0.5,
			});
		});

		it("rejects invalid mode values and falls back to default calibrated", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensMode: "auto",
				},
			});

			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensMode: "calibrated" });
		});

		it("rejects ratio outside (0, 1) and falls back to default", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: 0,
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });

			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: 1,
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });

			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: 1.5,
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });

			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: -0.2,
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });
		});

		it("rejects non-numeric ratio and falls back to default", () => {
			writeJson(join(cwd, ".pi", "settings.json"), {
				"observational-memory": {
					compactAfterTokensRatio: "0.5",
				},
			});
			expect(loadConfig(cwd, {})).toMatchObject({ compactAfterTokensRatio: 0.68 });
		});
	});

	describe("resolveCompactAfterTokens", () => {
		it("returns the calibrated value in calibrated mode", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "calibrated", compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(81000);
		});

		it("returns calibrated value regardless of context window in calibrated mode", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "calibrated", compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, undefined)).toBe(81000);
			expect(resolveCompactAfterTokens(config, 0)).toBe(81000);
		});

		it("scales by context window in ratio mode", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5, compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(500_000);
			expect(resolveCompactAfterTokens(config, 200_000)).toBe(100_000);
		});

		it("floors fractional results to an integer >= 1", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5, compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, 3)).toBe(1);
			expect(resolveCompactAfterTokens(config, 1)).toBe(1);
		});

		it("falls back to calibrated value when context window is unavailable in ratio mode", () => {
			const config = { ...DEFAULTS, compactAfterTokensMode: "ratio", compactAfterTokensRatio: 0.5, compactAfterTokens: 81000 } as any;
			expect(resolveCompactAfterTokens(config, undefined)).toBe(81000);
			expect(resolveCompactAfterTokens(config, 0)).toBe(81000);
			expect(resolveCompactAfterTokens(config, -1)).toBe(81000);
		});
	});
});
