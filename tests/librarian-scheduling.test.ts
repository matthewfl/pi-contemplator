import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runLibrarian: vi.fn() }));
vi.mock("../src/agents/librarian/agent.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/agents/librarian/agent.js")>();
	return { ...original, runLibrarian: mocks.runLibrarian };
});

import { newMemoryIdsSinceLibrarianCoverage } from "../src/agents/librarian/agent.js";
import { librarianScheduleDelayMs, scheduleLibrarian } from "../src/hooks/consolidation-trigger.js";
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

	it("coalesces below-threshold observer work until maximum delay", () => {
		const r = runtime();
		r.markLibrarianDirty(2, 1_000, 1_000);
		expect(librarianScheduleDelayMs(r, 2_000, 1_000)).toBe(180 * 60_000);
		r.markLibrarianDirty(8, 4_000, 2_000);
		expect(librarianScheduleDelayMs(r, 2_000, 2_000)).toBe(0);
	});

	it("respects the minimum interval even under pressure", () => {
		const r = runtime();
		r.librarianLastStartedAt = 1_000;
		r.markLibrarianDirty(1, 10_000, 2_000);
		expect(librarianScheduleDelayMs(r, 20_000, 2_000)).toBe(30 * 60_000 - 1_000);
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

	it("restores captured dirty work when a pass stops without done", async () => {
		const r = runtime();
		const entries = observationBranch();
		mocks.runLibrarian.mockResolvedValue({ completed: false });
		r.markLibrarianDirty(4, 5_000, 1);
		scheduleLibrarian({ appendEntry: vi.fn() } as any, r, context(entries) as any, 2);
		await r.librarianPromise;
		expect(r.librarianPendingCount).toBe(4);
		expect(r.librarianPendingTokens).toBe(5_000);
		expect(r.librarianDirtySince).toBeDefined();
	});
});
