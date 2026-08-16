# Librarian agent proposal

## Purpose

Replace the reflector and dropper with one short-lived, mostly stateless **librarian** agent.

The librarian manages the active memory collection as a whole. It:

- combines observations and reflections into better reflections;
- records explicit provenance between source and replacement memories;
- identifies memories made obsolete by later observations;
- moves still-valid but currently irrelevant memories out of the visible set;
- restores inactive memories when later observations make them relevant again; and
- prefers doing nothing over making a speculative merge or forgetting uncertain information.

The durable branch ledger remains append-only. “Delete” means logically retired from active/visible memory, not physically erased from the JSONL file. Deleted and inactive memories remain searchable and recallable. Deleted results expose their status and deletion reason to every caller. Inactive results behave like ordinary non-deleted memories to the main agent and contemplator; only the librarian sees their inactive grouping and `recallIf` metadata.

## Core invariants

### Fresh and stateless

Each librarian run starts with a fresh model context. Its durable state is only the memory ledger and the actions committed during prior runs. It does not persist a private conversational transcript like the contemplator.

When eligible memory material fits within half of the librarian context window, a normal run receives **all** active observations/reflections and all compact inactive cues. Sampling is not part of the healthy/common path. Deleted memories are never included routinely; they remain deliberately searchable and recallable.

Only when the complete rendered memory material would exceed **50% of the librarian model's context window** does the pressure-valve sampler activate. The resulting initial memory material is capped at 50%, leaving the remainder for the system prompt, tool definitions, model output, search/recall results, staging receipts, and continuation turns. Pool targets are advisory signals for LLM judgment, not deterministic deletion limits.

The run may make multiple read and staging tool calls, then ends with an explicit `done` call. If the process is interrupted before `done`, no staged mutations are committed.

### Subset-safe

The librarian must remain correct when called with only a subset of active memories. Full active-memory context should improve its opportunities, not be required for correctness.

The prompt must state:

- The supplied active memories may be incomplete; inactive cues and deleted history are separate.
- Absence from the supplied set is not evidence that a memory does not exist.
- Only act on supplied memories or memories explicitly found and inspected through search/recall.
- Do not search speculatively for work to manufacture. Search only when a supplied memory or inactive cue gives concrete reason to inspect specific omitted history.
- Do not claim global uniqueness, contradiction, or redundancy when known omitted history could matter.
- It is valid to make only local improvements to the supplied subset.

This invariant supports bounded sampling without redesigning librarian semantics.

### Bounded randomized sampling

Let `T` be the conservative token estimate for all normally rendered active memories and inactive cues, and let `B` be 50% of the model context window.

- If `T <= B`, do not sample: render the complete eligible set.
- If `T > B`, choose one token-bounded random sample targeting `B` tokens. The sampling fraction is therefore approximately `B / T`, not a fixed percentage. For example, a pool requiring 80% of the context is sampled at approximately `50 / 80 = 5/8`; a pool requiring 60% is sampled at approximately `5/6`.
- Select by rendered token size rather than record count, so a few very large memories cannot overflow the cap.
- Perform one sampled pass. Do not page through the remainder or immediately rerun the librarian merely to obtain full coverage.

Because this is an emergency pressure valve rather than the normal curation mechanism, the initial algorithm should remain simple and robust: weighted random selection without replacement, strong preference for newly created and recent memories, a smaller boost for durable/high-relevance and very old still-active memories, and a nonzero floor for everything else. This keeps current evidence visible while ensuring old records are not permanently starved. The exact coefficients can be tuned later without changing ledger semantics.

The scheduler may keep an in-process map such as `lastSampledAt` and `sampleCount` to improve fairness and report diagnostics. This state is an escape-valve implementation detail: do not append it to the durable branch ledger, do not inject it as memory, and tolerate losing it on restart. The prompt needs only a notice that it received a sampled subset, the selected/eligible counts and token estimates, and a brief statement that selection favored recent evidence.

### Evidence-based lifecycle changes

A memory does not become obsolete merely because it is old or because the librarian emitted no reflection. Lifecycle changes require observations that explain the change.

Examples:

- An observation says an earlier implementation approach was abandoned.
- A later observation records a replacement preference or architecture decision.
- A completion observation shows that transient debugging details are no longer current working memory.
- A new observation returns to a previously inactive system or topic.

Standalone `delete_memories`, `make_inactive`, and `make_active` therefore require one or more `becauseOfObservationIds`.

`record_reflection` is the narrow exception: when its sources become inactive or deleted, the newly created reflection is itself the linked consolidation record and its `derivedFrom` graph proves exactly what was consumed. It does not require an additional evidence list merely to repeat those source IDs.

Evidence observations do not need magic status syntax. The librarian judges their meaning. Code verifies that supplied IDs exist on the current branch, were available to the librarian, are distinct from standalone lifecycle targets, and occur after the lifecycle state they change.

### Explicit reflection source disposition

`record_reflection` includes one explicit three-way disposition for all source memories: `keepActive`, `makeInactive`, or `delete`. This reduces repetitive calls while making the consequence part of the same semantic decision.

- `keepActive` preserves exact source detail in automatic context.
- `makeInactive` retains valid source detail for conditional recovery under one shared `recallIf` cue.
- `delete` is appropriate when the new reflection has consumed the useful meaning of low-value or temporal source details. The new reflection becomes their `replacedBy` target, while the source records remain durably searchable with the required stored deletion reason.

If source disposition should differ per source, create the reflection with `keepActive`, then use `make_inactive` or `delete_memories` on selected sources.

### Time, not explicit task records

The system does not maintain a separate database of tasks and task states. Tasks, completions, context switches, resumed work, and abandoned approaches are represented by ordinary timestamped observations.

The librarian reasons from:

- memory timestamps and age;
- later observations;
- supersession and merge links;
- active/inactive/deleted status; and
- retention class proposed by the observer.

Age is context for LLM judgment, not an automatic deletion rule.

## Proposed librarian input

Each run receives:

1. Pool statistics and the reason the librarian was invoked, including active memory count, active token total, and current target.
2. Active reflections in the supplied set, oldest to newest.
3. Active observations in the supplied set, oldest to newest.
4. For each active memory:
   - ID;
   - kind (`observation` or `reflection`);
   - content;
   - timestamp or creation time;
   - relevance and retention class where applicable;
   - direct source/backpointer ID lists;
   - direct forward lifecycle pointer lists; and
   - approximate token count.
5. An `INACTIVE MEMORY GROUPS` section formed at run start by grouping exact normalized `recallIf` text, for example `[inactive_1] (4 memories) Recall when work returns to OAuth logout`.
6. A clear notice when active memories were sampled, including selected/eligible counts and token estimates.

The librarian does not need the current local time. Memory timestamps and ordering provide the relevant temporal evidence without distracting the model with wall-clock arithmetic. If useful, host code may render a derived age beside a memory.

Deleted memories are omitted from routine librarian input. An intentional search can still recover one with its deleted status and stored reason.

## Draft librarian system prompt

The final prompt should be tested and iterated, but its structure should be approximately:

> You are the memory librarian for a coding assistant's long-running memory. These records are the agent's memory. Preserving something incorrect, losing a user constraint, or hiding unresolved state can make the agent contradict the user, repeat work, or confidently act on false history. Curate conservatively.
>
> You maintain a useful active collection without destroying the durable historical ledger. Observations are timestamped evidence. Reflections are higher-order memories derived from two or more memories. A reflection is not inherently more important or durable than an observation: it may later be combined, made inactive, or deleted like any other memory. Inactive memory groups are represented by short librarian-only `recallIf` cues. Deleted memories are omitted from routine context but remain deliberately searchable and recallable with their deletion reasons.
>
> Your responsibilities are:
>
> 1. Combine genuinely related memories when one reflection can preserve their useful meaning more clearly and compactly.
> 2. Identify memories made obsolete by later observations.
> 3. Move valid but currently irrelevant memories out of active visibility.
> 4. Reactivate inactive groups when later observations make them relevant again.
> 5. Preserve exact user constraints, corrections, decisions, rationale, unresolved state, identifiers, errors, and other unique details unless a replacement preserves them faithfully.
>
> You may receive the complete active memory collection or only a subset. Never assume an omitted memory does not exist. Act only on active memories you were shown or memories you explicitly found and inspected. Do not search merely to find more things to merge, hide, or delete. Search or recall only when evidence in a supplied memory or inactive cue gives a concrete reason to inspect specific omitted history. It is valid to make only local improvements.
>
> Prefer no action when a merge or lifecycle decision is uncertain. You will have future librarian runs with later evidence and different samples. If a reflection, inactivation, or deletion is uncertain, defer it for a future opportunity rather than forcing a decision now. Do not combine memories merely because they share words or topic. A good reflection is smaller and more useful than its sources while preserving the details a future agent needs. Do not create a reflection that only paraphrases one source.
>
> A memory's age is evidence, not a verdict. A newer observation may supersede an older state, but a durable old constraint may remain important. Lifecycle changes must cite observations that explain why the change is justified now.
>
> `delete_memories` removes low-value, obsolete, or consumed temporal detail from automatic memory after later evidence or a replacement has made it unnecessary. `make_inactive` preserves still-valid memory that may become useful when related work returns. Deleted history remains searchable with its reason, but there is no undelete operation; renewed circumstances should be represented by new evidence or an active replacement.
>
> `record_reflection` asks whether all sources should `keepActive`, `makeInactive`, or `delete`. Keep sources active when exact details remain automatically useful. Make them inactive when the reflection preserves the default working meaning but exact detail may matter under a future condition. Delete them only when their useful content has been consumed into the reflection and their remaining detail is low-value or temporal, and provide a specific `deleteReason`. If disposition should differ per source, keep all active in `record_reflection` and use lifecycle tools selectively.
>
> You may issue independent staging, search, and recall calls together. Do not call `done` in the same response as another tool: wait for those results, then call `done` in a later response. Work through the supplied set with as many calls as needed, but do not manufacture work. If no safe improvement is available, call `done` immediately with no staged changes. When finished, call `done`; do not end with ordinary assistant text.

### Prompt decision guidance

The prompt should incorporate the best parts of both current agents.

From the reflector prompt:

- Avoid lightly rewording an existing memory.
- Combine evidence into useful higher-order memories without treating reflections as intrinsically durable or scarce.
- Preserve user language, identifiers, decisions, rationale, and concrete outcomes.
- Do not inflate source coverage.

From the dropper prompt:

- Distinguish redundancy, supersession, obsolescence, and temporary inactivity.
- Age alone is insufficient.
- Keep unique details and unresolved state.
- Compare replacement fidelity before retiring a source.
- When uncertain, keep the memory and defer the decision; later librarian runs will bring later evidence and different samples.

New librarian-specific guidance:

- Distinguish **obsolete** from **currently inactive**.
- Do not search omitted history speculatively; inspect it only when presented evidence points to something relevant.
- Forward and backward links are part of memory quality.
- Prefer a coherent reflection with an explicit source-visibility choice over isolated deletion.
- Reflections have no special durability and remain subject to ordinary lifecycle judgment.
- Do not continue making tool calls merely because the tool budget remains.

## Tool design

The proposed tool names are:

- `record_reflection`
- `delete_memories`
- `make_inactive`
- `make_active`
- `search_memories`
- `recall`
- `done`

`delete_memories` is clearer for an LLM than `no_longer_relevant_delete` or `retire_memories`: it names the action directly and its description can make the durable-ledger semantics explicit. `make_inactive` is clearer than `not_active` and pairs naturally with `make_active`.

Naming convention: Pi tool names use `snake_case`, matching existing tools such as `search_memories`. All JSON argument/property names and multiword enum values use `lowerCamelCase`, matching the existing `sourceEntryIds` observer schema. Do not mix conventions within tool arguments.

All mutating tools stage actions in the current run. `done` validates and atomically commits the staged plan. Read-only search and recall execute immediately.

### Common validation and batching

Lifecycle tools accept arrays to reduce tool-call overhead. A bad target ID does not prevent valid targets in the same call from being staged: the result lists accepted targets and rejected targets with reasons. Shared dependencies are different. If a shared `becauseOfObservationIds` or `replacementMemoryIds` list is structurally invalid, reject the whole call because every target depends on it.

`record_reflection` is atomic rather than partially successful. Every source and conditional lifecycle dependency must be valid before any part of the reflection or source disposition is staged.

Code validates structure and ledger facts—ID existence, kind, visibility state, evidence ordering, and conflicting transitions. It does not attempt to judge whether evidence is semantically strong; that remains the librarian's responsibility.

### `record_reflection`

Combines two or more observations/reflections into one new higher-order memory.

```ts
record_reflection({
  content: string,
  sourceMemoryIds: string[], // minimum 2
  sourceDisposition: "keepActive" | "makeInactive" | "delete",
  sourceRecallIf?: string,
  deleteReason?: string,
  rationale: string
})
```

Rules:

- Every source must exist and must have been supplied or recalled in this run.
- At least two distinct source IDs are required. This prevents one-source paraphrases from multiplying the pool.
- Sources may be observations, reflections, or a mixture.
- Validation is all-or-nothing; one invalid source rejects the entire call.
- The reflection stores a `derivedFrom: string[]` backpointer list containing every source.
- Each source gains the reflection ID in its `mergedInto: string[]` forward-pointer list after commit.
- Content is immutable and receives a deterministic memory ID.
- With `keepActive`, source visibility is unchanged; `sourceRecallIf` and `deleteReason` are omitted.
- With `makeInactive`, every source receives the same `recallIf`, `sourceRecallIf` is required, and `deleteReason` is omitted. The new reflection is the linked consolidation reason for the visibility change.
- With `delete`, all sources are logically deleted, the new reflection is stored in each source's `replacedBy` list, and a non-empty `deleteReason` is required and persisted with every source's deletion event. `rationale` explains the reflection itself and must not be reused implicitly as the delete reason. The new reflection is the linked replacement; no future undelete operation is provided.
- Supplying disposition-specific fields for the wrong disposition is rejected rather than silently ignored.
- Any invalid source rejects the whole call. No separate `becauseOfObservationIds` is needed for source disposition because the atomic reflection and its provenance links are the evidence.
- Duplicate content returns the existing reflection ID and allows the librarian to link new sources if appropriate, but the same disposition validation still applies.

A reflection is not intrinsically more durable than an observation. It can later serve as another reflection's source, become inactive, or be deleted. The resulting provenance graph is a DAG, and recall traversal remains bounded.

### `delete_memories`

Logically deletes low-value, obsolete, or already-consumed temporal memories from automatic visibility while preserving the durable ledger.

```ts
delete_memories({
  memoryIds: string[],
  becauseOfObservationIds: string[], // minimum 1
  replacementMemoryIds?: string[],
  reason: string
})
```

Semantics:

- Valid target IDs are deleted even if other target IDs in `memoryIds` are invalid; the result reports both sets.
- The shared evidence and replacement lists must be entirely valid or the call stages nothing.
- `becauseOfObservationIds` identifies later/current evidence explaining why the targets are obsolete now. Evidence must be distinct from each accepted target and must not predate its latest activation/creation state.
- `replacementMemoryIds` points to memories preserving any remaining useful meaning.
- Deletion without a replacement is allowed for low-value temporal detail whose useful effect is already captured by the cited evidence. Prefer an explicit replacement when another memory preserves the meaning.
- The `reason`, evidence IDs, replacement IDs, and target IDs are persisted in the append-only lifecycle event.
- Search and recall return deleted status and the deletion reason to every caller, including the main agent and contemplator.
- There is no undelete operation. The active/inactive distinction handles potentially reusable memory; deletion is final for automatic visibility. If later circumstances need deleted history, the observer records new evidence and the librarian may create a new active memory linked to it.

The tool description must explicitly say that this is logical deletion, never physical erasure.

### `make_inactive`

Moves one or more still-valid memories out of automatic visibility under one shared `recallIf` cue.

```ts
make_inactive({
  memoryIds: string[],
  becauseOfObservationIds: string[], // minimum 1
  recallIf: string
})
```

Semantics:

- Every accepted target stores the same short `recallIf` text in its inactivity lifecycle state.
- Valid targets are staged even if other target IDs are invalid; the result reports accepted and rejected IDs.
- The evidence list must be entirely valid or the call stages nothing.
- There is no separate rationale. `recallIf` explains when to recover the memories, while the cited observations record why automatic visibility ceased to be useful.
- No durable group object or group ID is created. Grouping is reconstructed from equal normalized `recallIf` text for each fresh librarian run.
- The memories leave the active/visible projection but remain searchable and recallable.
- Routine librarian input shows only a run-local alias such as `[inactive_1] (N memories) recallIf`; it does not repeat member IDs or bodies.
- The main agent, observer, and contemplator never see `recallIf` automatically.
- Inactivity does not imply falsity, supersession, or low durable value.

This is appropriate for detailed knowledge about a subsystem that the agent has left but may revisit. Cues should describe a discriminating future condition rather than summarize all member content.

### `make_active`

Returns one or more inactive groups to the active/visible pool.

```ts
make_active({
  inactiveRefs: string[], // run-local aliases or inactive memory IDs
  becauseOfObservationIds: string[] // minimum 1
})
```

Rules:

- A reference may be a run-local alias from the current prompt/search results or the ID of an inactive memory.
- Each accepted reference resolves to the current cohort sharing that exact normalized `recallIf`. Invalid aliases, active IDs, and deleted IDs are rejected individually while valid references proceed.
- The evidence list must be entirely valid or the call stages nothing.
- Reactivation applies to every member of each resolved cohort and appends per-memory lifecycle events; it does not erase prior inactivity.
- The tool result returns every reactivated member's ID, kind, timestamp, and full memory body. This gives the librarian the content that was intentionally omitted from its initial context.
- The librarian may call `make_active` directly when a cue and current evidence are sufficient. It may call `recall(inactive_1)` first when exact contents are needed.

### Run-local inactive aliases and retrieval

Inactive grouping is a projection convenience, not a durable ledger entity. At the start of each librarian run, group current inactive memories by exact normalized `recallIf` and assign aliases in rendered order:

```text
[inactive_1] (4 memories) Recall when work returns to OAuth logout
[inactive_2] (2 memories) Recall when changing the SQLite migration
```

The alias-to-member map lives only for that librarian run and may be rebuilt with different alias numbers after restart or the next invocation. Durable state consists only of each memory's inactive lifecycle event, `recallIf`, and evidence IDs.

Calling `recall(inactive_1)` returns every member's full description together. Calling `recall(memberId)` for a currently inactive member also expands its current same-cue cohort. A librarian search match can return or lazily allocate the run-local alias. Main-agent and contemplator search/recall never needs to expose that alias or the cue.

When a cohort is reactivated, all current memories with that cue become active together. The librarian can later make any subset inactive under a different cue.

### `search_memories`

Reuse the existing search tool for every agent:

```ts
search_memories({ query: string, limit?: number })
```

Search covers active, inactive, and deleted branch memories. Ordering need not privilege inactive over deleted records; normal relevance scoring is sufficient.

Results include kind, timestamp, retention/relevance metadata, short content, immediate pointers, and an ID for `recall`. Deleted results additionally expose deleted status and the stored deletion reason to all callers. For inactive results:

- the librarian sees inactive status, a run-local alias, and librarian-only `recallIf`;
- the main agent and contemplator see an ordinary non-deleted memory result, with no inactive status or `recallIf` distinction; and
- librarian recall expands the current same-cue cohort.

### `recall`

Reuse and extend the existing recall tool:

```ts
recall({ id: string })
```

For observations, recall shows source chat entries plus lifecycle pointers. For reflections, it shows direct source memories and direct forward pointers. For a librarian's run-local inactive alias or any current inactive member, it returns every member body in the same-cue cohort. Deleted memories include their stored reason for every caller.

The default graph response includes only one hop:

- `derived from` / backpointers;
- `merged into`, `superseded by`, or `replaced by` / forward pointers;
- lifecycle events and their evidence observations; and
- deleted status/reason, or inactive-group metadata when the caller is the librarian.

The caller can recall another returned ID to walk farther. This avoids exploding a long consolidation chain into one tool result.

### `done`

Explicitly completes the librarian run and commits its staged plan.

```ts
done({
  summary: string
})
```

Behavior:

- Validates staged IDs, local reflection references, lifecycle transitions, evidence ordering, and graph cycles.
- Rejects structurally invalid actions and allows the librarian to correct them.
- On a structurally valid plan, atomically appends all actions and terminates the agent loop immediately.
- With no staged actions, commits only a lightweight successful-pass checkpoint and terminates.
- `summary` is a short audit description, not a new memory and not injected into the main agent context.
- Its successful tool result is a small fixed response such as `Librarian pass completed.` It does not echo staged actions, because the model already saw their receipts.
- Preflight rejects `done` when its assistant message contains any sibling tool calls and tells the librarian to wait for those results, then call `done` alone. This turns the prompt rule into a structural commit safeguard.

An explicit terminal tool distinguishes deliberate completion from truncation, failure, or turn exhaustion. The prompt should strongly encourage early `done`: make no minimum number of changes, stop searching after responsible review, and treat tool/turn limits as ceilings rather than goals.

`done` must be called in a later assistant response than mutation calls, not alongside them. This ensures every parallel staging result is complete and visible before commit.

If the assistant stops without calling `done`, inject this compact reminder and continue the same run:

```text
You stopped without calling done, so this librarian run is not complete.

Continue reviewing only if useful work remains. Use record_reflection to combine memories; use delete_memories, make_inactive, or make_active only with observation evidence; and use search_memories/recall only when presented evidence points to omitted or inactive context. If no further action is clearly warranted, call done now. Otherwise finish the necessary tool calls and then call done. Do not manufacture changes merely to continue.
```

The reminder deliberately does not summarize staged actions: the agent already has the tool calls and results in context. It restates tool purpose because a large memory prompt may have pushed the original instructions far back.

Use bounded continuation retries. If the model repeatedly stops without `done` or reaches its hard token/turn limit, discard staged changes and record an incomplete-run diagnostic rather than committing a partial plan.

## Staging and atomic commit

A run-local plan solves several consistency problems:

- A replacement reflection and source retirements become visible together.
- A failed late tool call does not leave half a merge persisted.
- `done` can detect a source being both deleted and reactivated.
- The librarian can replace a rejected staged action after structural validation feedback.
- A process crash leaves the prior durable state unchanged.

Each staging tool returns:

- what was accepted;
- what was rejected and why;
- the current staged status for affected IDs; and
- structural validation errors such as invalid IDs, invalid current status, or contradictory staged transitions.

Batch input is an efficiency feature, not weaker provenance. Each committed lifecycle event retains all accepted target IDs, evidence IDs, and the tool-specific reason or cue.

### Parallel tool execution

Configure the librarian agent with `toolExecution: "parallel"`. Pi supports multiple tool calls in one assistant response; read-only calls and independent staging calls should not be serialized unnecessarily.

The run-local staging implementation must therefore be concurrency-safe. Each call should validate against an immutable snapshot plus the already-staged plan, then merge accepted operations through a mutex or deterministic transaction queue. Conflicts discovered while merging are returned as rejected operations rather than racing writes.

Mark `done` with `executionMode: "sequential"` and instruct the model never to issue it alongside other tools. Pi executes an entire mixed batch sequentially if any called tool is sequential, but source order alone cannot guarantee that `done` appears after every intended mutation. Requiring `done` in a later model response is the reliable commit barrier. Search, recall, and mutation calls may otherwise be issued together when independent.

## Memory lifecycle model

A memory has one current visibility status per branch:

- `active`: automatically included in the active memory projection;
- `inactive`: valid archived memory, excluded from automatic visibility but expected to be reactivatable; or
- `deleted`: obsolete, low-value, or consumed temporal memory, excluded from automatic visibility and never undeleted.

Lifecycle is branch-local and append-only. Forks inherit the parent's state up to the fork and then diverge.

Relationships are separate from status and are represented as ID lists, never scalar fields:

- `derivedFrom: string[]`: reflection to all direct source memories;
- `mergedInto: string[]`: source memory to one or more combined reflections;
- `supersededBy: string[]`: old state to one or more newer states;
- `replacedBy: string[]`: deleted memory to all preserved replacements; and
- `statusBecauseOf: string[]`: lifecycle event to all evidence observations.

Lists are deduplicated and may contain multiple IDs. This supports a reflection derived from many memories and a source that participates in more than one later consolidation without rewriting old ledger events.

A memory can be inactive without any replacement, or active while already represented by a reflection if its exact working detail remains useful.

Inactive grouping is a transient projection, not provenance or durable lifecycle identity. Each inactive memory independently retains its `recallIf` and evidence-ID list. A fresh librarian run groups equal normalized cues and assigns temporary aliases; reactivation appends events to the resolved members without rewriting their historical inactivity events.

## Observer changes

The observer remains a short-lived recorder of new transcript evidence. It should not merge old memories or perform lifecycle changes; that belongs to the librarian.

### Add retention horizon

Extend each observation with an LLM-proposed retention horizon orthogonal to relevance:

```ts
type Retention = "ephemeral" | "contextual" | "durable";

type Observation = {
  // all existing fields remain unchanged
  retention: Retention;
};
```

Meanings:

- `ephemeral`: likely useful for only the next few steps; intermediate attempts, routine outputs, temporary readings, and local status.
- `contextual`: useful while related work continues or may soon resume; exact errors, hypotheses, partial state, subsystem details, and unresolved local choices.
- `durable`: likely useful across context changes; persistent preferences, constraints, corrections, decisions, rationale, reusable findings, and significant outcomes.

The observer proposes this single added field based on the source chunk. Code validates only the enum and does not infer the class from keywords. The librarian may later reinterpret the horizon using newer observations.

Relevance and retention answer different questions:

- Relevance: how damaging would it be to overlook this now?
- Retention: how long is this likely to remain automatically useful?

Examples:

- An exact blocking error can be `critical + contextual`.
- A stable writing preference can be `medium + durable`.
- A routine command result can be `low + ephemeral`.
- A completion with reusable architectural consequences can be `high + durable`.

### Record lifecycle evidence explicitly

Update the observer prompt to notice evidence the librarian can later cite:

- a prior fact or preference was replaced;
- an approach was abandoned;
- an issue was resolved;
- detailed work on one system stopped and attention moved elsewhere;
- previously paused subject matter became relevant again; or
- an old result was invalidated.

These remain ordinary observations with timestamps and source entry IDs. Do not add task-state tables or special task objects.

The observer should describe the factual transition, not issue librarian commands.

- Good: `User moved from the authentication subsystem to billing after completing token refresh support.`
- Bad: `Make authentication memories inactive.`
- Good: `User resumed authentication work to investigate logout failures.`
- Bad: `Reactivate auth memories.`
- Good: `The Redis approach was abandoned after benchmark results showed higher p95 latency than the database-backed design.`
- Bad: `Delete Redis memories.`

### Proposed `record_observations` schema change

```ts
record_observations({
  observations: [{
    timestamp: string,
    content: string,
    relevance: "low" | "medium" | "high" | "critical",
    retention: "ephemeral" | "contextual" | "durable",
    sourceEntryIds: string[]
  }]
})
```

`retention` is the **only** new observer tool argument. Existing `timestamp`, `content`, `relevance`, and `sourceEntryIds` fields remain exactly as they are today; do not add rationales, task IDs, reconsideration rules, confidence, or other metadata. Keeping observation recording easy is more important than extracting every possible curation hint up front.

Tool receipts report an invalid retention enum like any other schema error. No code path automatically deletes an observation because it was labeled `ephemeral`.

### Observer prompt changes

Replace references to “the dropper will drop these first” with “the librarian will use relevance, retention, age, and later observations when curating active memory.”

Add a short retention section without expanding the rest of the decision procedure:

- Recording the observation correctly comes first; never skip a useful observation because retention is uncertain.
- Classify expected lifetime separately from current importance.
- When uncertain, use `contextual` and let the librarian revise it later.
- Preserve transitions that can justify future relevance changes.
- Do not manufacture context-switch observations when the transcript does not contain one.
- Do not decide that an existing memory should be hidden or deleted.
- Continue avoiding duplicates already represented by current active memories.
- If a relevant prior memory may be inactive/deleted and therefore absent, record the new transcript fact normally; the librarian can search and reconnect it later.

## Invocation and scheduling

Observer completion marks librarian work as **dirty**, but does not launch a librarian run immediately. Observer runs may occur frequently and several should normally coalesce into one delayed librarian pass. Each actual librarian run still starts fresh.

### Configurable cadence

Expose scheduling controls in `/om:settings`. Suggested initial settings are:

```ts
librarianEnabled: boolean;                // default true
librarianMinIntervalMinutes: number;      // default 30
librarianMaxDelayMinutes: number;         // default 180
librarianMinNewMemoryTokens: number;      // default 5_000
librarianPressureTriggerRatio: number;    // default 1.0 × active-token target
```

The exact defaults should be tuned with E2E and long-session data. Scheduling behavior:

1. When observer coverage advances, accumulate newly recorded memory count/tokens and remember the first dirty time.
2. Never start more than one librarian run at once, and do not start merely because one observer run ended.
3. Respect `librarianMinIntervalMinutes` between starts.
4. Once the minimum interval has elapsed, run when any of these is true:
   - accumulated new-memory tokens reach `librarianMinNewMemoryTokens`;
   - active memory tokens exceed `targetTokens * librarianPressureTriggerRatio`; or
   - dirty time reaches `librarianMaxDelayMinutes`.
5. Coalesce further observer updates while a run is pending or active. If new observations arrive during the run, leave the scheduler dirty for a later eligible pass rather than launching recursively.
6. A successful `done` advances librarian coverage through the snapshot it reviewed. Failure leaves that snapshot eligible for retry after backoff.

A pressure trigger may schedule a run sooner after the minimum interval, but it does not bypass single-flight behavior or cause a run after every observer invocation. Scheduling counters may live in runtime state; only existing semantic checkpoints and committed memory changes belong in the durable ledger.

### Invocation input and pressure guidance

Every invocation uses the same bounded input policy:

- If complete rendered memory material is at or below 50% of the context window, supply it all with no sampling.
- Only above 50%, perform one token-aware weighted sample at fraction `50% / estimatedUsage`; do not page or immediately rerun for coverage.
- Favor new/recent evidence, modestly favor durable/high-relevance and long-lived active memories, and retain a nonzero probability for everything else.
- Group inactive cues dynamically and assign run-local `inactive_N` aliases. Inactive cues count toward the same 50% threshold and budget.
- Include all new observations since the last successful checkpoint when they fit; if they alone exceed the cap, retain the cap and strongly favor the newest.
- Let deliberate search/recall bridge omitted history.
- Run once even when no action may be needed, and require `done` to advance the checkpoint.

Always tell the librarian:

- active memory count and tokens;
- librarian model context-window size and active-memory percentage;
- configured active-token target and tokens above/below it;
- whether sampling occurred, plus selected/eligible counts and token estimates; and
- recent newly recorded memory count/tokens that caused the run.

When active tokens exceed the configured target, append an advisory pressure message. Derive a rough reduction count from excess tokens divided by the median active-memory size; do not hard-code a desired memory count. For example:

```text
MEMORY PRESSURE ADVISORY
Active memories use 109,000 tokens (54.5% of this model's context); target: 20,000.
Reducing automatic memory by roughly 89,000 tokens would return to target. At the current
median memory size, that is approximately 180 memories. Consider combining related memories,
making currently irrelevant memories inactive, and deleting only obsolete or consumed temporal
detail. This is guidance, not a quota: preserve uncertain or uniquely useful memories and defer
unsafe decisions to a future librarian run.
```

Use a stronger heading when sampling was required, but keep the same semantic safeguards. The numerical estimate is intended to help the LLM understand scale, not authorize code to hide a fixed number of memories or force the librarian to meet the target in one pass.

Sampling/fairness history may be held in process memory but is never appended to the session ledger. A restart may produce a different sample safely.

There is no separate dropper invocation. The librarian's committed plan may create reflections, archive memories, delete obsolete memories, reactivate old context, or make no changes.

## Status, search, and recall presentation

Status should report:

- active/inactive/deleted observations;
- active/inactive/deleted reflections;
- dynamically grouped inactive cue count and total inactive memories;
- observation counts by retention horizon;
- active memory token use and target;
- age of the oldest active ephemeral/contextual memory;
- last successful librarian pass and whether it saw the complete eligible set or a sample;
- current cadence settings, dirty/new-token accumulation, and next eligible or maximum-delay time;
- optional current-process sampling diagnostics (`selected/eligible`, sampled tokens, and fairness counters), explicitly marked non-durable;
- pending librarian backlog; and
- last incomplete/error diagnostic.

Librarian-facing search examples:

```text
- inactive memories [inactive_1] (4 memories)
  recallIf: Recall when work returns to OAuth logout or token revocation

- reflection [ref789...] [active] ...
  derived from 4 memories

- observation [old123...] [deleted] ...
  deleted because: Redis approach was invalidated by later p95 results
  evidence [new456...]; replaced by [ref789...]
```

The main agent and contemplator see inactive search hits as ordinary non-deleted memories, without `recallIf`; deleted hits remain explicitly marked and include their reason. Recall exposes one-hop pointers in both directions. For the librarian, recalling a run-local alias or inactive member returns the current same-cue cohort.

## Remaining design questions

Most semantic choices belong to the librarian rather than deterministic policy, and this design intentionally adds no critic agent. The major semantics are settled: there is no undelete operation, inactive aliases are run-local, and initial memory material is capped at half the model context. Remaining questions are tuning concerns:

1. What simple initial weights should recency, durable/high relevance, old-active persistence, and `lastSampledAt` receive?
2. What cadence defaults work best in real long sessions without spending excessive librarian tokens?
3. How much deterministic seeding should tests and diagnostics use while production runs remain randomized?

## Testing requirements

- A librarian run can create a reflection and atomically apply each `sourceDisposition`: `keepActive`, `makeInactive`, or `delete`.
- A no-action run calls `done`, advances coverage, and writes no lifecycle mutation.
- A run that ends without `done` commits nothing and receives the bounded continuation reminder.
- `record_reflection` is all-or-nothing; it rejects missing, unseen, duplicate, and fewer-than-two source IDs, invalid dispositions, a missing inactive cue, a missing/empty delete reason, and disposition-specific fields supplied for the wrong disposition.
- Reflection-source deletion persists its explicit `deleteReason` separately from reflection `rationale`, links each source to the reflection, and returns that reason after restore through search/recall.
- Lifecycle tools reject shared evidence IDs that are missing or not observations.
- Batch lifecycle calls accept valid targets while reporting invalid targets, but commit nothing when a shared dependency is invalid.
- Deletion without replacement is accepted when IDs and transitions are structurally valid; its reason survives restore and is returned by main-agent, contemplator, and librarian search/recall.
- Inactive memories leave the active projection while every memory remains searchable/recallable.
- Routine librarian input groups equal cues under ephemeral `inactive_N` aliases and does not persist those aliases.
- Aliases are safely rebuilt after restore and may differ between runs without changing durable state.
- `recall(inactive_N)` and librarian `recall(anyInactiveMemberId)` return every current same-cue member.
- `make_active` accepts aliases or member IDs, restores the resolved cohort, returns full bodies, and preserves prior lifecycle history.
- Main-agent and contemplator search do not expose inactive status or `recallIf`; librarian search does.
- Tool names are snake_case while every argument/property name and multiword enum value is lowerCamelCase; schema tests prevent mixed naming from returning.
- At or below 50% estimated context use, the complete eligible memory set is supplied and the sampler is not invoked.
- Above 50%, initial rendered memory material never exceeds the cap, including oversized new-memory and inactive-cue cases.
- A 60%-sized pool is sampled at approximately 5/6 and an 80%-sized pool at approximately 5/8 by tokens, proving the ratio is dynamic rather than fixed.
- Pressure-valve sampling favors new evidence, modestly boosts old durable/high-relevance memories, gives every eligible record nonzero probability, and changes samples across seeded runs.
- In-process fairness statistics are never written to the durable ledger and may be lost safely on restart.
- A sampled run never mutates an omitted memory without finding and inspecting it.
- Repeated observer runs within the minimum interval coalesce without repeatedly launching the librarian.
- New-token, pressure, and maximum-delay triggers launch exactly one eligible single-flight run; observer updates arriving during it remain dirty for a later pass.
- `/om:settings` scheduling changes take effect after restore and are shown with unambiguous librarian labels.
- Pressure advisories report active tokens, context percentage, target/excess, and a derived approximate reduction count while clearly stating that it is not a quota.
- Reflection merges produce correct list-valued forward and backward pointers with bounded recall traversal.
- Reflections can themselves be merged, made inactive, and deleted.
- Parallel independent staging/search calls are race-free and deterministic; conflicting parallel staging calls report conflicts.
- `done` is rejected or deferred if called in the same response as mutations, and commits only after all staging results are visible.
- Forked branches can assign different lifecycle states without leaking changes.
- Observer retention metadata survives recording, compaction, search, and recall.
- E2E tests exercise librarian search, grouped recall/reactivation, several parallel staged actions, `done`, no-action completion, partial target validation, invalid shared dependencies, interruption, restore, and branch switching.
