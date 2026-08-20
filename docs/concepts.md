# Concepts

## Durable branch-local memory

The session JSONL ledger is the source of truth. Memory state is derived by folding the current branch, so tree forks naturally inherit only their ancestors. Compaction archives observations, summaries, and their consumption graph, so folded records remain searchable and recallable.

Memory ids are deterministic 12-character lowercase hexadecimal hashes computed by code.

## Observations

The observer converts source-addressed transcript chunks into concise observations. Each observation contains content, timestamp, relevance, a retention hint, exact source-entry ids, an id, and an estimated token count. Retention is guidance to the summarizer, not an automatic removal rule; omitted retention defaults to `contextual`.

## Summaries and consumption

A summary is a shorter higher-order memory that cites at least two observations or older summaries inline, such as `[aabbccddeeff, 112233445566]`. It stores all direct source ids plus the subset newly consumed by that summary.

A consumed memory leaves the automatically injected pool, but is never erased. It remains searchable and recallable. Folding derives both directions of the graph:

- `consumedBySummaryId` points from a consumed source to its replacement;
- `citedBySummaryIds` lists every summary that cites a memory; and
- each summary's `sourceMemoryIds` points back to its direct evidence.

A summary created during the current summarizer run may be cited immediately, but cannot itself be consumed until a later run. This prevents a single pass from building an opaque, deep chain.

## Summarizer

Each summarizer run starts with fresh model context. It receives the selected active observations and summaries, plus explicit instructions that the records are the primary agent's durable memory. It has these mutation tools:

- `summarize` marks optional ids as run-local `keep_verbatim` and creates one or more validated summaries;
- `fix_summary` atomically replaces or deletes a summary created in the current run; and
- `done` is called twice: the first call reports the proposed reduction, and the second confirms completion.

It can also use `search_memories` and `recall`. Summary citations are parsed strictly. Unknown ids, unbracketed memory ids, malformed brackets, fewer than two newly consumable sources, or inadequate token reduction reject that candidate with a specific error. Valid candidates from the same call still succeed. Accepted work is committed even if the model reaches its turn/output limit without confirming `done`; an empty run writes no commit.

## Sampling and pressure

When eligible rendered memory exceeds `summarizerSamplingThresholdTokens` (50,000 by default), the input is sampled back to that budget. New and recent memories are favored while older memories retain a chance of selection. Sampling fairness state is launch-local, not durable.

The summarizer also sees active-memory size and the configured target. These are advisory pressure signals, not deterministic removal quotas.

## Search and recall

`search_memories` searches durable observations, summaries, and review outcomes. Results distinguish visible memories from memories already summarized away.

`recall` returns the exact selected record and its immediate graph links. For observations it also recovers exact source chat entries. Content-address collisions with different source evidence are preserved and reported rather than collapsed. Review results are available only through explicit search/recall; they are not injected into routine memory context.

## Contemplator and reviewer

The contemplator is stateful across updates and reasons over memory, activity signals, and its private transcript. It may queue one probe or one scoped review request per update. Probes are steer messages: they do not start a turn, but are inserted after the current tool batch so the next provider request sees them.

The reviewer is a short-lived resumable investigator. Its complete messages are persisted for recovery. It produces one terminal proposal or no-proposal result; budget exhaustion is also terminal so a request cannot remain pending forever.
