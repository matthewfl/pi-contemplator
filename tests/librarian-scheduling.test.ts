import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runLibrarian: vi.fn() }));
vi.mock("../src/agents/librarian/agent.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/agents/librarian/agent.js")>();
	return { ...original, runLibrarian: mocks.runLibrarian };
});

import { newMemoryIdsSinceLibrarianCoverage } from "../src/agents/librarian/agent.js";
import { librarianDirtySinceAgentTime, librarianScheduleDelayMs, scheduleLibrarian } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import { OM_LIBRARIAN_COMMIT, type Entry } from "../src/session-ledger/index.js";

function observationBranch(): Entry[] {
	return [
		{ type: "message", id: "raw-1", message: { role: "user", content: [{ type: "text", text: "alpha" }] } },
		{
			type: "custom", id: "obs-entry", customType: "om.observations.recorded",
			data: { coversUpToId: "raw-1", observations: [{ id: "aaaaaaaaaaaa", content: "Alpha memory.", timestamp: "2026-01-01 10:00", relevance: "medium", retention: "contextual", sourceEntryIds: ["raw-1"], tokenCount: 100 }] },
		},
	] as Entry[];
}

function runtime(): Runtime {
	const runtime = new Runtime();
	runtime.config = {
		...runtime.config,
		librarianEnabled: true,
		librarianMinIntervalMinutes: 30,
		librarianMaxDelayMinutes: 180,
		librarianMinNewMemoryTokens: 5_000,
		librarianMaxPendingMemoryTokens: 20_000,
		librarianPressureTriggerRatio: 1,
		observationsPoolTargetTokens: 10_000,
		showWorkerNotifications: false,
	};
	runtime.configLoaded = true;
	return runtime;
}

function context(entries: Entry[]) {
	return {
		cwd: "/tmp/project",
		hasUI: false,
		model: { contextWindow: 100_000 },
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key" })),
		},
		sessionManager: { getBranch: () => entries },
	};
}

beforeEach(() => {
	mocks.runLibrarian.mockReset();
});

describe("librarian scheduling", () => {
	it("does not treat a repeated content-addressed observation as new librarian work", () => {
		const entries = observationBranch();
		entries.push({
			type: "custom", id: "commit-1", customType: OM_LIBRARIAN_COMMIT,
			data: { version: 1, reflections: [], actions: [], coversUpToId: "obs-entry", summary: "Reviewed.", createdAt: 1 },
		} as Entry);
		entries.push({
			type: "custom", id: "obs-retry", customType: "om.observations.recorded",
			data: { coversUpToId: "raw-2", observations: [{ id: "aaaaaaaaaaaa", content: "Alpha memory.", timestamp: "2026-01-01 10:00", relevance: "medium", retention: "contextual", sourceEntryIds: ["raw-1"], tokenCount: 100 }] },
		} as Entry);

		expect(newMemoryIdsSinceLibrarianCoverage(entries)).toEqual(new Set());
	});

	it("uses the retained librarian commit when compaction removed its covered batch", () => {
		const entries = [
			{
				type: "custom", id: "retained-old-batch", customType: "om.observations.recorded",
				data: { coversUpToId: "raw-old", observations: [{ id: "aaaaaaaaaaaa" }] },
			},
			{
				type: "custom", id: "commit", customType: OM_LIBRARIAN_COMMIT,
				data: { version: 1, reflections: [], actions: [], coversUpToId: "folded-away-batch", summary: "Reviewed.", createdAt: 1 },
			},
			{
				type: "custom", id: "new-batch", customType: "om.observations.recorded",
				data: { coversUpToId: "raw-new", observations: [{ id: "bbbbbbbbbbbb" }] },
			},
		] as Entry[];

		expect(newMemoryIdsSinceLibrarianCoverage(entries)).toEqual(new Set(["bbbbbbbbbbbb"]));
	});

	it("deduplicates retries of observations known only through a compaction archive", () => {
		const archived = { id: "aaaaaaaaaaaa", content: "Archived memory.", timestamp: "2026-01-01 10:00", relevance: "medium", retention: "contextual", sourceEntryIds: ["raw-old"], tokenCount: 10 };
		const entries = [
			{
				type: "compaction", id: "compaction", details: {
					type: "om.folded", version: 1, fullFold: false,
					observations: [archived], reflections: [],
					archive: { observations: [archived], reflections: [], lifecycle: [] },
				},
			},
			{
				type: "custom", id: "covered-batch", customType: "om.observations.recorded",
				data: { coversUpToId: "raw-covered", observations: [{ id: "bbbbbbbbbbbb" }] },
			},
			{
				type: "custom", id: "commit", customType: OM_LIBRARIAN_COMMIT,
				data: { version: 1, reflections: [], actions: [], coversUpToId: "covered-batch", summary: "Reviewed.", createdAt: 1 },
			},
			{
				type: "custom", id: "retry-and-new", customType: "om.observations.recorded",
				data: { coversUpToId: "raw-new", observations: [{ id: "aaaaaaaaaaaa" }, { id: "cccccccccccc" }] },
			},
		] as Entry[];

		expect(newMemoryIdsSinceLibrarianCoverage(entries)).toEqual(new Set(["cccccccccccc"]));
	});

	it("does not let a post-coverage archive hide genuinely unreviewed memory", () => {
		const unreviewed = { id: "cccccccccccc", content: "New after prior pass.", timestamp: "2026-01-03 10:00", relevance: "high", retention: "durable", sourceEntryIds: ["raw-new"], tokenCount: 10 };
		const entries = [
			{
				type: "custom", id: "covered-batch", customType: "om.observations.recorded",
				data: { coversUpToId: "raw-covered", observations: [{ id: "bbbbbbbbbbbb" }] },
			},
			{
				type: "custom", id: "commit", customType: OM_LIBRARIAN_COMMIT,
				data: { version: 1, reflections: [], actions: [], coversUpToId: "covered-batch", summary: "Reviewed.", createdAt: 1 },
			},
			{
				type: "compaction", id: "later-compaction", details: {
					type: "om.folded", version: 1, fullFold: false,
					observations: [unreviewed], reflections: [],
					archive: { observations: [unreviewed], reflections: [], lifecycle: [] },
				},
			},
			{
				type: "custom", id: "retry", customType: "om.observations.recorded",
				data: { coversUpToId: "raw-newer", observations: [{ id: "cccccccccccc" }] },
			},
		] as Entry[];

		expect(newMemoryIdsSinceLibrarianCoverage(entries)).toEqual(new Set(["cccccccccccc"]));
	});

	it("reconstructs pending-memory age from durable agent time after reload", () => {
		const entries = [
			{ type: "custom", id: "activity-before", customType: "om.agent.activity", data: { version: 1, durationMs: 60_000 } },
			...observationBranch(),
			{ type: "custom", id: "activity-after-1", customType: "om.agent.activity", data: { version: 1, durationMs: 5 * 60_000 } },
			{ type: "custom", id: "activity-after-2", customType: "om.agent.activity", data: { version: 1, durationMs: 4 * 60_000 } },
		] as Entry[];
		const newIds = new Set(["aaaaaaaaaaaa"]);

		expect(librarianDirtySinceAgentTime(entries, newIds)).toBe(60_000);
		const r = runtime();
		r.config = { ...r.config, librarianMaxDelayMinutes: 8 };
		r.markLibrarianDirty(1, 100, librarianDirtySinceAgentTime(entries, newIds));
		expect(librarianScheduleDelayMs(r, 100, 10 * 60_000)).toBe(0);
	});

	it("coalesces below-threshold observer work until maximum delay", () => {
		const r = runtime();
		r.markLibrarianDirty(2, 1_000, 1_000);
		expect(librarianScheduleDelayMs(r, 2_000, 1_000)).toBe(180 * 60_000);
		r.markLibrarianDirty(8, 4_000, 2_000);
		expect(librarianScheduleDelayMs(r, 2_000, 2_000)).toBe(0);
	});

	it("does not advance a below-threshold maximum delay while the agent is idle", async () => {
		vi.useFakeTimers();
		try {
			const r = runtime();
			const entries = observationBranch();
			const pi = { appendEntry: vi.fn() };
			mocks.runLibrarian.mockResolvedValue({
				completed: true,
				commit: { version: 1, reflections: [], actions: [], coversUpToId: "obs-entry", summary: "No changes.", createdAt: 1 },
				sample: { sampled: false },
			});
			r.markLibrarianDirty(1, 1_000, 0);
			scheduleLibrarian(pi as any, r, context(entries) as any, 0);

			await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
			expect(mocks.runLibrarian).not.toHaveBeenCalled();
			expect(r.librarianDirtySince).toBe(0);

			scheduleLibrarian(pi as any, r, context(entries) as any, 180 * 60_000);
			await r.librarianPromise;
			expect(mocks.runLibrarian).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("respects the minimum active-agent interval under normal token and pool pressure", () => {
		const r = runtime();
		r.librarianLastStartedAt = 1_000;
		r.markLibrarianDirty(1, 10_000, 2_000);
		expect(librarianScheduleDelayMs(r, 20_000, 2_000)).toBe(30 * 60_000 - 1_000);
	});

	it("bypasses the minimum interval at the urgent pending-token threshold", () => {
		const r = runtime();
		r.librarianLastStartedAt = 1_000;
		r.markLibrarianDirty(20, 20_000, 2_000);
		expect(librarianScheduleDelayMs(r, 2_000, 2_000)).toBe(0);
	});

	it("launches one pass, appends its atomic commit, and clears captured dirty work", async () => {
		const r = runtime();
		const entries = observationBranch();
		const pi = { appendEntry: vi.fn() };
		mocks.runLibrarian.mockResolvedValue({
			completed: true,
			commit: { version: 1, reflections: [], actions: [], coversUpToId: "obs-entry", summary: "No changes.", createdAt: 1 },
			sample: { sampled: false },
		});
		r.markLibrarianDirty(10, 5_000, 1);
		scheduleLibrarian(pi as any, r, context(entries) as any, 2);
		scheduleLibrarian(pi as any, r, context(entries) as any, 2);
		await r.librarianPromise;
		expect(mocks.runLibrarian).toHaveBeenCalledOnce();
		expect(pi.appendEntry).toHaveBeenCalledWith(OM_LIBRARIAN_COMMIT, expect.objectContaining({ summary: "No changes." }));
		expect(r.librarianDirtySince).toBeUndefined();
	});

	it("exposes model-resolution failures in the last librarian view", async () => {
		const r = runtime();
		const entries = observationBranch();
		const ctx = context(entries) as any;
		ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: false }));
		r.markLibrarianDirty(1, 5_000, 1);

		scheduleLibrarian({ appendEntry: vi.fn() } as any, r, ctx, 2);
		await r.librarianPromise;

		expect(r.lastLibrarianRun).toMatchObject({ status: "failed", messages: [], error: expect.stringContaining("no API key") });
		expect(r.librarianDirtySince).toBe(1);
	});

	it("restores captured dirty work when a pass stops without done", async () => {
		const r = runtime();
		const entries = observationBranch();
		mocks.runLibrarian.mockResolvedValue({ completed: false });
		r.markLibrarianDirty(4, 5_000, 1);
		scheduleLibrarian({ appendEntry: vi.fn() } as any, r, context(entries) as any, 2);
		await r.librarianPromise;
		expect(r.librarianPendingCount).toBe(4);
		expect(r.librarianPendingTokens).toBe(5_000);
		expect(r.librarianDirtySince).toBe(1);
	});
});
