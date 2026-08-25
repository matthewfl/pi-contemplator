# Configuration

Project settings live in `.pi/settings.json` under `observational-memory`. Global settings use the same object in Pi's agent settings file. Session overrides made through `/om:settings` are persisted in the branch ledger.

```json
{
  "observational-memory": {
    "observeAfterTokens": 10000,
    "observerChunkMaxTokens": 60000,
    "compactAfterTokens": 81000,
    "compactAfterTokensMode": "calibrated",
    "compactAfterTokensRatio": 0.68,
    "agentMaxTurns": 16,

    "summarizerEnabled": true,
    "newMemoryPoolMaxTokens": 40000,
    "oldMemoryPoolTargetTokens": 40000,
    "summarizerRetriggerTokens": 2000,
    "summarizerSamplingThresholdTokens": 60000,

    "contemplatorEnabled": true,
    "showContemplatorMessages": true,
    "contemplatorMinNewObservations": 8,
    "contemplatorMinNewSummaries": 1,
    "contemplatorMinTurns": 10,

    "reviewerEnabled": true,
    "compactionObserverEnabled": true,
    "showWorkerNotifications": true,
    "passive": false,
    "debugLog": false
  }
}
```

## Settings

| Setting | Default | Meaning |
|---|---:|---|
| `observeAfterTokens` | `10000` | Raw source tokens after observer coverage before observation work is due. |
| `observerChunkMaxTokens` | derived | Maximum estimated observer input. When omitted, uses 25% of the observer model context window, with a 60k fallback. |
| `compactAfterTokens` | `81000` | Raw source-token backlog for proactive compaction in `calibrated` mode and the fallback in ratio mode. Injected observations and summaries do not count toward this backlog. |
| `compactAfterTokensMode` | `calibrated` | `calibrated` or `ratio`. |
| `compactAfterTokensRatio` | `0.68` | Context-window fraction used to derive the raw source-backlog threshold in ratio mode; injected memory remains excluded from the compared backlog. Must be between 0 and 1. |
| `agentMaxTurns` | `16` | Nested-agent turn cap used by observer and summarizer runs. |
| `model` | current model | Optional `{ provider, id, thinking }` override for observer and summarizer. |
| `summarizerEnabled` | `true` | Enables stateless memory summarization. |
| `newMemoryPoolMaxTokens` | `40000` | Token budget for the newest protected memories. Whole memories are not split, and the newest memory is always protected even when it alone exceeds the budget. |
| `oldMemoryPoolTargetTokens` | `40000` | Advisory old-pool target. The summarizer runs only on old memories after this is exceeded. |
| `summarizerRetriggerTokens` | `2000` | If a pass leaves the old pool above target, require this much additional old-pool growth before another pass. |
| `summarizerSamplingThresholdTokens` | `60000` | Rendered old-memory input cap. Above it, inverse-length sampling favors compactable groups of small memories. |
| `contemplatorEnabled` | `true` | Enables contemplator updates. |
| `contemplatorModel` | current model | Optional model override for the contemplator. Reasoning-capable models default to `medium` thinking unless this or the shared `model.thinking` explicitly overrides it. |
| `showContemplatorMessages` | `true` | Shows probes/review notices as purple chat cards; delivery still occurs when hidden. |
| `contemplatorMinNewObservations` | `8` | Observation trigger component. |
| `contemplatorMinNewSummaries` | `1` | Summary trigger component. |
| `contemplatorMinTurns` | `10` | Minimum completed primary-model-response spacing for contemplator updates. Tool-using rounds within one long user turn count separately. |
| `reviewerEnabled` | `true` | Allows scoped structural review requests. |
| `reviewerModel` | current model | Optional reviewer model override. |
| `compactionObserverEnabled` | `true` | Runs an asynchronous observer sidecar when compaction begins. |
| `showWorkerNotifications` | `true` | Shows routine observer, summarizer, and contemplator progress notifications. |
| `passive` | `false` | Disables proactive background work while leaving ledger views, tools, and compaction hooks available. |
| `debugLog` | `false` | Writes structured diagnostics under the pi-contemplator debug directory. |

Positive count/token settings must be finite positive integers. Invalid values are ignored.

## Memory-pool examples

Keep more recent working context verbatim while retaining the default old-pool target:

```json
{
  "observational-memory": {
    "newMemoryPoolMaxTokens": 60000,
    "oldMemoryPoolTargetTokens": 40000
  }
}
```

Compress old history more aggressively in a high-volume session:

```json
{
  "observational-memory": {
    "newMemoryPoolMaxTokens": 40000,
    "oldMemoryPoolTargetTokens": 25000,
    "summarizerRetriggerTokens": 1000,
    "summarizerSamplingThresholdTokens": 60000
  }
}
```

The pool boundary and trigger threshold are derived in memory from the durable ledger; they are not additional ledger records. The old-pool target schedules an opportunity, not mandatory condensation—the summarizer may safely commit no changes.

## Models

Agent model overrides use:

```json
{ "provider": "anthropic", "id": "claude-sonnet", "thinking": "low" }
```

`thinking` may be `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Resolution falls back through the configured override and current session model according to runtime availability.

## Commands

- `/om:settings` opens the settings UI.
- `/om:settings summarizer on|off` toggles summarizer runs.
- `/om:settings messages on|off` controls visibility, not delivery, of contemplator cards.
- `/om:status` reports visible/summarized counts, new/old memory pools, the next summarizer threshold, and worker state.
- `/om:view`, `/om:view full`, `/om:view contemplator`, `/om:view observer`, `/om:view summarizer`, and `/om:view reviewer` inspect memory and private transcripts. Observer and summarizer views are launch-local because those worker transcripts are not persisted to the ledger.

## Environment

- `PI_OBSERVATIONAL_MEMORY_PASSIVE=1|0` overrides passive mode.
- `PI_OBSERVATIONAL_MEMORY_COMPACTION_OBSERVER=1|0` overrides the compaction observer.

## Debugging

With `debugLog: true`, structured NDJSON events include session/run metadata and counts rather than full prompts. Useful families include `observer.*`, `summarizer.*`, `contemplator.*`, `reviewer.*`, compaction, probe queue/delivery, and model-resolution events.

The durable session JSONL remains authoritative. `/om:status` and `/om:view` fold the current branch rather than relying on debug logs.
