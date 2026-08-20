# Summarizer agent proposal

## Status

Design proposal for replacing the librarian agent. This document is intentionally implementation-oriented, but it is expected to change during review.

## Purpose

Replace the librarian with a simpler, mostly stateless **summarizer** whose only durable operation is loss-aware compression.

The summarizer:

- keeps important memories verbatim when compression would lose useful detail;
- creates shorter summaries from two or more active memories;
- embeds explicit source citations directly in every summary;
- removes successfully summarized source memories from automatic context while retaining them in the append-only ledger;
- permits summaries to summarize observations or older summaries, producing a navigable provenance graph back to the beginning of the session; and
- never decides among active, inactive, and deleted lifecycle states.

There is no new deletion operation and no `recallIf` mechanism. A memory is either visible in automatic context or has been **summarized away**. Summarized-away content remains searchable and recallable.

The core invariant is:

> Every memory removed from automatic context must be reachable through at least one active summary that is shorter than the newly summarized source memories.

## Why this is simpler

The librarian currently asks one model to judge reflection quality, infer several lifecycle actions, provide later evidence for those actions, manage inactive cohorts, write recall conditions, and distinguish deletion from inactivation. Those decisions interact and create a large tool schema.

The summarizer has one main decision: **can these memories be represented faithfully by this strictly shorter cited summary?** If not, it leaves them verbatim. The tool, rather than the model, performs source accounting and decides which cited memories are eligible to leave the visible pool.

## Memory model

### Memory nodes and terminology

Reflections and summaries are the same concept in the new design. Rename the reflection types, entry names, prompts, tools, settings, and UI language to **summary** rather than preserving two names for one kind of node. The implementation is not yet published, so avoiding a permanent reflection/summary compatibility layer is preferable.

The durable memory system has three directly stored memory-bearing record kinds with stable 12-character lowercase hexadecimal IDs:

1. original observer observations;
2. summarizer-created summaries; and
3. reviewer-agent review records.

Review records retain their review-specific schema and behavior; they are not renamed to summaries merely because they have memory IDs. Summaries may cite any memory kind that is exposed to the summarizer and valid for summary provenance.

A new summary stores:

```ts
type SummaryMemory = {
  id: string;
  content: string;             // Includes inline [source_id] citations.
  sourceMemoryIds: string[];   // Every valid citation, in first-occurrence order.
  consumedMemoryIds: string[]; // Sources this summary newly summarizes away.
  tokenCount: number;
};
```

`sourceMemoryIds` and `consumedMemoryIds` are intentionally different:

- `sourceMemoryIds` contains every cited memory.
- `consumedMemoryIds` contains only cited memories that count toward this summary's minimum-source and token-reduction checks and will leave automatic context.
- A keep-verbatim memory may be cited but is not consumed.
- A memory already consumed by another accepted summary in the same run may be cited again but is not consumed again.
- A memory already summarized away before this run may be cited after recall, but cannot contribute a second token reduction.

The durable ledger stores each summary body once. Source bodies are not copied into the summary commit. Forward links are derived from summary edges during ledger folding rather than duplicated onto every source record. Recalling any memory returns forward pointers to **all summaries that cite it**, while distinguishing which summary, if any, consumed it from automatic visibility.

### Visibility

The automatic memory projection contains:

1. all observations that have not been summarized away; and
2. all summaries that have not themselves been summarized away.

Review records are durable and addressable by memory ID, but they are not part of automatic memory injection. A proposal may produce its existing one-time compact steer notice, and review records may be found through search and read through recall. Because they do not occupy the automatic memory pool, review records may be cited as supporting provenance but are never consumable and contribute no token savings.

When a summary is committed, its `consumedMemoryIds` leave the visible projection and the summary enters it. Nothing is physically erased.

A source can appear in more than one summary's citation graph, but it can be counted as newly consumed only once. This prevents fictitious repeated savings.

### Graph behavior

The summary graph is directed from a summary to its cited source memories. It may have many-to-many edges. It must remain acyclic.

A summary can cite observations, durable summaries from earlier runs, recalled review memories, and summaries created earlier in the current run. If a current-run summary is cited by another current-run summary, the calls must be sequential so the first summary ID exists before the second call.

A summary created in the current run is conceptually keep-verbatim for the rest of that run: another summary may cite it, but cannot consume it, count it toward the two-source minimum, or count its tokens toward reduction. It becomes eligible for consumption only in a future summarizer run.

Ordinary self-citation is impossible because a summary ID is derived from its completed content and does not exist while that content is being authored. The implementation may still defensively reject the hash-equality edge case. It also rejects citations that would introduce a graph cycle.

## Agent tools

The summarizer has only these mutating/terminal tools:

- `summarize`
- `fix_summary`
- `done`

It also receives the shared read-only `search_memories` and `recall` tools.

Tool argument names use `snake_case` consistently.

## `summarize`

```ts
summarize({
  keep_verbatim?: string[],
  summaries?: string[]
})
```

At least one non-empty array must be supplied. The agent may call `summarize` repeatedly. One call may register multiple keep-verbatim decisions and multiple candidate summaries.

### Processing order

Within one call:

1. Process `keep_verbatim` first.
2. Process candidate summaries in array order.
3. Update run-local source accounting after every successful candidate before validating the next candidate.

Tool execution must be sequential, including when the provider emits several `summarize` calls in one response. Otherwise two parallel calls could consume the same source and both claim the same token savings.

### `keep_verbatim`

`keep_verbatim` is run-local bookkeeping, not a durable lifecycle state.

- A valid visible memory is marked as protected for the remainder of this summarizer run.
- An unmentioned memory also remains visible by default.
- Marking a memory helps the agent account explicitly for records it inspected and intentionally chose not to compress.
- A protected memory may still be cited in a summary, but it does not count toward the two-source minimum, token-reduction budget, or consumed source set.
- Duplicate IDs are harmless and reported.
- Invalid IDs are reported individually and do not prevent valid IDs in the same list from being marked.
- A source already consumed by an accepted summary cannot subsequently be marked keep-verbatim. The tool reports the conflict. The agent must first delete that current-run summary or use `fix_summary` to atomically delete it and create a corrected summary that no longer consumes the source.

Example result:

```text
memory abcd1234abcd marked as keep verbatim
memory 111122223333 was already marked as keep verbatim
ERROR memory edf78900abcd was not found; double-check the copied id
```

### Citation syntax

A candidate summary cites memory IDs inline using square brackets. A citation group may separate IDs with commas, whitespace, or commas plus whitespace:

```text
[memory_id]
[memory_id memory_id memory_id]
[memory_id,memory_id,memory_id]
[memory_id, memory_id, memory_id]
```

Canonical IDs are exactly 12 lowercase hexadecimal characters: `[0-9a-f]{12}`.

Citation parsing is deliberately strict:

- Square brackets in summary prose are reserved exclusively for citations.
- Bracket content must contain only canonical IDs separated by one or more valid separators: whitespace, a comma, or a comma with surrounding whitespace. Separators may be mixed within one group.
- Empty brackets, nested brackets, unmatched brackets, non-ID bracket content, leading/trailing separators, repeated commas with an empty element, extra punctuation, and mixed prose are invalid.
- Every cited ID must exist in the branch or have been created earlier in this summarizer run.
- A known memory ID appearing outside a valid citation is rejected as an incorrectly cited ID.
- A bare 12-character lowercase hexadecimal token outside brackets is also rejected as a likely incorrectly cited or mistyped memory ID.
- Citation IDs are deduplicated in first-occurrence order for accounting, although the same citation may appear more than once in prose.

The tool should return the exact malformed span or ID where possible. It must never silently remove or repair citations.

### Candidate validation

Each candidate summary is validated independently. **Any invalid, unknown, or incorrectly placed memory ID rejects that entire candidate summary.** The tool never accepts a partial citation set. One rejected candidate does not prevent other candidates in the same `summaries` array from succeeding.

A candidate succeeds only when all of the following hold:

1. It is non-empty after trimming and satisfies the summary content limits.
2. Every bracket is a valid citation group.
3. Every cited memory exists and was available to the summarizer through initial input, `recall`, `search_memories`, or an earlier successful current-run summary.
4. It has no incorrectly floating memory ID.
5. It cites at least two **newly consumable** memories.
6. Its estimated token count is no more than the configured maximum ratio of the combined stored token counts of those newly consumable memories.
7. It does not create a graph cycle.
8. Its content does not duplicate an existing memory ID/content hash.

A newly consumable cited memory is one that:

- is currently visible;
- is not marked keep-verbatim in this run;
- has not already been consumed by an earlier accepted summary in this run;
- was not itself created during the current summarizer run; and
- is not the candidate summary itself.

Other valid citations remain useful provenance but contribute zero toward the two-memory requirement and zero toward the savings test.

The initial reduction check is:

```ts
const SUMMARY_MAX_SOURCE_TOKEN_RATIO = 0.9;

estimateTokens(candidateSummary) <=
  floor(sum(tokenCount for each newlyConsumableSource) * SUMMARY_MAX_SOURCE_TOKEN_RATIO)
```

The `0.9` ratio is a source-code constant so it can be tuned after observing real runs. It initially requires at least an estimated 10% reduction rather than accepting a summary that is only one token shorter. Use the memory system's existing token estimator/accounting for both sides. Exact API usage tokens are not available for arbitrary stored strings; characters may be included in diagnostics, but the acceptance calculation should use the same estimate used for memory context accounting.

### Warnings

Warnings do not reject an otherwise valid candidate. Examples:

- a cited memory is protected by `keep_verbatim`;
- a cited memory was already consumed by another summary;
- a cited memory was already summarized away in an earlier run;
- the candidate barely passes the reduction check;
- the candidate cites a current-run summary, which is treated as keep-verbatim and contributes no source count or token savings.

Example results:

```text
summary created successfully [aaaa7777bbbb]: "As established by [dddd6789aaaa, ffff8888bbbb], ..."
WARNING memory dddd6789aaaa was marked keep verbatim and was cited only as supporting context
WARNING memory eee8888cccc was already consumed by another summary and contributed no additional savings
ERROR invalid memory ids [bbbb5555aaaa, cccc3333dddd] were not found; summary rejected; try again: "first 100 characters..."
ERROR summary cites only 1 newly consumable memory; at least 2 are required; summary rejected; try again: "first 100 characters..."
ERROR memory id aaaa1111bbbb is outside citation brackets; use [aaaa1111bbbb]; summary rejected; try again: "first 100 characters..."
ERROR summary is ~310 tokens but exceeds the 0.9 reduction limit for ~340 newly consumable source tokens; summary rejected; try again: "first 100 characters..."
```

Successful receipts echo the complete submitted summary, its new ID, all cited IDs, the consumed subset, protected/reused citations, estimated source tokens, summary tokens, and estimated reduction. Error previews should be bounded, for example to the first 100 characters.

## `fix_summary`

```ts
fix_summary({
  summary_id: string,
  updated_summary?: string,
  delete?: boolean // defaults to false
})
```

`fix_summary` operates only on summaries created during the current summarizer run. It cannot rewrite observations, prior-run summaries, review memories, or already committed history.

Exactly one operation must be requested:

- provide non-empty `updated_summary`; or
- set `delete: true`.

Supplying both is rejected. Supplying neither is rejected.

### Atomically deleting and recreating a summary

There is no in-place replacement because IDs are content-derived. An update is conceptually an atomic delete of the current-run draft followed by creation of an entirely new summary:

1. Temporarily remove the old draft and release every memory in its `consumedMemoryIds`.
2. Validate `updated_summary` from scratch using exactly the same citation, source-count, current-run-summary, cycle, and token-reduction rules as `summarize`.
3. Recompute both the complete cited source set and newly consumed source set. Memories omitted from the updated citations remain released; newly cited eligible memories may become consumed.
4. If validation fails, restore the old draft and all of its accounting unchanged.
5. If validation succeeds, retain only the new summary under its content-derived ID and apply its newly computed accounting.

The old summary and its old content never appear in the final durable commit.

Example:

```text
summary aaaa7777bbbb deleted; new summary created [bbbb8888cccc]: "full updated summary"
```

Because IDs are content-derived, changed content creates a new summary ID. An unchanged content hash is treated as a no-op rather than an in-place edit.

### Deleting a current-run summary

`delete: true` looks up `summary_id` in the summaries created during the current run. If found, it removes that draft summary and releases the memories it had consumed. Those memories return to the run's unclaimed visible set unless another accepted summary consumes them.

The tool always returns an explicit result:

```text
summary aaaa7777bbbb deleted successfully; 3 consumed memories were released
ERROR summary aaaa7777bbbb was not found among summaries created in this run; nothing was deleted
```

This is draft correction, not durable memory deletion. Repeating deletion of the same ID returns the not-found error rather than reporting success again.

### Dependents

A current-run summary cannot be fixed or removed while another current-run summary cites it. The tool returns the dependent summary IDs and asks the agent to fix or delete those dependents first. This avoids cascading rewrites and dangling citations.

Example errors:

```text
ERROR summary aaaa7777bbbb was not created in this summarizer run and cannot be changed
ERROR summary aaaa7777bbbb is cited by current-run summary cccc9999dddd; fix or delete the dependent summary first
ERROR invalid memory ids [bbbb5555aaaa, cccc3333dddd] were not found; existing summary was not changed
ERROR updated summary exceeds the configured 0.9 source-token ratio; existing summary was not changed
```

## `done`

```ts
done({})
```

`done` uses two-step confirmation, as the librarian currently does.

### First call

The first consecutive call does not terminate. It returns a deterministic report containing at least:

- number of successful current-run summaries;
- number of summaries later fixed or removed;
- total unique cited memories;
- total newly consumed memories;
- number explicitly marked keep-verbatim;
- number inspected but neither consumed nor explicitly kept, if known;
- source token total counted toward compression;
- final summary token total;
- estimated net visible-token reduction;
- projected visible memory count and tokens after commit;
- warnings about unresolved draft dependencies or unusually high remaining pressure.

It then asks the agent to call `done` again if the report is correct, or use `summarize`/`fix_summary` first.

Any intervening mutating tool call resets confirmation.

### Second consecutive call

The second consecutive `done({})` commits the final draft state and terminates the run.

The tool takes no summary/reason field. Its successful terminal result is a short fixed message.

The prompt does not need to explain the double-call handshake in detail; the first receipt provides the instruction when needed.

## Commit and failure semantics

Accepted tool calls represent useful work even if the model later times out or fails to call `done`. Therefore `done` is a model-compliance and review checkpoint, not an all-or-nothing transaction boundary.

Required behavior:

1. Keep the editable draft in memory during the run so `fix_summary` is cheap and intermediate typo versions are not written to the durable ledger.
2. On normal double-`done`, append one summarizer commit containing only final summaries and their graph/accounting metadata.
3. If the model stops, reaches its turn/output limit, reaches its time limit, or otherwise exits without `done`, atomically append the same final valid draft during worker cleanup. Valid summaries are useful progress and are not discarded merely because the model failed to terminate correctly.
4. Do not append an empty commit when no summary was accepted or all current-run summaries were removed through `fix_summary`.
5. Apply summary creation and all resulting source-visibility changes in one append-only ledger commit so the projection can never observe a summary without its consumption edges or hidden sources without their summary.
6. A hard software/process crash before cleanup may lose the in-memory draft. The scheduler can restart the stateless summarizer; source memories remain visible because no partial ledger commit occurred.

A commit should contain final summary content only once:

```ts
type SummarizerCommit = {
  version: 1;
  summaries: SummaryMemory[];
  covers_up_to_id?: string;
  created_at: number;
  completed_with_done: boolean;
  metrics: {
    consumed_memory_count: number;
    source_tokens: number;
    summary_tokens: number;
    estimated_token_reduction: number;
  };
};
```

`completed_with_done` is operational diagnostics, not a partial/low-confidence marker. Accepted summaries have identical semantic status either way.

Do not persist the full summarizer model transcript into the branch ledger. Tool arguments and successful receipts echo complete summary bodies and would multiply storage. Keep the most recent launch transcript in memory for `/om:view summarizer`, and persist only the final commit plus compact run diagnostics. If durable debugging is later required, store bounded metadata and references rather than duplicate summary text.

## Search and recall

### Search

`search_memories` searches visible and summarized-away nodes. Results do not need active/inactive distinctions. They should indicate whether a result is:

- visible; or
- summarized away, with the summary ID that consumed it.

Results may also include bounded forward-pointer metadata identifying summaries that cite the memory.

### Recall

`recall(id)` returns the memory body once and graph navigation metadata:

- for a summary: `source_memory_ids` and `consumed_memory_ids`;
- for every memory kind: `cited_by_summary_ids`, containing forward pointers to **all** summaries that cite it;
- for a summarized-away memory: `consumed_by_summary_id`, identifying the summary responsible for removing it from automatic visibility.

The forward-pointer list includes both consuming and non-consuming citations. This lets an agent discover every summary interpretation of a memory rather than only the first summary that reduced context.

Recall should not recursively inline the entire graph, which could explode context. It returns one node plus immediate forward/backward links, allowing the agent to walk the graph deliberately through additional recall calls.

The main agent and contemplator should be reminded briefly that cited memories can be inspected with `recall`.

## Summarizer input

The run starts fresh. It receives:

1. a system prompt;
2. active memory records with IDs, kinds, relevance/retention hints where available, token estimates, and content;
3. pressure and sampling metadata;
4. the system instructions repeated after the potentially long memory block; and
5. a short final instruction to use tools rather than merely describe proposed summaries.

The summarizer does not receive summarized-away memory bodies by default. It can use `search_memories` and `recall` when a visible memory or summary provides a concrete reason to inspect older graph nodes. It should not roam through old history searching for opportunities to compress unrelated material.

### Context cap and sampling

When the full visible pool fits below the configured summarizer input threshold, provide it all. Above that threshold, select one token-bounded sample using recent/new-memory preference plus fairness so old visible memories are not permanently starved.

Set `summarizer_sampling_threshold_tokens` to an initial default of **50,000 tokens**.

Only memories included in the initial sample or subsequently returned by search/recall are eligible for tool actions. Sampling statistics may remain in-process and non-durable.

## Prompt priorities

The summarizer prompt should retain the strongest reflector/librarian guidance:

- These records may become the assistant's only information about compacted interactions.
- Anything omitted may be forgotten; anything distorted may be remembered incorrectly.
- Summarization is not harmless rewording. It can make transient claims look durable and can erase exact constraints.
- Preserve user assertions, corrections, decisions, rationale, unresolved state, identifiers, paths, commands, errors, and exact outcomes.
- User statements and prompts are especially strong keep-verbatim candidates because exact wording may constrain future work.
- Recent tool calls, tool output, and current working state should usually remain verbatim while the work is active. Older execution detail becomes a better summary candidate after later memories establish its durable result.
- Do not summarize merely because memories share a topic or vocabulary.
- Do not turn partial work, speculation, failed attempts, or raw output into a confident durable conclusion.
- A summary must faithfully preserve all future-useful meaning of the sources it consumes.
- If a detail remains useful but does not fit faithfully, either include it or mark that source keep-verbatim.
- Prefer no summary over a lossy, distorted, redundant, or barely useful summary.
- The agent will have future opportunities with later evidence and different samples.
- Context pressure is advisory, not permission to distort memory.
- Use tool calls to register decisions; prose does not change memory.

The prompt should explain that citations serve two roles: provenance for future recall and exact source accounting for safe context reduction.

## Model-loop behavior

The first model round may run normally so the summarizer can reason over the memory set.

If it stops without calling a mutating tool or `done`, inject only a short, prominent reminder such as:

```text
IMPORTANT!!!! CALL summarize NOW TO RECORD ANY SUMMARIES YOU HAVE DECIDED, OR CALL done IF NO SAFE SUMMARY IS WARRANTED. DO NOT DESCRIBE THE ACTION IN PROSE—USE A TOOL NOW.
```

Subsequent retries may request provider-level required tool choice, while retaining the existing provider-specific payload handling and generous output budget. If a provider ignores required tool choice, bounded retries still end safely: unchanged source memories remain visible, and accepted summaries are preserved during cleanup.

## Scheduling

Replace librarian scheduling/settings with summarizer equivalents. The scheduler remains background and must not block the main agent.

Triggers should use cumulative agent-active time and newly recorded memory tokens, not idle wall-clock time:

- configurable minimum active-time interval;
- configurable maximum active-time delay once dirty;
- configurable urgent new-memory token threshold that may bypass the minimum interval;
- configurable input/sampling token threshold;
- configurable target visible-memory token level for advisory reporting only; and
- role-specific model, reasoning, and output settings.

The worker may run while the primary agent continues tool/model rounds. It snapshots its coverage boundary at launch so memories appended concurrently are considered in a later run.

## Observer changes

The observer remains simple. It continues recording observations and should not be asked to construct summary graphs.

The observer's retention hint may remain useful for summarizer sampling and judgment, but no retention value directly causes hiding or removal. Missing retention must continue to default safely rather than reject an observation batch.

No additional provenance, timestamp, task-state, or lifecycle fields should be added to the observer tool.

## Clean replacement; no librarian compatibility layer

The librarian implementation has not been published outside this development branch, so this migration may intentionally break librarian-era session compatibility.

Implementation should:

- rename reflections to summaries throughout the current code and ledger model;
- remove active/inactive/deleted lifecycle state and `recallIf` handling;
- remove librarian commit parsing, projection, settings, UI labels, notifications, tests, and `/om:view librarian`;
- delete the librarian agent directory after the summarizer replacement is complete;
- add summarizer commit, settings, notification, status, and `/om:view summarizer` support; and
- update compaction archives, search, recall, and projections to use only the new observation/summary graph semantics.

There is no requirement to restore sessions containing unpublished librarian commit entries. Tests and fixtures should be migrated to the new format rather than preserving dead compatibility code.

## Validation and testing plan

### Unit tests

Cover at least:

- strict single and grouped citation parsing;
- brackets containing prose, malformed separators, uppercase IDs, wrong-length IDs, nesting, and unmatched brackets;
- known and hash-like IDs floating outside brackets;
- invalid IDs rejecting only their candidate summary;
- at least two newly consumable sources;
- keep-verbatim, already-consumed, and current-run-summary citations contributing zero;
- enforcement of the configurable 0.9 maximum source-token ratio;
- multiple candidates processed in deterministic order;
- duplicate citations and duplicate source use;
- cycle rejection and the defensive content-hash self-reference edge case;
- atomic delete/create rollback on `fix_summary` validation failure;
- new summary IDs plus released and newly consumed source accounting;
- deletion of current-run drafts and source release;
- dependent current-run summary protection;
- double-`done` confirmation and reset after mutation;
- timeout cleanup preserving accepted summaries;
- fold/projection/search/recall graph behavior;
- compaction archive compatibility; and
- complete removal of librarian lifecycle paths.

### RPC E2E tests

Run the real Pi harness against the mock provider server and verify:

1. observer creates several memories;
2. background summarizer receives them while the main agent continues working;
3. summarizer creates a valid cited summary;
4. malformed summary is rejected with a useful receipt and then corrected;
5. `fix_summary` atomically removes a current-run summary, creates a new ID, releases removed sources, and consumes newly added eligible sources;
6. double-`done` commits once;
7. source memories disappear from automatic projection but remain searchable/recallable;
8. recall walks summary → source and source → summary links;
9. a later summarizer run summarizes prior summaries into a higher-order summary;
10. accepted work survives a no-`done` timeout;
11. provider requests expose required tool choice after a stop/retry;
12. no summary or source body is needlessly duplicated in durable transcript entries; and
13. concurrent compaction, observer output, and summarizer completion do not lose graph edges or newly appended memories.

## Proposed implementation sequence

1. Finalize schemas, citation grammar, accounting, and commit semantics in this document.
2. Replace reflection and librarian lifecycle ledger types with summary graph types and fold/projection support.
3. Implement and unit-test the strict citation parser/accounting engine independently of the model loop.
4. Implement the summarizer agent and tools.
5. Add scheduling, settings, notification, status, and view support.
6. Update search/recall and compaction archives.
7. Add full RPC E2E scenarios.
8. Delete librarian runtime paths, agent files, settings, lifecycle schemas, and obsolete tests.
9. Run long-session, restart, and compaction tests against the new summary ledger format.

## Confirmed design decisions

1. A summary may cite a summary created earlier in the current run, but a current-run summary is automatically non-consumable until a future run.
2. Valid summaries are committed when the model stops or reaches a limit without `done`; useful partial progress is retained.
3. `keep_verbatim` is run-local only. A future summarizer may reconsider an older memory.
4. No librarian-era active/inactive/deleted compatibility layer is required, and the librarian agent directory will be deleted after replacement.
5. Compression uses the memory system's existing token estimate with a source-code ratio initially set to `0.9`.
6. The last summarizer transcript remains in memory for `/om:view summarizer`; the session ledger stores only final new summaries, source-visibility graph changes, and bounded run metrics.
