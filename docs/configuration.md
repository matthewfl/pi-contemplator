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
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "agentMaxTurns": 16,

    "librarianEnabled": true,
    "librarianMinIntervalMinutes": 10,
    "librarianMaxDelayMinutes": 180,
    "librarianMinNewMemoryTokens": 5000,
    "librarianMaxPendingMemoryTokens": 20000,
    "librarianPressureTriggerRatio": 1,
    "librarianSamplingThresholdRatio": 0.5,

    "contemplatorEnabled": true,
    "showContemplatorMessages": true,
    "contemplatorMinNewObservations": 8,
    "contemplatorMinNewReflections": 1,
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
| `observationsPoolMaxTokens` | `20000` | Visible-memory pressure used by compaction/full-fold behavior. |
| `observationsPoolTargetTokens` | `10000` | Advisory active-memory target shown to the librarian; defaults to half of max when omitted. |
| `agentMaxTurns` | `16` | Nested-agent turn cap used by observer and librarian runs. |
| `model` | current model | Optional `{ provider, id, thinking }` override for observer and librarian. |
| `librarianEnabled` | `true` | Enables stateless memory curation. |
| `librarianMinIntervalMinutes` | `10` | Normal minimum time between librarian starts. Zero is valid. |
| `librarianMaxDelayMinutes` | `180` | Maximum cumulative main-agent active-time delay after new memory. Zero is valid. |
| `librarianMinNewMemoryTokens` | `5000` | Pending new-memory tokens that make a pass ready before max delay, while still respecting the normal minimum interval. |
| `librarianMaxPendingMemoryTokens` | `20000` | Urgent pending-memory threshold. At or above this value, the librarian bypasses the minimum interval and starts as soon as its single-flight slot is available. |
| `librarianPressureTriggerRatio` | `1` | Active-token ratio against `observationsPoolTargetTokens` that makes a pass ready. |
| `librarianSamplingThresholdRatio` | `0.5` | Fraction of the librarian model context available to rendered memory input. Sampling starts only when eligible input exceeds this fraction and samples back down to this budget. |
| `contemplatorEnabled` | `true` | Enables contemplator updates. |
| `contemplatorModel` | current model | Optional model override for the contemplator. |
| `showContemplatorMessages` | `true` | Shows probes/review notices as purple chat cards; delivery still occurs when hidden. |
| `contemplatorMinNewObservations` | `8` | Observation trigger component. |
| `contemplatorMinNewReflections` | `1` | Reflection trigger component. |
| `contemplatorMinTurns` | `10` | Minimum primary-turn spacing for contemplator updates. |
| `reviewerEnabled` | `true` | Allows scoped structural review requests. |
| `reviewerModel` | current model | Optional reviewer model override. |
| `compactionObserverEnabled` | `true` | Runs an asynchronous observer sidecar when compaction begins. |
| `showWorkerNotifications` | `true` | Shows routine observer, librarian, and contemplator progress notifications. |
| `passive` | `false` | Disables proactive background work while leaving ledger views, tools, and compaction hooks available. |
| `debugLog` | `false` | Writes structured diagnostics under the observational-memory debug directory. |

Positive count/token settings must be finite positive integers. Librarian minute settings additionally accept zero. Invalid values are ignored. `observationsPoolTargetTokens` must be below max or it is re-derived.

## Librarian timing examples

Conservative, low-frequency curation:

```json
{
  "observational-memory": {
    "librarianMinIntervalMinutes": 60,
    "librarianMaxDelayMinutes": 360,
    "librarianMinNewMemoryTokens": 10000
  }
}
```

Responsive curation for a high-volume session:

```json
{
  "observational-memory": {
    "librarianMinIntervalMinutes": 10,
    "librarianMaxDelayMinutes": 60,
    "librarianMinNewMemoryTokens": 2500,
    "librarianMaxPendingMemoryTokens": 20000,
    "librarianPressureTriggerRatio": 0.9,
    "librarianSamplingThresholdRatio": 0.5
  }
}
```

These settings schedule opportunities, not mandatory pruning. The librarian can safely commit no changes.

## Models

Agent model overrides use:

```json
{ "provider": "anthropic", "id": "claude-sonnet", "thinking": "low" }
```

`thinking` may be `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Resolution falls back through the configured override and current session model according to runtime availability.

## Commands

- `/om:settings` opens the settings UI.
- `/om:settings librarian on|off` toggles librarian runs.
- `/om:settings messages on|off` controls visibility, not delivery, of contemplator cards.
- `/om:status` reports active/inactive/deleted counts, active memory tokens, librarian backlog/timing, and worker state.
- `/om:view`, `/om:view full`, `/om:view contemplator`, `/om:view librarian`, and `/om:view reviewer` inspect memory and private transcripts. The librarian view is launch-local because librarian transcripts are not persisted to the ledger.

## Environment

- `PI_OBSERVATIONAL_MEMORY_PASSIVE=1|0` overrides passive mode.
- `PI_OBSERVATIONAL_MEMORY_COMPACTION_OBSERVER=1|0` overrides the compaction observer.

## Debugging

With `debugLog: true`, structured NDJSON events include session/run metadata and counts rather than full prompts. Useful families include `observer.*`, `librarian.*`, `contemplator.*`, `reviewer.*`, compaction, probe queue/delivery, and model-resolution events.

The durable session JSONL remains authoritative. `/om:status` and `/om:view` fold the current branch rather than relying on debug logs.
