import { describe, expect, it, vi } from "vitest";

import { registerStatusCommand } from "../src/commands/status.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function setup(args: { entries: TestEntry[]; runtime?: Partial<any>; model?: unknown }) {
	let handler: ((args: unknown, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand: vi.fn((name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("om:status");
			handler = command.handler;
		}),
	};
	const runtime = {
		ensureConfig: vi.fn(),
		config: {
			observeAfterTokens: 10,
			compactAfterTokens: 30,
			observationsPoolMaxTokens: 40,
			observationsPoolTargetTokens: 20,
			passive: false,
		},
		consolidationInFlight: false,
		consolidationPhase: undefined,
		compactInFlight: false,
		compactHookInFlight: false,
		lastObserverError: undefined,
		lastLibrarianError: undefined,
		agentUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, runs: 0 },
		...args.runtime,
	};
	registerStatusCommand(pi as any, runtime as any);
	if (!handler) throw new Error("status handler not registered");
	const notify = vi.fn();
	const ctx = { cwd: "/tmp/project", ui: { notify }, sessionManager: { getBranch: () => args.entries }, model: args.model };
	const run = async () => {
		await handler!(undefined, ctx);
		return notify.mock.calls.at(-1)?.[0] as string;
	};
	return { run, notify };
}

describe("V3 /om:status", () => {
	it("renders concise no-memory status without V2 committed/pending language", async () => {
		const output = await setup({ entries: [] }).run();

		expect(output).toContain("── Memory ──");
		expect(output).toContain("Observations: 0 recorded / 0 deleted / 0 inactive / 0 active / 0 visible");
		expect(output).toContain("Reflections:  0 recorded / 0 deleted / 0 inactive / 0 active / 0 visible");
		expect(output).toContain("Next observation:");
		expect(output).toContain("Next compaction:");
		expect(output).not.toContain("Visible:");
		expect(output).not.toContain("Drift:");
		expect(output).not.toContain("committed");
		expect(output).not.toContain("pending");
	});

	it("reports V3 ledger counts, visible/full drift, and ignores old V2 memory", async () => {
		const obsA = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obsB = observation("bbbbbbbbbbbb", { tokenCount: 7 });
		const ref = reflection("eeeeeeeeeeee", ["bbbbbbbbbbbb"], { tokenCount: 3 });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
			compactionEntry("cmp-visible", { firstKeptEntryId: "raw-1", details: memoryDetails({ observations: [obsA], reflections: [] }) }),
			observationsRecordedEntry("om-obs", { observations: [obsA, obsB], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "om-obs" }),
			observationsDroppedEntry("om-drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "om-ref" }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Observations: 2 recorded / 1 deleted / 0 inactive / 1 active / 1 visible +1 -1");
		expect(output).toContain("Reflections:  1 recorded / 0 deleted / 0 inactive / 1 active / 0 visible +1");
		expect(output).toContain("Visible observation pool: ~5 / 40 tokens (13%)");
		expect(output).toContain("Active memory pool:      ~10 / 20 target tokens (50%)");
		expect(output).not.toContain("Visible:");
		expect(output).not.toContain("Drift:");
		expect(output).not.toContain("full truth");
		expect(output).not.toContain("v2-obs");
		expect(output).not.toContain("observational-memory");
	});

	it("shows separate progress clocks, visible pool, active observation pool, and reflection pool", async () => {
		const obs = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const ref = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"], { tokenCount: 3 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-ref", { reflections: [ref], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			compactionEntry("cmp", { firstKeptEntryId: "raw-2", details: memoryDetails({ observations: [obs], reflections: [ref] }) }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Next observation:");
		expect(output).toContain("/ 10 tokens");
		expect(output).toContain("Librarian backlog:");
		expect(output).toContain("Next compaction:");
		expect(output).toContain("/ 30 tokens");
		expect(output).toContain("Visible observation pool: ~5 / 40 tokens (13%)");
		expect(output).toContain("Active memory pool:      ~8 / 20 target tokens (40%)");
		expect(output).toContain("Reflection pool:         ~3 visible tokens");
		expect(output).not.toContain("Observation pool:");
		expect(output).not.toContain("Full fold pool:");
		expect(output).not.toContain("visible observation tokens");
	});

	it("shows over-target active observation pool in the Activity section", async () => {
		const obs = observation("aaaaaaaaaaaa", { tokenCount: 25 });
		const entries = [
			textCustomMessage("raw-1", "aaaaaaaa"),
			observationsRecordedEntry("om-obs", { observations: [obs], coversUpToId: "raw-1" }),
		];

		const output = await setup({ entries }).run();

		expect(output).toContain("Active memory pool:      ~25 / 20 target tokens (125%)");
	});

	it("shows passive mode, observer consolidation, compaction, and current worker errors", async () => {
		const output = await setup({
			entries: [],
			runtime: {
				config: { observeAfterTokens: 10, compactAfterTokens: 30, observationsPoolMaxTokens: 40, observationsPoolTargetTokens: 20, passive: true },
				consolidationInFlight: true,
				consolidationPhase: "observer",
				compactInFlight: true,
				compactHookInFlight: true,
				lastObserverError: "observer failed",
				lastLibrarianError: "librarian failed",
			},
		}).run();

		expect(output).toContain("Passive: automatic memory workers and auto-compaction disabled");
		expect(output).toContain("Consolidation: running (observer)");
		expect(output).toContain("Auto-compaction: running");
		expect(output).toContain("Compaction hook: running");
		expect(output).toContain("Observer: observer failed");
		expect(output).toContain("Librarian: librarian failed");
		expect(output).not.toContain("Reflector:");
		expect(output).not.toContain("Dropper:");
	});

	it("shows consolidation in flight without phase when phase is unavailable", async () => {
		const output = await setup({ entries: [], runtime: { consolidationInFlight: true } }).run();

		expect(output).toContain("Consolidation: running");
		expect(output).not.toContain("Consolidation: running (");
	});

	describe("ratio mode", () => {
		it("shows the context-window-scaled threshold in the Next compaction line", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						compactAfterTokens: 30,
						compactAfterTokensMode: "ratio",
						compactAfterTokensRatio: 0.5,
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: { contextWindow: 1_000_000 },
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 500,000 tokens (0%)");
		});

		it("falls back to calibrated threshold when model is unavailable in ratio mode", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						compactAfterTokens: 30,
						compactAfterTokensMode: "ratio",
						compactAfterTokensRatio: 0.5,
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: undefined,
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 30 tokens (0%)");
		});

		it("falls back to calibrated threshold when contextWindow is zero in ratio mode", async () => {
			const output = await setup({
				entries: [],
				runtime: {
					config: {
						observeAfterTokens: 10,
						compactAfterTokens: 30,
						compactAfterTokensMode: "ratio",
						compactAfterTokensRatio: 0.5,
						observationsPoolMaxTokens: 40,
						observationsPoolTargetTokens: 20,
						passive: false,
					},
				},
				model: { contextWindow: 0 },
			}).run();

			expect(output).toContain("Next compaction:  ~0 / 30 tokens (0%)");
		});
	});

	it("shows token usage in the Activity section after agent runs", async () => {
		const output = await setup({
			entries: [],
			runtime: {
				agentUsage: { input: 1500, output: 250, cacheRead: 12_000, cacheWrite: 0, cost: 0.0042, runs: 3 },
			},
		}).run();

		expect(output).toContain("Token usage:            ↑1.5k ↓250 R12k $0.004 (3 calls)");
	});

	it("omits the token usage line when no agent has run", async () => {
		const output = await setup({ entries: [] }).run();

		expect(output).not.toContain("Token usage");
	});

	it("shows probe count and the most recent probe from branch suggestions", async () => {
		const suggestion = (probeId: string | undefined, text: string) => ({
			id: `sug-${probeId ?? "legacy"}-${text.length}`,
			parentId: "root",
			timestamp: "2026-01-01T00:00:00.000Z",
			type: "custom",
			customType: "om.contemplator.suggestion",
			data: { suggestion: text, delivered: false, probeId },
		});
		const output = await setup({
			entries: [
				suggestion("p1", "First question?"),
				suggestion(undefined, "Legacy question?"),
				suggestion("p2", "Second question?"),
				suggestion("p1", "First question? (re-queued)"),
			],
		}).run();

		// Deduped by probeId (p1 re-queue collapses) + legacy entry without a probeId counts individually.
		expect(output).toContain("Probes sent:            3");
		expect(output).toContain("Last probe:             Second question?");
	});

	it("shows the latest reviewer result and queued primary-agent notice", async () => {
		const summary = "A reusable trace would preserve the repeated relationship reconstruction.";
		const entries = [
			{
				id: "review-result", type: "custom", customType: "om.review.result", data: { result: {
					id: "aaaaaaaaaaaa", version: 1, reviewRequestId: "request-1", scope: "workflow", outcome: "proposal", proposalKind: "workflow", createdAt: 1, requestedBy: "contemplator",
					title: "Reusable trace", summary, evidence: "[bbbbbbbbbbbb] recurrence", inefficiency: "Repeated reconstruction", conceptualDesign: "Keep a durable trace.", expectedEffect: "Better reuse", uncertainties: "Environment fit remains unknown.",
				} },
			},
			{
				id: "review-notice", type: "custom", customType: "om.reviewer.notice", data: { reviewRequestId: "request-1", reviewMemoryId: "aaaaaaaaaaaa", scope: "workflow", content: `BACKGROUND WORKFLOW REVIEW PROPOSAL [aaaaaaaaaaaa]\\n\\n${summary}` },
			},
		] as TestEntry[];

		const output = await setup({ entries }).run();
		expect(output).toContain("Last review:            [aaaaaaaaaaaa] workflow proposal");
		expect(output).toContain(`Last review summary:    ${summary}`);
		expect(output).toContain("Last reviewer notice:  BACKGROUND WORKFLOW REVIEW PROPOSAL [aaaaaaaaaaaa]");
	});

	it("omits the probe lines when the branch has no suggestions", async () => {
		const output = await setup({ entries: [] }).run();

		expect(output).not.toContain("Probes sent");
		expect(output).not.toContain("Last probe");
	});
});
