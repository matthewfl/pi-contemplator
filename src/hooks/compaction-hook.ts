import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { computeSessionSettings, type Runtime } from "../runtime.js";
import { launchCompactionObserver, type ConsolidationCtx } from "./consolidation-trigger.js";
import { buildCompactionProjection, renderSummary, type Entry } from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { preparation, branchEntries } = event;
			const branch = branchEntries as Entry[];
			// Start memory capture without delaying compaction. This is configurable so
			// users can compare native compaction with and without the observer sidecar.
			if (runtime.config.compactionObserverEnabled !== false) {
				launchCompactionObserver(pi, runtime, ctx as ConsolidationCtx, branch);
			}
			const { firstKeptEntryId, tokensBefore } = preparation;
			const projection = buildCompactionProjection(
				branch,
				firstKeptEntryId,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
			);
			const summary = renderSummary(projection.reflections, projection.observations);
			// Compaction removes older custom entries from the active branch. Keep
			// session-scoped overrides in the compaction details so they can be
			// restored after a reload from the surviving branch. Bake the merged
			// branch intent (live om.settings entries winning over earlier snapshots)
			// rather than the raw in-memory overlay, which can lag out-of-band
			// om.settings appends and would otherwise silently override newer entries
			// at the next restore.
			const details = {
				...projection.details,
				sessionSettings: computeSessionSettings(branch),
			};

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
