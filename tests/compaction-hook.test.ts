import { describe, expect, it, vi } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
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

function setup(args: { entries: TestEntry[]; observationsPoolMaxTokens?: number; compactHookInFlight?: boolean; compactionObserverEnabled?: boolean }) {
	let beforeHandler: ((event: any, ctx: any) => Promise<unknown>) | undefined;
	let compactHandler: ((event: any, ctx: any) => void) | undefined;
	const pi = {
		on: vi.fn((eventName: string, cb: any) => {
			if (eventName === "session_before_compact") beforeHandler = cb;
			if (eventName === "session_compact") compactHandler = cb;
		}),
		appendEntry: vi.fn(),
	};
	const runtime = {
		config: {
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 20_000,
			compactionObserverEnabled: args.compactionObserverEnabled,
		},
		compactInFlight: false,
		compactHookInFlight: args.compactHookInFlight ?? false,
		compactionResumePending: false,
		compactionResumeGeneration: 0,
		compactionResumeTimer: undefined,
		observerPromise: new Promise(() => {}),
		resolveModel: vi.fn(() => {
			throw new Error("resolveModel must not be called");
		}),
		ensureConfig: vi.fn(),
		launchConsolidationTask: vi.fn(() => Promise.resolve()),
	};
	registerCompactionHook(pi as any, runtime as any);
	if (!beforeHandler || !compactHandler) throw new Error("compaction handlers were not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		sessionManager: { getBranch: vi.fn(() => args.entries) },
	};
	const run = (firstKeptEntryId = args.entries.at(-1)?.id ?? "missing", event: Record<string, unknown> = {}) => beforeHandler!({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: args.entries,
		signal: undefined,
		reason: "manual",
		willRetry: false,
		...event,
	}, ctx);
	const finish = (event: Record<string, unknown> = {}) => compactHandler!({
		reason: "manual",
		willRetry: false,
		...event,
	}, ctx);
	return { pi, runtime, ctx, run, finish };
}

describe("V3 compaction hook", () => {
	it("returns valid empty om.folded details when there is no V3 memory", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime, pi } = setup({ entries });

		const result = await run("raw-1");

		expect(result).toMatchObject({
			compaction: {
				firstKeptEntryId: "raw-1",
				tokensBefore: 123,
				summary: "",
				details: {
					type: "om.folded",
					version: 1,
					fullFold: false,
					observations: [],
					reflections: [],
				},
			},
		});
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("first normal compaction writes covered observations without orphan reflections", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-1") as any;

		expect(result.compaction.details.fullFold).toBe(false);
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(result.compaction.details.reflections).toEqual([]);
		expect(result.compaction.summary).toContain("## Observations");
		expect(result.compaction.summary).not.toContain("## Reflections");
	});

	it("writes a normal V3 projection without applying new reflections or drops", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-2") as any;

		expect(result.compaction.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(result.compaction.details.reflections.map((ref: any) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(result.compaction.summary).toContain("## Reflections\n[eeeeeeeeeeee]");
		expect(result.compaction.summary).toContain("## Observations");
	});

	it("writes a full V3 projection when observation pool pressure reaches the threshold", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-2") as any;

		expect(result.compaction.details.fullFold).toBe(true);
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(result.compaction.details.reflections.map((ref: any) => ref.id)).toEqual(["eeeeeeeeeeee", "ffffffffffff"]);
	});

	it("ignores old V2 memory entries and details", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
		];
		const { run } = setup({ entries });

		const result = await run("cmp-v2") as any;

		expect(result.compaction.details).toMatchObject({
			type: "om.folded",
			observations: [],
			reflections: [],
		});
	});

	it("does not wait for worker promises or call model resolution", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime } = setup({ entries });

		const result = await Promise.race([
			run("raw-1"),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 50)),
		]);

		expect(result).toMatchObject({ compaction: { details: { type: "om.folded" } } });
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(runtime.launchConsolidationTask).toHaveBeenCalledTimes(1);
	});

	it("can disable the asynchronous compaction observer without changing the projection", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime } = setup({ entries, compactionObserverEnabled: false });

		const result = await run("raw-1");

		expect(result).toMatchObject({ compaction: { details: { type: "om.folded" } } });
		expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
	});

	it("shows overflow retry status and confirms automatic resume after compaction", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, finish, runtime, ctx } = setup({ entries });

		await run("raw-1", { reason: "overflow", willRetry: true });

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"observational-memory-compaction",
			"OM compaction: running (overflow, retry pending)",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: compaction started (overflow); the interrupted agent run will resume automatically",
			"info",
		);

		finish({ reason: "overflow", willRetry: true });

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("observational-memory-compaction", undefined);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(
			"Observational memory: compaction complete (overflow); resuming the interrupted agent run",
			"info",
		);
		expect(runtime.compactionResumePending).toBe(true);
		clearTimeout(runtime.compactionResumeTimer);
	});

	it("reports OM proactive compaction without claiming it will resume settled work", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, finish, runtime, ctx } = setup({ entries });
		runtime.compactInFlight = true;

		await run("raw-1");

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"observational-memory-compaction",
			"OM compaction: running (proactive)",
		);

		finish();

		expect(ctx.ui.notify).toHaveBeenLastCalledWith(
			"Observational memory: compaction complete (proactive)",
			"info",
		);
	});

	it("labels tool-requested compaction status and completion", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, finish, runtime, ctx } = setup({ entries });
		runtime.compactInFlight = true;
		(runtime as any).compactOrigin = "agent-requested";

		await run("raw-1");

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"observational-memory-compaction",
			"OM compaction: running (agent-requested, resume pending)",
		);

		finish();

		expect(ctx.ui.notify).toHaveBeenLastCalledWith(
			"Observational memory: compaction complete (agent-requested); resuming the agent run",
			"info",
		);
	});

	it("cancels duplicate in-flight compaction and notifies the UI", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, ctx } = setup({ entries, compactHookInFlight: true });

		await expect(run("raw-1")).resolves.toEqual({ cancel: true });
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: another compaction is already in progress; cancelling duplicate",
			"warning",
		);
	});
});
