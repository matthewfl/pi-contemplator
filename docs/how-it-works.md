# How it works

## Event flow

1. `agent_start` and `turn_end` evaluate observer work and synchronize librarian scheduling.
2. The observer serializes the oldest uncovered source entries, bounded by its input cap, and appends `om.observations.recorded`.
3. Newly created memory ids mark the librarian dirty. Repeated ledger occurrences of the same content-addressed memory do not create duplicate librarian work.
4. The librarian scheduler coalesces changes until its token threshold, pressure threshold, or maximum delay is reached, while respecting the minimum interval and a single-flight lock.
5. A fresh librarian run receives active memories plus grouped inactive cues. It stages tool actions and must call `done`.
6. A successful pass appends one atomic `om.librarian.commit`; an incomplete or failed pass appends nothing and restores captured dirty counters.
7. Memory updates may independently wake the contemplator. Reviewer work runs under its own lock and does not block observer, librarian, contemplator, or primary-agent work.

## Observer coverage

Observer progress is source-addressed by `coversUpToId`. Input is drained oldest-first. Complete entries are preferred; if the first source alone exceeds the cap, it is represented by a marked head/tail excerpt while retaining the original source id for provenance.

The cap is explicit `observerChunkMaxTokens` when configured, otherwise 20% of the resolved model context window (with a fallback). Empty observer output does not fake coverage, so the range can be retried with later context.

## Librarian scheduling

A dirty librarian backlog tracks newly created memory count, estimated tokens, and first-dirty time. A run becomes eligible when:

- pending memory tokens reach `librarianMinNewMemoryTokens`; or
- active memory reaches `observationsPoolTargetTokens * librarianPressureTriggerRatio`; or
- `librarianMaxDelayMinutes` elapses.

The scheduler normally waits until `librarianMinIntervalMinutes` after the prior start. However, if pending memory reaches `librarianMaxPendingMemoryTokens` (20k by default), it bypasses that wall-clock interval and runs as soon as the librarian's single-flight slot is available. This keeps very high-throughput sessions from filling memory faster than a time-only schedule can react. Zero-minute values are supported for tests or deliberately immediate operation. Updates coalesce while one run is active.

The active-memory target is advisory. Code does not force the librarian to remove a fixed count. Librarian input sampling is a separate safeguard: `librarianSamplingThresholdTokens` caps rendered memory input at 40,000 tokens by default.

## Librarian transaction

The librarian starts from a ledger snapshot. All mutation tools stage changes in memory:

- `record_reflection` is all-or-nothing and requires at least two valid, inspected sources. Its source disposition is `keepActive`, `makeInactive`, or `delete`; deletion requires a separate reason.
- lifecycle batch tools accept valid targets even if some target ids are invalid, but shared evidence/dependency validation is all-or-nothing;
- lifecycle changes require inspected observation evidence that follows the target state;
- `make_active` expands an inactive alias and returns all restored memory bodies;
- independent tool calls may execute in parallel, but `done` must be called alone in a later response after receipts are visible.

Up to three continuation invocations remind a model that stops without `done`. No terminal call means the whole staged transaction is discarded.

## Folding and projection

`foldLedger` reconstructs observations, reflections, lifecycle state, active/inactive/deleted sets, and provenance pointers from legacy records plus librarian commits. Legacy dropper tombstones are interpreted as logical deletions for migration compatibility.

Routine and compaction projections include only active memories. Search and recall use the full durable archive. Compaction details preserve the complete memory archive and lifecycle snapshots, allowing inactive and deleted memories to survive old raw-entry folding.

## Compaction

Proactive compaction is controlled by `compactAfterTokensMode`:

- `calibrated` uses `compactAfterTokens`;
- `ratio` uses `floor(contextWindow * compactAfterTokensRatio)`.

Agent-requested compaction resumes with the authored continuation prompt. Proactive maintenance after a normally settled turn does not restart the agent. Failed/too-small compactions retain the fail-safe continuation behavior. A compaction observer can run asynchronously without blocking compaction.

## Probe delivery

A contemplator probe is persisted as pending but displayed only after Pi accepts it into the conversation stream. It is sent as a steer, not a follow-up turn. During tools it waits for the current (including parallel) tool batch to finish, then appears in the next provider request. Pending probes survive restore and branch movement and are acknowledged exactly once.

## Concurrency

Observer/consolidation, librarian, contemplator, and reviewer each have separate tracked tasks. The librarian is single-flight; reviews are serialized. None blocks the primary agent. Context-generation checks discard stale background output after branch/session changes.
