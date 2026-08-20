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
    "observationsPoolTargetTokens": 20000,
    "agentMaxTurns": 16,

    "summarizerEnabled": true,
    "summarizerMinIntervalMinutes": 10,
    "summarizerMaxDelayMinutes": 180,
    "summarizerMinNewMemoryTokens": 5000,
    "summarizerMaxPendingMemoryTokens": 20000,
    "summarizerPressureTriggerRatio": 1,
    "summarizerSamplingThresholdTokens": 50000,

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
| `observerChunkMaxTokens` | derived | Maximum estimated observer input. When omitted, uses 20% of the observer model context window, with a 60k fallback. |
| `compactAfterTokens` | `81000` | Proactive threshold in `calibrated` mode and fallback in ratio mode. |
| `compactAfterTokensMode` | `calibrated` | `calibrated` or `ratio`. |
| `compactAfterTokensRatio` | `0.68` | Context-window fraction in ratio mode; must be between 0 and 1. |
| `observationsPoolTargetTokens` | `20000` | Advisory total active-memory target shown to the summarizer. Changing it requests a new pressure pass immediately, subject to the configured minimum interval. |
| `agentMaxTurns` | `16` | Nested-agent turn cap used by observer and summarizer runs. |
| `model` | current model | Optional `{ provider, id, thinking }` override for observer and summarizer. |
| `summarizerEnabled` | `true` | Enables stateless memory summarization. |
| `summarizerMinIntervalMinutes` | `10` | Normal minimum cumulative agent-active time between summarizer starts. Zero is valid. |
| `summarizerMaxDelayMinutes` | `180` | Maximum cumulative main-agent active-time delay after new memory. Zero is valid. |
| `summarizerMinNewMemoryTokens` | `5000` | Pending new-memory tokens that make a pass ready before max delay, while still respecting the normal minimum interval. |
| `summarizerMaxPendingMemoryTokens` | `20000` | Urgent pending-memory threshold. At or above this value, the summarizer bypasses the minimum interval and starts at the next activity checkpoint. |
| `summarizerPressureTriggerRatio` | `1` | Active-token ratio against `observationsPoolTargetTokens` that makes a pass ready. |
| `summarizerSamplingThresholdTokens` | `50000` | Rendered memory-input token budget. Sampling starts only when eligible input exceeds this count and samples back down to this budget. |
| `contemplatorEnabled` | `true` | Enables contemplator updates. |
| `contemplatorModel` | current model | Optional model override for the contemplator. |
| `showContemplatorMessages` | `true` | Shows probes/review notices as purple chat cards; delivery still occurs when hidden. |
| `contemplatorMinNewObservations` | `8` | Observation trigger component. |
| `contemplatorMinNewSummaries` | `1` | Summary trigger component. |
| `contemplatorMinTurns` | `10` | Minimum completed primary-model-response spacing for contemplator updates. Tool-using rounds within one long user turn count separately. |
| `reviewerEnabled` | `true` | Allows scoped structural review requests. |
| `reviewerModel` | current model | Optional reviewer model override. |
| `compactionObserverEnabled` | `true` | Runs an asynchronous observer sidecar when compaction begins. |
| `showWorkerNotifications` | `true` | Shows routine observer, summarizer, and contemplator progress notifications. |
| `passive` | `false` | Disables proactive background work while leaving ledger views, tools, and compaction hooks available. |
| `debugLog` | `false` | Writes structured diagnostics under the observational-memory debug directory. |

Positive count/token settings must be finite positive integers. Summarizer minute settings additionally accept zero. Invalid values are ignored.

## Summarizer timing examples

Conservative, low-frequency curation:

```json
{
  "observational-memory": {
    "summarizerMinIntervalMinutes": 60,
    "summarizerMaxDelayMinutes": 360,
    "summarizerMinNewMemoryTokens": 10000
  }
}
```

Responsive curation for a high-volume session:

```json
{
  "observational-memory": {
    "summarizerMinIntervalMinutes": 10,
    "summarizerMaxDelayMinutes": 60,
    "summarizerMinNewMemoryTokens": 2500,
    "summarizerMaxPendingMemoryTokens": 20000,
    "summarizerPressureTriggerRatio": 0.9,
    "summarizerSamplingThresholdTokens": 50000
  }
}
```

These settings schedule opportunities, not mandatory condensation. The summarizer can safely commit no changes.

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
- `/om:status` reports visible/summarized counts, active memory tokens, summarizer backlog/timing, and worker state.
- `/om:view`, `/om:view full`, `/om:view contemplator`, `/om:view summarizer`, and `/om:view reviewer` inspect memory and private transcripts. The summarizer view is launch-local because summarizer transcripts are not persisted to the ledger.

## Environment

- `PI_OBSERVATIONAL_MEMORY_PASSIVE=1|0` overrides passive mode.
- `PI_OBSERVATIONAL_MEMORY_COMPACTION_OBSERVER=1|0` overrides the compaction observer.

## Debugging

With `debugLog: true`, structured NDJSON events include session/run metadata and counts rather than full prompts. Useful families include `observer.*`, `summarizer.*`, `contemplator.*`, `reviewer.*`, compaction, probe queue/delivery, and model-resolution events.

The durable session JSONL remains authoritative. `/om:status` and `/om:view` fold the current branch rather than relying on debug logs.
