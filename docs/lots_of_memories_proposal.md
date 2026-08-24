# Scaling observational memory for very long sessions

> Historical design document. The reflector/dropper and observation-pool maximum described below were replaced by the citation-based summarizer. See `how-it-works.md` and `configuration.md` for current behavior.

## Problem statement

A real session running for roughly 43 hours and 700 million lifetime tokens reached approximately:

- 1,200 recorded observations;
- 830 active and 824 visible observations;
- 108–109K observation tokens despite a 20K visible-pressure threshold and 10K active target;
- 345 recorded reflections, 341 visible, totaling about 60K tokens; and
- about 85% of the main model context occupied immediately after compaction.

This is not merely a status-display issue. The compacted summary renders the projected reflections and observations, so an oversized projection consumes main-agent context and causes compaction to recur with little usable headroom.

## Confirmed maintenance bug

A successful reflector pass used to count only when it emitted at least one new reflection. When it correctly found no new durable fact:

1. no reflection coverage entry was persisted;
2. the reflection progress clock did not advance;
3. the dropper was skipped because it required a same-run non-empty reflection; and
4. the same reflection range remained due.

This is a pruning deadlock. Already-existing reflections may fully cover old observations, and low-signal observations may be safely removable without inventing another reflection. Requiring a new reflection is therefore the opposite of the desired behavior in a mature memory pool.

The accompanying fix makes an empty `om.reflections.recorded` batch a durable successful-pass checkpoint and allows an over-target dropper pass after any successful reflector pass. Empty observer batches remain non-checkpoints because the observer intentionally retries a larger source range when it found nothing.

Regression tests cover:

- reflection progress advancing through an empty checkpoint;
- an over-target pool reaching the dropper when the reflector emits nothing new;
- existing reflections remaining available to that dropper pass; and
- the dropper independently considering low-signal observations when no new reflection was created.

### Safety caveat: “nothing new to reflect” is not “safe to forget”

The bug fix separates two decisions that had accidentally been coupled: the reflector decides whether to create a durable abstraction, while the dropper decides whether an observation is safe to remove from automatic context. A zero-output reflector pass now permits the dropper to run, but it does **not** itself prove that any observation is disposable. The current dropper still sees the records and may keep everything.

For a stronger long-term design, high-value observation removal should normally carry explicit provenance:

- the observation is represented by an existing reflection;
- it is merged into a new or updated reflection;
- it is superseded by a newer memory; or
- it is classified as short-lived, has aged, and the curator judges that its remaining value no longer warrants automatic visibility.

Only clearly low-value transient observations should retire without a covering reflection, and that should still be an LLM curator decision with a recorded reason. A user constraint, decision, correction, unresolved blocker, or unique exact detail should not disappear merely because the reflector emitted nothing.

The future curator should therefore gain bounded `search_memories` and `recall` capabilities. When processing a page, it could discover that a new observation is redundant with an older reflection that was not included in the page. It should then persist an explicit coverage edge from the observation to that reflection. Search is especially important once worker inputs become paged; today the reflector receives the complete pool, but that is precisely what cannot scale.

## Why that fix is necessary but not sufficient

The current design has several intentionally soft or unbounded components. The reported state can still occur even after fixing the deadlock.

### The observation target is advisory, not a bound

`observationsPoolTargetTokens` controls when the dropper may run and how many observation IDs it may propose. The dropper prompt explicitly permits fewer drops or no drops. Code does not force the active pool back to the target.

`observationsPoolMaxTokens` is also not a maximum. It is a pressure threshold that changes a compaction from a normal projection to a full fold. A full fold applies all known drop tombstones, but it does not create additional drops or truncate the projection. Consequently, a 109K active pool with a 10K target is valid under current semantics.

### Reflections have no lifecycle or budget

Reflections are append-only, deduplicated only by exact content hash, and never superseded, merged, hidden, or dropped. Every visible reflection is rendered at each compaction. A 60K reflection pool therefore remains 60K forever and can only grow.

Semantic near-duplicates are distinct records. A later, better reflection does not replace an earlier one, and supporting observations do not establish relationships between reflections.

### Maintenance prompts contain the complete pools

The reflector receives every active observation and every reflection. The dropper does the same. Their prompts therefore grow with the pools they are intended to reduce.

This creates a positive-feedback failure mode:

1. conservative maintenance lets the pools grow;
2. worker prompts become slower and harder for the model to reason over;
3. eventually a prompt approaches or exceeds the memory model context window;
4. reflection/drop maintenance fails or becomes less effective; and
5. the pools grow even faster.

The observer's source chunk is bounded, but its prior-observation and prior-reflection context is not, so it is exposed to the same eventual limit.

### Compaction exposes curation failure directly

The compaction summary renders the complete selected projection. When background curation does not fold and retire low-value material effectively, memory itself consumes most of the context even after raw chat is compacted. The preferred solution is to make curation continuously effective rather than have serialization code make semantic eviction decisions at the last moment.

### Full-ledger work scales with session length

Folding, projection, status, search indexing, and several settings/runtime operations scan branch entries. This is acceptable for ordinary sessions but becomes increasingly expensive at billion-token scale. Append-only history is valuable for recall, but it should not require reconstructing all active state from the beginning for every operation.

## Recommended design

The system should distinguish three concepts that are currently conflated:

1. **Durable ledger:** append-only, complete, searchable, and recallable history.
2. **Active memory:** the current set eligible for maintenance and automatic retrieval.
3. **Injected working memory:** the curated active subset placed into the main agent's compacted context; healthy curation should keep it naturally manageable rather than relying on a semantic cutoff at serialization time.

Dropping or superseding an item should remove it from active/injected memory without deleting it from the durable ledger or search/recall.

The current implementation already has most of the durable-ledger behavior for observations: an observation drop appends a tombstone, `search_memories` still searches dropped observations, and `recall` reports and reconstructs a dropped observation with source evidence. The missing pieces are equivalent lifecycle events for reflections, explicit relationship/provenance chains, and bounded traversal. We should extend the existing ledger model rather than replace it.

### Role review: reflector versus dropper

The current prompts divide one semantic job across two agents:

- The **reflector** is a preservation-only agent. Its prompt asks it to identify stable future value, create durable reflections, and attach supporting observation IDs. Its only tool is `record_reflections`; it cannot search omitted memories, link to an existing reflection, revise or merge reflections, reclassify observations, or retire anything.
- The **dropper** is a retirement-only agent. Its prompt asks it to compare observations against reflections, detect redundancy, supersession, obsolete task state, age, and unique details. Its only tool is `drop_observations`; it cannot preserve something before dropping it, combine memories, update coverage, search omitted history, or repair a weak reflection.

The prompts contain good complementary judgment criteria, but the tool split creates an artificial handoff. The dropper often discovers exactly the semantic relationship that the ledger ought to retain—“this observation is covered by that reflection” or “this task state is superseded”—and can only throw the observation away. Conversely, the reflector can preserve meaning but cannot finish the lifecycle operation by retiring the sources it just replaced. Both agents receive substantially the same pools and independently reason about future value.

Once provenance links, reflection merging, retention classes, search, and ranking exist, a permanent separate dropper agent has little remaining purpose. The recommended design is to replace both roles with one **memory curator** (or librarian) agent. The curator owns preservation and forgetting as one coherent transaction.

The curator can run in two scheduled modes using the same policy and tools:

1. **Ingestion/consolidation mode:** review newly observed material, search older memory, create or update reflections, link coverage/supersession, and classify retention.
2. **Maintenance/ranking mode:** revisit older low-ranked or stale memory batches, update task state and retention, merge reflections, and retire material whose remaining value has been preserved or has expired.

These are modes, not separate authorities. A single run may discover that an observation should first be folded into a reflection and then retired. Code should validate ordering and provenance, but the LLM makes the semantic decisions.

A second model pass can still be used as a targeted critic for unusually consequential actions—for example retiring a foundational memory with no replacement—but that is a verification policy, not a reason to retain a general-purpose dropper. Most actions should not pay for two agents making the same comparison.

The useful parts of the dropper prompt should move into the curator prompt: preserve unique details, distinguish age from obsolescence, compare equivalent fidelity, recognize superseded task state, and keep uncertain material. The useful parts of the reflector prompt remain: avoid over-reflection, preserve durable rationale, combine evidence rather than copying it, and treat provenance IDs carefully.

### Phase 1: bounded and recoverable curator maintenance

Process observations and reflections in bounded curator pages rather than sending the complete pools.

A page should contain:

- a related observation/reflection batch selected by task/topic, ranking uncertainty, retention reconsideration, and age;
- newer memories that may supersede or conflict with the batch;
- reflections supporting observations in the batch;
- a small bounded set of established rating anchors or current-task memories; and
- global pool-size, age, and maintenance-backlog metadata.

Persist a maintenance cursor/checkpoint even when a page produces no reflection or drop. Continue through additional pages on later triggers while pressure remains high. This makes worker input independent of total session length and allows an already-oversized session to recover.

Maintenance scheduling should consider tokens, not only record counts. A page of many tiny observations and a page containing a few large records have different impact. Token totals help the scheduler choose useful batches, but they should not force the curator to retire a memory it judges valuable.

### Phase 2: provenance graph and searchable curator

Treat coverage, redundancy, merging, and supersession as explicit append-only relationships rather than implications inferred from prose. A generalized ledger event could represent relationships such as:

- `covered_by`: an observation's durable meaning is represented by a reflection;
- `superseded_by`: a newer observation or reflection replaces an older claim;
- `merged_into`: several reflections were consolidated into one replacement; and
- `retired_without_replacement`: a transient memory aged out without a durable successor.

Each relationship should contain source memory IDs, target memory IDs when applicable, a compact reason, and the maintenance generation that created it. Code must validate that all cited IDs exist on the branch. The relationship is metadata; original memory bodies remain only in their original ledger records.

Give the curator `search_memories` and `recall` tools with bounded results. Its workflow for each page becomes:

1. inspect the supplied active memories and the current task/topic context;
2. search for older semantically related memories when duplication or prior decisions are plausible;
3. recall exact candidates when search summaries are insufficient;
4. link an observation to an existing adequate reflection, create a new reflection, create a consolidated replacement, or revise its retention judgment;
5. retire source memories only after deciding where their remaining value lives; and
6. leave the memory active when no representation or retirement rationale is faithful enough.

The curator should be able to attach new support to an existing reflection without rewriting that reflection. Current `supportingObservationIds` are frozen when a reflection is created, so a later observation that repeats the same fact cannot currently become explicitly covered by it. Append-only coverage edges solve that problem.

This makes retirement explainable: old observations with `covered_by`, `superseded_by`, or `merged_into` paths can leave active memory; an explicitly short-lived item can expire with a recorded curator rationale; and an uncovered high-value item remains active until the curator makes a different semantic judgment.

#### Curator tool shape

The tools should encourage coherent decisions rather than expose a bare delete button. A recommended interaction is:

1. read-only `search_memories` and `recall` calls gather omitted context;
2. action tools stage proposed creations, links, merges, retention changes, task-state changes, and retirements in memory;
3. `review_curation_plan` returns a compact summary plus warnings about missing IDs, cycles, retirement without replacement, or contradictions; and
4. `commit_curation` atomically appends the validated plan to the ledger.

Staged actions can refer to local IDs for reflections created in the same plan. This allows one transaction to create `[r3]`, mark `[r1]` and `[r2]` as `merged_into r3`, and retire the predecessors without an intermediate state where the originals disappear before the replacement exists.

Suggested staged operations are:

- `create_reflection(content, sourceMemoryIds, retentionClass, rationale)`;
- `link_memories(kind, sourceIds, targetIds, rationale)`;
- `set_retention(memoryIds, class, reconsiderWhen, rationale)`;
- `set_task_state(taskId, state, memoryIds, rationale)`;
- `merge_memories(sourceIds, replacement, rationale)`; and
- `retire_memories(memoryIds, replacementIds?, rationale)`.

Code checks structural correctness and transaction consistency. Tool descriptions and the curator prompt demand the semantic argument: what value is preserved, why the relation is faithful, and why retirement is appropriate now. Warnings give the curator a chance to search/recall and replace its staged plan. For high-uncertainty or foundational retirement without replacement, the plan can be routed to a separate critic call before commit.

### Phase 3: reflection consolidation and supersession

Reflections need the same active-versus-durable lifecycle as observations. Add append-only events such as:

- `om.reflections.superseded` containing old reflection IDs and replacement reflection IDs;
- `om.reflections.merged` containing multiple source reflection IDs and one replacement ID; and
- `om.reflections.dropped` for obsolete or redundant reflections with no replacement.

An “updated reflection” should always be a new immutable reflection plus a relationship to its predecessor, never an in-place edit. In consolidation mode, the curator should operate on bounded semantic/time-based clusters and may:

- keep a reflection unchanged;
- replace several related reflections with one higher-fidelity reflection;
- replace an old reflection with a corrected or more complete version;
- mark an older reflection superseded by a newer fact; or
- retire transient project-state reflections that are no longer useful.

For example, reflections `[r1] User chose library A` and `[r2] Library A was chosen because it supports requirement X` could become `[r3] User chose library A because it supports requirement X`, with both `r1` and `r2` marked `merged_into r3`. Only `r3` remains automatically visible.

Search indexes all three records and returns their status. Recalling `r3` should show its direct predecessors and provenance. Recalling `r1` should report that it is inactive and point forward to `r3`. Recursive history traversal must be bounded and paginated so a long merge chain cannot flood context; the agent can explicitly follow another link when needed.

This produces the desired fuzzy-memory behavior: the agent automatically remembers the consolidated conclusion but can walk backward through the chain to recover exact older details and ultimately source chat entries.

Reflection-pool size and age should be maintenance scheduling signals, but they do not force a particular merge or retirement. The curator must make incremental progress without reading the complete reflection pool.

### Phase 4: LLM-managed retention classes and task lifecycle

Importance and expected lifetime are different judgments. The current `relevance` label mostly expresses importance/resistance, but it does not say *when* a memory is expected to stop being useful. Add a separate retention class proposed by the observer and revisable by the curator:

- **ephemeral:** low-level attempts, command acknowledgements, intermediate readings, and temporary status whose useful lifetime is short;
- **task-working:** hypotheses, exact errors, partial implementation state, TODOs, and local decisions needed while a particular task remains active;
- **durable:** user preferences, constraints, corrections, architecture decisions, rationale, reusable discoveries, and completed outcomes likely to matter across tasks; and
- **foundational:** unusually persistent identity, safety, or project-level facts that the curator believes should almost always remain represented in visible memory.

These are LLM judgments, not facts that code can infer reliably from keywords. A user assertion is not automatically durable: “I am testing this temporary branch” and “I always require backwards compatibility” are both user assertions with very different lifetimes. Likewise an exact error can be task-working during diagnosis and unimportant after the root cause is reflected and the task is complete.

The observer has the best local view of the source chunk and proposes:

- retention class;
- a short rationale;
- optional task/topic identity;
- what event should cause reconsideration, such as task completion, supersession, or later consolidation; and
- confidence in the classification.

The curator has the broader memory and task view and may revise any of those fields. Other LLM decisions can also provide evidence: a contemplator probe may reveal that a memory remains unresolved, a reviewer may identify a recurring cross-task pattern, and a reflection merge may turn several task-working memories into one durable conclusion. These should be ledger events the curator can inspect, not deterministic code rules.

The database/code layer should remain deliberately modest. It should:

- validate IDs, schemas, branch scope, and graph consistency;
- preserve immutable records and append lifecycle events;
- schedule old or uncertain memories for reconsideration;
- assemble bounded comparison batches;
- apply rating math to LLM ranking outcomes; and
- materialize active/visible state from curator decisions.

It should **not** decide that prose is a user constraint, that a task is resolved, that two memories are semantic duplicates, or that a reflection has equivalent fidelity. Those are precisely the judgments delegated to the LLM through prompts and constrained tools.

Age is a reason to ask the curator again, not an automatic semantic verdict. Scheduling can use wall time, cumulative agent time/tokens, maintenance generations, and task inactivity. An old ephemeral memory is a strong retirement candidate; an old foundational memory is a consolidation/check candidate. The curator makes the final decision and records one of:

- keep and reconsider later;
- change retention class;
- link to an existing memory;
- fold into a new/updated reflection;
- mark superseded;
- merge with peers; or
- retire to searchable history without replacement, with a reason.

Task lifecycle is essential. The curator should maintain lightweight task/topic records such as `active`, `blocked`, `completed`, `abandoned`, or `superseded`. When a task becomes completed, it should revisit that task's working memories. Most implementation attempts and local errors can fall sharply in value; the final outcome, rationale, remaining caveats, and reusable discoveries can be combined into one or a few durable reflections. If the same task resumes later, search/recall can reactivate useful archived details.

This creates gradual, fuzzy forgetting without pretending that time alone understands meaning.

### Phase 5: LLM ranking with Elo-like incremental ratings

Passive signals are too weak to measure memory value reliably. The main agent is not expected to annotate every use, contemplator messages mention only a small subset, and absence of citation does not mean a constraint stopped mattering. Instead, ask an LLM directly to rank small memory batches.

The curator (or a cheaper dedicated ranking call using the curator policy) receives a bounded batch plus current task/topic summaries and answers questions such as:

- Which memories are most useful to keep automatically visible for the agent's current and likely next work?
- Which carry durable value that must be preserved before their source records retire?
- Which are now redundant, superseded, task-complete, or low-value?

A ranking of 5–10 memories yields pairwise outcomes. Code can update an Elo/Bradley–Terry-style rating from those outcomes. Overlapping batches with one or two anchor memories allow ratings to become comparable without showing the model the whole pool. Batch selection should mix:

- memories near each other in rating, to resolve uncertain ordering;
- old memories due for reconsideration;
- memories attached to a task whose state changed;
- newly created memories against established anchors; and
- occasional cross-range comparisons to prevent isolated rating islands.

A single rating still conflates two different kinds of value, so use at least two LLM-ranked dimensions:

1. **Current working value:** usefulness to the active or likely next task.
2. **Durable memory value:** importance of preserving the meaning across future tasks, possibly through a reflection rather than the original record.

When a task completes, its detailed memories should be queued for new current-value comparisons against active work. Their current ratings can then fall quickly based on LLM rankings, while a consolidated outcome reflection can retain a high durable rating. Code does not declare them obsolete; it creates the comparison opportunity and applies the model's judgments.

Ratings should guide what the curator reviews and what is gradually omitted from active memory; they should not directly erase ledger records. Low-rated memories become candidates for merge, supersession, reclassification, or retirement. A final curator action records what happened and why. Foundational/durable labels are strong context for the ranking prompt but not mathematically invincible—the curator may correct an earlier bad classification.

Ranking should be auditable. Persist compact comparison events containing batch IDs, ordered IDs or pairwise preferences, task context ID, model identity, and timestamp/generation. Periodic rating checkpoints may cache the derived numbers, but the outcomes remain reconstructable.

### Operational note: no hard semantic eviction policy

This proposal intentionally does not use a hard injected-memory cutoff or code-driven pressure tier to decide meaning. The desired steady state comes from continuous curation: short-lived records are re-ranked and retired, completed-task detail is folded into outcomes, duplicate reflections are merged, and old memories gradually move into searchable history.

The provider still has a physical context limit, so serialization must fail safely rather than send an impossible request. That engineering guard is not a memory-value policy and should not choose which durable facts are semantically disposable. If curation falls behind, status should expose the backlog and the curator should run more bounded maintenance work.

### Note on the former “materialized state” phase

The earlier Phase 8 was only a performance optimization: cache the curator's already-decided active IDs and ratings so restore/status does not replay the entire ledger every time. It was not a proposal to discard history or another kind of memory. That optimization is premature while the semantic lifecycle is unsettled, so it is removed from the implementation phases. The append-only ledger remains the source of truth; indexing/checkpoint acceleration can be revisited later without changing curator behavior.

## Provisional decisions and open questions

The current direction supports several provisional decisions:

- Replace the reflector/dropper split with a memory curator that can preserve, relate, merge, rank, and retire memories.
- The durable branch ledger remains append-only; active/visible state changes through curator-authored relationships and tombstones.
- LLMs make semantic judgments. Code validates and stores decisions, schedules bounded work, and applies rating math.
- A zero-output curation pass advances progress but is not evidence that a memory may be forgotten.
- Reflection updates are immutable replacements with predecessor links.
- Retention class is proposed by the observer and may be revised by the curator as task context changes.
- Rankings have separate current-working and durable-value dimensions.
- Low ranking creates a curation candidate; it does not directly delete a record.
- Search and recall cover inactive observations and reflections and expose forward/backward lifecycle links.
- The design aims for healthy memory size through continuous LLM curation, not hard semantic eviction rules.

Questions to resolve before implementation:

1. Should ranking be a mode of the curator or a smaller dedicated LLM call whose outcomes the curator consumes?
2. What exact tools let one curator run safely—one transactional `curate_memories` tool or separate create/link/merge/reclassify/retire tools?
3. Which retirement actions need a second critic pass, and should that depend on retention class or rating uncertainty?
4. How should task/topic records be created, merged, completed, reopened, and associated with memories?
5. How often should each retention class be reconsidered in agent tokens, active time, or maintenance generations?
6. How are stable Elo-like anchors chosen, and how many overlapping comparisons are needed before a rating is trusted?
7. Is one `covered_by` edge sufficient for retirement, or should the curator explicitly attest equivalent fidelity at retirement time?
8. How are relationship edges and ratings scoped across forks so an abandoned branch cannot alter another branch's active memory?
9. Should a merged reflection contain all predecessor source IDs directly, or rely on bounded graph traversal?
10. How should search rank inactive/superseded results while still finding an exact old detail when queried?

## Tests needed for billion-token behavior

Tests should model thousands of records even if their text is synthetic:

1. A zero-output curation pass advances progress without treating any record as implicitly disposable.
2. Curator prompt size stays bounded with 10,000 active observations and 5,000 reflections.
3. Maintenance cursors eventually visit every eligible page without starvation.
4. The curator can search for an older reflection, persist a validated `covered_by` relationship, and retire the observation without duplicating the reflection.
5. Two reflections merge into one visible replacement while both predecessors remain searchable and recallable.
6. Recall traverses predecessor/successor chains in both directions with strict depth/output bounds.
7. Observer-proposed retention classes are stored, and the curator can revise them with an auditable reason.
8. Completing a task causes its working memories to enter ranking/curation batches; detailed attempts fall in current value while the outcome reflection remains durable.
9. Small overlapping ranking batches converge to stable current-value and durable-value orderings.
10. Ranking an unrelated task does not incorrectly collapse durable cross-task memories.
11. Low rating alone never creates a tombstone; a curator retirement action is required.
12. Reflection supersession removes old reflections from active/visible memory while search and recall still find them.
13. An oversized pre-existing branch shrinks gradually over repeated curator passes without losing ledger recall.
14. Repeated compactions, process restores, and forks do not duplicate relationships, resurrect retired records, or leak ratings across branches.
15. Provider requests remain valid because every curator/search/recall/ranking batch is bounded.

A generated stress fixture should emulate the reported proportions (roughly 1,200 observations and 345 reflections) and verify that repeated curation folds old task detail into a much smaller set of useful active memories while every retired source remains searchable and recallable.

## Suggested implementation order

1. Keep the already-shipped empty-pass progress fix, but do not treat empty output as retirement evidence.
2. Specify the curator prompt by combining the reflector's preservation guidance with the dropper's redundancy, supersession, age, and unique-detail guidance.
3. Define append-only lifecycle/provenance events and forward/backward search/recall rendering.
4. Replace reflector/dropper tools with bounded curator tools for create, link, merge, reclassify, and retire operations.
5. Add bounded search/recall to the curator and page its inputs.
6. Extend observations with LLM-proposed retention metadata and add curator-managed task/topic lifecycle records.
7. Add small-batch, two-dimensional Elo-like rankings and feed low/uncertain memories back into curation.
8. Add reflection merging/supersession and gradual retirement of completed-task detail.
9. Build long-session simulations and E2E recovery tests before removing the old dropper path completely.

The central change is conceptual: memory pressure should be solved by an LLM librarian continuously reorganizing, combining, re-ranking, and archiving memories—not by code guessing their meaning or deleting records at a threshold.
