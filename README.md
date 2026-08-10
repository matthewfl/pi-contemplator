# pi-contemplator

`pi-contemplator` is a [Pi](https://pi.dev/) plugin designed to help long-running, unsupervised agentic sessions stay on track.

It adds a background **contemplator** agent that examines accumulated session memories for logical fallacies, unsupported assumptions, contradictions, and incorrect conclusions. When it finds a meaningful reasoning problem, it can interject with a focused question that helps the primary agent reconsider its reasoning before a mistaken premise poisons the rest of the session.

> [!WARNING]
> **Alpha-quality software:** `pi-contemplator` is under active development. Expect bugs, behavioral changes, and breaking configuration or memory-format changes.

> [!WARNING]
> **Significant token usage:** The plugin runs multiple background agents and will significantly increase model-token consumption and associated API costs, especially during long sessions.

> [!NOTE]
> This project is a fork of the excellent [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) plugin by [@elpapi42](https://github.com/elpapi42). It retains that project's observer, reflector, dropper, memory, and compaction foundations while adding contemplation and structural review capabilities.

## Why use it?

A long-running agent can draw the wrong conclusion from valid evidence and then repeatedly reinforce that conclusion. As the mistake accumulates in context, the agent becomes less likely to question it and less able to discover the real problem.

Without a contemplator, a session can look like this:

```text
Run test X

Conclude Y from the output of X

Y is true

Y is true

Y is true

...

Y is true

The agent is now stuck. Its context has been poisoned by the repeated
assumption that Y is true, so it cannot identify the actual issue.
```

With the contemplator running in the background, the session can recover before that conclusion becomes entrenched:

```text
Run test X

Conclude Y from the output of X

Y is true

Contemplator interjection: You ran a test for X and then concluded that Y is
true. Did you consider A, B, and C? Each could also explain the result you
observed. A quick distinguishing test could be ...

That is a good point. Let me run a quick test to determine which of Y, A, B,
or C is true.

Run test ... It appears that Y and B are false, while A or C is a much better
explanation for the issue.

A or C is true

A or C is true

...
```

The contemplator does not take over the primary agent's work. It provides occasional, evidence-grounded challenges when reconsidering the current reasoning is more valuable than allowing the session to continue along the same path.

## Background agents

`pi-contemplator` uses five specialized background agents:

| Agent | Purpose | Compared with `pi-observational-memory` |
|---|---|---|
| **Observer** | Extracts concrete, durable observations from the primary session. | Same as `pi-observational-memory` |
| **Reflector** | Finds higher-level patterns and relationships across observations. | Same as `pi-observational-memory` |
| **Dropper** | Removes observations that are obsolete, redundant, or safely represented elsewhere. | Same as `pi-observational-memory` |
| **Contemplator** | Watches accumulated memories for reasoning gaps, contradictions, overlooked alternatives, and recurring structural concerns; it can send a focused probe to the primary agent. | Added by `pi-contemplator` |
| **Reviewer** | Performs a deeper, scoped workflow or software-design investigation when the contemplator identifies a well-supported recurring structural issue. | Added by `pi-contemplator` |

The observer, reflector, and dropper provide the durable memory substrate. The contemplator reasons over that substrate, while the reviewer is launched only when a concern warrants a deeper structural investigation.

## Installation

Install the published package through Pi:

```bash
pi install npm:@matthewfl/pi-contemplator
```

Or run it directly from a local checkout:

```bash
pi -e ./src/index.ts
```

## Configuration and commands

The plugin works with its defaults, including the contemplator and reviewer. Model selection, trigger thresholds, passive mode, compaction behavior, and other settings are documented in [docs/configuration.md](docs/configuration.md).

Useful commands include:

- `/om:status` — show memory and background-agent status.
- `/om:view contemplator` — inspect the contemplator's persisted private transcript.
- `/om:view reviewer` — inspect structural reviewer transcripts and outcomes.
- `/om:settings` — inspect or change session-level settings.

See [docs/how-it-works.md](docs/how-it-works.md) for the memory lifecycle and detailed behavior.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT. See [LICENSE](LICENSE).
