# Concepts

## Durable branch-local memory

The session JSONL ledger is the source of truth. Memory state is derived by folding the current branch, so tree forks naturally inherit only their ancestors. Compaction never makes a memory unsearchable: compaction details carry an archive of observations, reflections, and lifecycle state.

Memory ids are deterministic 12-character lowercase hexadecimal hashes. The observer and librarian must cite existing ids; code validates ids and lifecycle targets before committing changes.

## Observations

The observer converts source-addressed transcript chunks into concise observations. Each observation contains:

- content and a timestamp;
- relevance;
- a retention hint: `ephemeral`, `contextual`, or `durable`;
- exact source-entry ids;
- a deterministic id and estimated token count.

Retention is advice to the librarian, not an automatic deletion rule. Existing observations without retention are treated as `contextual`.

## Reflections

A reflection is a higher-order memory made from at least two inspected observations or reflections. It keeps `sourceMemoryIds` backpointers. Reflections are not intrinsically more durable than observations: the librarian may later combine, inactivate, or delete them.

## Lifecycle states

Every memory is in one of three states:

- **active** — injected into routine memory context;
- **inactive** — omitted from automatic context, but searchable and recallable;
- **deleted** — logically removed from routine use, but still searchable and recallable with its deletion reason.

Inactive memories are grouped for librarian input by a short `recallIf` cue. These group aliases are rebuilt for each run and are not durable ids. Reactivating an alias restores the whole same-cue cohort and returns its full bodies to the librarian.

Deletion is never physical erasure. A delete records its reason, evidence ids, and optional replacement ids. Reflection merges and replacements create forward and backward provenance pointers shown by recall.

## Librarian

The librarian replaces the old reflector/dropper pipeline. It is a fresh, mostly stateless agent on every run. Its input contains active memory and compact inactive-cohort cues; deleted memory is not injected.

The librarian can:

- `record_reflection` from two or more inspected memories, while keeping, inactivating, or deleting all sources;
- `make_inactive` for valid but currently irrelevant memory;
- `make_active` when later observations make an inactive cohort relevant;
- `delete_memories` for obsolete, low-value, or consumed temporal detail;
- use `search_memories` and `recall` only when presented evidence points to omitted history;
- call `done` to atomically commit all staged changes.

If the librarian does not call `done`, staged work is discarded and its dirty backlog is restored. It is instructed to defer uncertain changes because future runs will provide later evidence and different samples.

## Sampling and pressure

When all eligible librarian input fits within the configured `librarianSamplingThresholdRatio` of the librarian model's context window (50% by default), the complete set is provided. Sampling begins only above that boundary. The sampling ratio adapts to the excess; recent/new memories are strongly favored, while every eligible item keeps nonzero probability. Fairness bookkeeping is runtime-only.

The librarian sees active token usage, the configured target, and an advisory estimate of how much curation could return the pool toward target. This is guidance, not a hard quota.

## Search and recall

`search_memories` searches durable observations, reflections, and review outcomes. Main-agent and contemplator results do not expose whether a non-deleted memory is inactive. Deleted results include their deletion reason. Librarian search additionally exposes inactive status and `recallIf`.

`recall` returns exact source context, lifecycle metadata where appropriate, provenance links, and collision information. Content-address collisions with different source evidence are preserved rather than collapsed.

## Contemplator and reviewer

The contemplator is stateful across updates and reasons over memory, activity signals, and its private transcript. It may queue one probe or one scoped review request per update. Probes are steer messages: they do not start a turn, but are inserted after the current tool batch so the next provider request sees them.

The reviewer is a short-lived resumable investigator. Its complete messages are persisted for recovery. It produces one terminal proposal or no-proposal result; budget exhaustion is also terminal so a request cannot remain pending forever.
