# How it works

## Event flow

1. Session restore/tree changes, `agent_start`, `turn_end`, and main-agent activity checkpoints evaluate background work.
2. The observer serializes the oldest uncovered source entries, bounded by its input cap, and appends `om.observations.recorded`.
3. Active observations and summaries are sorted chronologically. The newest whole-memory suffix fitting `newMemoryPoolMaxTokens` is the protected new pool; the older prefix is the summarizer-eligible old pool.
4. When the old pool exceeds its current token trigger, a fresh single-flight summarizer run receives only old memories and creates strictly validated citation summaries.
5. Accepted work appends one atomic `om.summarizer.commit`. Partial useful work is retained even if the run reaches its turn/output limit; an empty run writes no commit.
6. If the pass reaches the old-pool target, the next trigger resets to the target. Otherwise it advances to the post-run old-pool size plus the configured retrigger growth.
7. Memory updates may independently wake the contemplator. Reviewer work has its own lock and does not block observer, summarizer, contemplator, or primary-agent work.

## Observer coverage

Observer progress is source-addressed by `coversUpToId`. Input is drained oldest-first. Complete entries are preferred; if the first source alone exceeds the cap, it is represented by a marked head/tail excerpt while retaining the original source id for provenance.

The cap is explicit `observerChunkMaxTokens` when configured, otherwise 25% of the resolved model context window (with a fallback). Each catch-up pipeline captures a finite source boundary at launch and processes that snapshot oldest-first in bounded chunks until its remaining source falls below the normal observer trigger. Source appended concurrently is deferred to a later snapshot instead of extending the running pipeline indefinitely.

The observer is encouraged to call `done` as a terminal shortcut, but it is not a commit gate: any valid observations already recorded are committed even when `done` is omitted. A zero-observation prose stop receives one reminder showing the recorded count; if it still emits nothing, the chunk is treated as empty. Provider errors, output truncation, and wholly invalid records are reported as failed chunks. During backlog catch-up those zero-progress failures receive an empty coverage marker so one pathological old range cannot pin all newer memory and the contemplator forever.

While the captured snapshot remains at or above `observeAfterTokens`, the same background pipeline keeps launching bounded observer passes. Intermediate batches are committed durably, but they do not wake the contemplator individually. At the end of that finite snapshot, the contemplator gets one combined memory-update opportunity even if the primary agent produced more source concurrently. If that deferred source already exceeds the trigger, the scheduler starts another finite snapshot only after releasing the current pipeline lock and issuing that notification.

## Summarizer scheduling

Pool membership is accounting-only state derived from the active ledger; no pool marker is persisted. By default, the newest 40,000 tokens are protected as the new pool. Everything older is the old pool, whose advisory target is also 40,000 tokens. Whole memories are never split across the boundary, and the newest memory is always protected even if it alone exceeds the new-pool budget.

A run starts when the old pool strictly exceeds its current trigger. The initial trigger is `oldMemoryPoolTargetTokens`. After a pass:

- if old memory is at or below the target, the next trigger resets to the target;
- otherwise the next trigger is `postRunOldTokens + summarizerRetriggerTokens` (2,000 by default).

There are no wall-clock or agent-time eligibility gates. The in-memory next-trigger value is re-evaluated at session restore and main-agent activity checkpoints and is safely recomputed after restart. Updates coalesce while one run is active. A no-progress, failed, or stalled model pass that spent model budget advances to `postRunOldTokens + summarizerRetriggerTokens`; this prevents identical-prompt retries at every checkpoint while guaranteeing another attempt after bounded old-memory growth. Model-resolution failures spend no tokens and remain eligible.

Only old memories are eligible and shown to the summarizer. Input sampling is a separate escape valve: when rendered old memory exceeds `summarizerSamplingThresholdTokens` (60,000 by default), weighted sampling back to that budget uses weight proportional to inverse memory length. In normal operation the 40,000-token target should make sampling uncommon.

## Summarizer validation and commit

The tools execute sequentially so each receipt is visible before the next mutation:

- `summarize` can mark valid active memories `keep_verbatim` for this run and process multiple candidate summary strings;
- each summary must use strict square-bracket citations, cite at least two newly consumable pre-run memories, and be no more than 80% of their estimated source tokens;
- a memory already consumed by an earlier accepted candidate, marked keep-verbatim, or created during this run may still be cited, but does not count toward the two-source or reduction checks;
- `fix_summary` atomically deletes or replaces only a summary created in the current run, updating which sources are consumed; and
- `done` reports run statistics on its first call and completes on its second consecutive call.

Malformed candidates are rejected individually with actionable errors. Accepted candidates remain staged. If the model stops without `done`, continuation requests require tool use; useful accepted work is still returned and committed when limits are reached.

## Folding and projection

`foldLedger` reconstructs all observations and summaries, then derives the consumption and citation graph from summarizer commits. Routine and compaction projections inject only unconsumed observations and summaries. Search and recall use the complete durable archive, including consumed records and review outcomes.

Compaction details preserve the full memory graph so old raw ledger entries may be folded away without breaking search, recall, or provenance.

## Compaction

Proactive compaction is controlled by `compactAfterTokensMode`:

- `calibrated` uses the `compactAfterTokens` raw source-backlog threshold (81,000 by default);
- `ratio` uses `floor(contextWindow * compactAfterTokensRatio)`.

Injected observations and summaries do not contribute to this proactive source-backlog counter. They do contribute to the actual model context seen by Pi, so Pi may still invoke its native context-limit compaction earlier when source context plus injected memory approaches the model limit.

Agent-requested compaction resumes with the authored continuation prompt. Proactive maintenance after a normally settled turn does not restart the agent. Failed/too-small compactions retain the fail-safe continuation behavior. A compaction observer can run asynchronously without blocking compaction.

## Probe delivery

A contemplator probe is persisted as pending but displayed only after Pi accepts it into the conversation stream. It is sent as a steer, not a follow-up turn. During tools it waits for the current (including parallel) tool batch to finish, then appears in the next provider request. Pending probes survive restore and branch movement and are acknowledged exactly once.

## Concurrency

Observer/consolidation, summarizer, contemplator, and reviewer each have separate tracked tasks. Every model worker has a hard single-flight liveness boundary: 15 minutes without streamed progress aborts cooperatively and releases the lock even if a provider ignores cancellation; continuously progressing workers also have a six-hour absolute ceiling. Compaction callbacks have a separate 30-minute lock-release failsafe. Session/tree changes detach old task locks immediately, and identity guards prevent stale finalizers from unlocking newer work.

Observer source failures advance only their bounded failed chunk, so one pathological range cannot pin newer source. If observer model setup itself is unavailable, contemplation temporarily runs in degraded mode rather than deadlocking behind the backlog; later activity retries observation. Contemplator failures receive one response-spaced retry, then release the poisoned update so future memories still run. The compaction observer may record memories alongside compaction, but it never launches a summarizer from inside the compaction sidecar. A later normal activity checkpoint re-evaluates the pools. Reviews are serialized. None of these workers blocks the primary agent. Context-generation checks discard stale background output after branch/session changes.
