# How it works

## Event flow

1. `agent_start`, `turn_end`, and main-agent activity checkpoints evaluate background work.
2. The observer serializes the oldest uncovered source entries, bounded by its input cap, and appends `om.observations.recorded`.
3. Newly created memory ids mark the summarizer dirty. Repeated ledger occurrences of the same content-addressed memory do not create duplicate work.
4. The scheduler coalesces changes until its token threshold, pressure threshold, or maximum cumulative agent-active delay is reached, while respecting a minimum interval and single-flight lock.
5. A fresh summarizer run receives selected active memories and creates strictly validated citation summaries.
6. Accepted work appends one atomic `om.summarizer.commit`. Partial useful work is retained even if the run reaches its turn/output limit; an empty run writes no commit.
7. Dirty counters are reconciled from the durable coverage marker when a pass exits, so observations arriving during the run are neither lost nor double-counted.
8. Memory updates may independently wake the contemplator. Reviewer work has its own lock and does not block observer, summarizer, contemplator, or primary-agent work.

## Observer coverage

Observer progress is source-addressed by `coversUpToId`. Input is drained oldest-first. Complete entries are preferred; if the first source alone exceeds the cap, it is represented by a marked head/tail excerpt while retaining the original source id for provenance.

The cap is explicit `observerChunkMaxTokens` when configured, otherwise 20% of the resolved model context window (with a fallback). Empty observer output does not fake coverage, so the range can be retried with later context.

## Summarizer scheduling

A dirty backlog tracks newly created memory count, estimated tokens, and first-dirty cumulative main-agent active time. A run becomes eligible when:

- pending memory tokens reach `summarizerMinNewMemoryTokens`; or
- active memory reaches `observationsPoolTargetTokens * summarizerPressureTriggerRatio`; or
- `summarizerMaxDelayMinutes` of main-agent active time elapses.

The scheduler normally waits until `summarizerMinIntervalMinutes` of active time after the prior start. If pending memory reaches `summarizerMaxPendingMemoryTokens` (20k by default), it bypasses that minimum. Scheduling is revisited at activity checkpoints rather than with a wall-clock timer, so time waiting for the user does not age the backlog. Updates coalesce while one run is active.

The target is advisory. Input sampling is a separate safety valve: `summarizerSamplingThresholdTokens` caps rendered memory input at 50,000 tokens by default.

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

- `calibrated` uses `compactAfterTokens`;
- `ratio` uses `floor(contextWindow * compactAfterTokensRatio)`.

Agent-requested compaction resumes with the authored continuation prompt. Proactive maintenance after a normally settled turn does not restart the agent. Failed/too-small compactions retain the fail-safe continuation behavior. A compaction observer can run asynchronously without blocking compaction.

## Probe delivery

A contemplator probe is persisted as pending but displayed only after Pi accepts it into the conversation stream. It is sent as a steer, not a follow-up turn. During tools it waits for the current (including parallel) tool batch to finish, then appears in the next provider request. Pending probes survive restore and branch movement and are acknowledged exactly once.

## Concurrency

Observer/consolidation, summarizer, contemplator, and reviewer each have separate tracked tasks. The summarizer has one authoritative process-local single-flight gate per session runtime: a second pass cannot start until the tracked first pass exits and releases its lock. A no-progress watchdog aborts a summarizer after 15 minutes without stream/message progress; normal streamed thinking resets the timer, so a long run that is still producing output is not cancelled. Aborted work remains dirty and eligible for a later retry.

The compaction observer may record memories alongside compaction, but it only marks summarizer work dirty and never launches a summarizer from inside the compaction sidecar. A later normal activity checkpoint schedules it. Reviews are serialized. None of these workers blocks the primary agent. Context-generation checks discard stale background output after branch/session changes.
