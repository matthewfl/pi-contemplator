import { describe, expect, it, vi } from "vitest";

const summarizerMocks = vi.hoisted(() => ({ runSummarizer: vi.fn() }));
vi.mock("../src/agents/summarizer/agent.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/agents/summarizer/agent.js")>()),
	runSummarizer: summarizerMocks.runSummarizer,
}));

import { DEFAULTS } from "../src/config.js";
import { scheduleSummarizer } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import type { Entry } from "../src/session-ledger/index.js";

describe("summarizer contemplation isolation", () => {
	it("persists successful summaries without waking the contemplator", async () => {
		const entries: Entry[] = [{
			type: "custom", id: "observations", customType: "om.observations.recorded",
			data: {
				coversUpToId: "raw",
				observations: ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"].map((id, index) => ({
					id, content: `old memory ${index}`, timestamp: `2026-01-0${index + 1} 00:00`,
					relevance: "low", retention: "contextual", sourceEntryIds: ["raw"], tokenCount: 20,
				})),
			},
		}];
		const runtime = new Runtime();
		runtime.configLoaded = true;
		runtime.config = {
			...DEFAULTS,
			newMemoryPoolMaxTokens: 20,
			oldMemoryPoolTargetTokens: 1,
			showWorkerNotifications: false,
		};
		vi.spyOn(runtime, "resolveModel").mockResolvedValue({ ok: true, model: {}, apiKey: "test" });
		const memoryUpdate = vi.fn();
		runtime.setMemoryUpdateListener(memoryUpdate);
		const commit = {
			version: 1 as const,
			summaries: [{
				id: "dddddddddddd", content: "Old work was consolidated [aaaaaaaaaaaa, bbbbbbbbbbbb].",
				timestamp: "2026-01-02 00:00", sourceMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
				consumedMemoryIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], tokenCount: 8,
			}],
			coversUpToId: "observations", createdAt: 1, completedWithDone: true,
			metrics: { consumedMemoryCount: 2, sourceTokens: 40, summaryTokens: 8, estimatedTokenReduction: 32 },
		};
		summarizerMocks.runSummarizer.mockResolvedValue({ completed: true, commit });
		const pi = { appendEntry: vi.fn() };
		const ctx = {
			cwd: "/tmp/project", hasUI: false, model: {}, modelRegistry: {},
			sessionManager: { getBranch: () => entries, getSessionId: () => "summary-notify-test" },
		};

		scheduleSummarizer(pi as any, runtime, ctx as any);
		await runtime.summarizerPromise;

		expect(pi.appendEntry).toHaveBeenCalledWith("om.summarizer.commit", commit);
		expect(memoryUpdate).not.toHaveBeenCalled();
	});
});
