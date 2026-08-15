# pi-contemplator

`pi-contemplator` is a [Pi](https://pi.dev/) plugin for long-running, largely unsupervised agentic sessions. It does two things:

1. **Keeps memory alive across compaction.** A background **observer**, **reflector**, and **dropper** distill the conversation into a durable, branch-local memory ledger. When Pi compacts the context window, the summary is rendered deterministically from that ledger — fast, model-free, and lossless enough that important facts survive.
2. **Gives the primary agent a second set of eyes.** A background **contemplator** reads the accumulated memories and watches for reasoning that is going wrong. When it finds a genuine problem, it can inject a focused, memory-cited question. For deeper, recurring structural issues, it can commission a short-lived **reviewer** that produces a durable, advisory design proposal.

The result: a long session is less likely to drift off course, get stuck in an unproductive loop, or silently compound a wrong conclusion — and when it does, it can often catch itself before the mistake poisons the rest of the work.

> [!WARNING]
> **Alpha-quality software:** `pi-contemplator` is under active development. Expect bugs, behavioral changes, and breaking configuration or memory-format changes.

> [!WARNING]
> **Significant token usage:** The plugin runs multiple background agents and will significantly increase model-token consumption and associated API costs, especially during long sessions.

> [!NOTE]
> This project is a fork of the excellent [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) plugin by [@elpapi42](https://github.com/elpapi42). It retains that project's observer, reflector, dropper, memory, and compaction foundations while adding contemplation and structural review capabilities.

## Why use it?

A long-running agent faces three compounding risks:

- **Compaction amnesia.** Pi compacts older messages to fit the context window. Details that weren't captured deliberately are simply gone.
- **Reasoning entrenchment.** An agent can draw the wrong conclusion from valid evidence and then repeatedly reinforce it. As the mistake accumulates in context, the agent becomes *less* likely to question it and *less* able to discover the real problem.
- **Unproductive loops.** The agent keeps bumping into the same obstacle through slightly different approaches, burning tokens without gaining information.

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

## What it does for you

### It catches reasoning problems before they settle

The contemplator is a "System 2" thinker: slower and more deliberative, focused on the larger shape of the problem while the primary agent does the hands-on work. It watches the memory ledger (not the live transcript) and looks for:

- unsupported assumptions — a conclusion that depends on something never established;
- contradictions — a recent claim that conflicts with earlier recorded evidence;
- drift from the user's intent, priorities, or constraints;
- overlooked alternatives — treating one explanation as settled when others are still plausible;
- unproductive loops — several memories showing the agent returning to the same obstacle;
- connections — relevant facts from separate memories that the primary agent never joined up.

When it finds something worth challenging, it sends a concise, memory-cited question as an asynchronous probe. Probes appear as purple cards in the chat and are delivered to the agent's next turn — they never interrupt mid-work or force a new turn:

```text
◆ CONTEMPLATOR PROBE

You concluded that fix Y resolved the failure, citing memory [a1b2c3d4e5f6].
Earlier, memory [d4e5f6a1b2c3] recorded that A, B, and C were also
possible explanations. What observation would distinguish Y from A, B, and C
before you build on that conclusion?
```

### It commissions deeper structural reviews

Some patterns are bigger than one question. When several memories point at a *recurring* structural problem, the contemplator can request a review instead of a probe. The reviewer is a separate, short-lived, strictly-scoped agent that independently investigates the concern and, if the evidence supports it, records a durable conceptual proposal.

Two scopes are handled separately:

- **Workflow** — problems in *how* the work is performed: repeatedly reconstructing the same information, reasoning at length about something that could just be observed or computed, failing to preserve a reusable result, weak feedback loops.
- **Software** — problems in *the software being produced*: repeated special cases, several fixes touching the same missing invariant, duplicated concepts, unclear responsibility boundaries, local workarounds that hint at a missing abstraction.

The reviewer isn't just fed the concern and asked to design a fix. It independently searches the memory ledger *and* the primary agent's recorded chat history (including regex search over the transcript), looks for supporting and contrary evidence, and reaches exactly one terminal outcome: either a durable proposal with a memory id, or a conclusion that no proposal is currently justified. The primary agent receives only a compact notice pointing at the proposal:

```text
◆ CONTEMPLATOR REVIEW

BACKGROUND WORKFLOW REVIEW PROPOSAL [f7a8b9c0d1e2]

Several memories ([1111], [2222], [3333]) show the same multi-step lookup being
rebuilt from scratch each time. The proposal suggests a reusable, indexable
trace that would make the relationship reproducible in seconds instead of minutes.

Recall memory [f7a8b9c0d1e2] to read the full conceptual proposal when it is
relevant. This is advisory.
```

Proposals are deliberately conceptual — the reviewer cannot write code, specify exact APIs, name files, or hand over an implementation plan. The primary agent remains the only agent grounded in the actual codebase and environment, and it decides whether, when, and how to use a proposal.

### It keeps memory useful and accountable

The memory system is built to be trustworthy:

- **Every memory has provenance.** Observations cite the exact source entries that support them; reflections cite the observations they're based on. Everything gets a deterministic 12-character id computed in code, not guessed by a model.
- **Nothing important is silently lost.** The `recall` tool recovers the exact source evidence behind any memory id. The `search_memories` tool finds candidate memories by topic. Even observations the dropper later prunes remain recallable from ledger history.
- **Compaction is deterministic and model-free.** The summary the agent sees is folded from the ledger by code, not rewritten by a model. That makes compaction fast and cheap, and it means the same session state always produces the same summary.

## Why you can trust it in the background

Running extra agents in the background can be worrying — what if they take over, spam the user, or go off the rails? `pi-contemplator` is explicitly designed against that:

- **Advisory only.** The contemplator and reviewer never modify the primary agent's work, never implement anything, and never inject instructions into the user's session. They produce questions and proposals; the primary agent decides what to do.
- **One intervention per update.** The contemplator can send at most one probe *or* one review request per turn — never a barrage. Most turns it sends nothing at all.
- **Grounded in evidence, not noise.** Loops must be supported by a clear pattern across *multiple* memories. The contemplator is explicitly forbidden from inferring a stall from silence, elapsed time, or a missing recent result. It may consult activity signals (cumulative tokens, tool-call count, active time) as *advisory* context, but never as proof.
- **Sees memory, not secrets.** The contemplator reads only the memory ledger, not the live transcript, so it can't react to or interfere with in-flight work.
- **Epistemic humility.** The contemplator is instructed not to behave as though it already knows the answer, not to praise or criticize, and not to manage the primary agent step by step. It asks questions that help *both* agents discover what's missing.
- **Bounded and de-duplicated.** Reviews are serialized (one at a time), coalesced (no duplicate review for the same evidence and concern), and capped by a lifetime output-token budget — a review that runs out of budget records an honest "no proposal" rather than a half-baked design.

## Background agents

`pi-contemplator` uses five specialized background agents, all enabled by default:

| Agent | What it does | When it runs |
|---|---|---|
| **Observer** | Extracts concrete, timestamped observations from the primary session, citing source entries. | In the background after turns, once enough new source text accumulates. |
| **Reflector** | Distills durable conclusions (user intent, decisions, constraints) from observations, citing supporting observations. | Periodically, after the observer is up to date. |
| **Dropper** | Prunes observations that are obsolete, redundant, or safely represented elsewhere, keeping the active memory pool bounded. | Only after a successful reflection, when the memory pool is over target. |
| **Contemplator** | Watches accumulated memories for reasoning gaps, contradictions, overlooked alternatives, and recurring structural concerns; can send a focused probe or request a review. | Asynchronously after enough new memories accumulate. |
| **Reviewer** | Performs a deep, scoped (workflow or software) structural investigation and records a durable proposal or a no-proposal conclusion. | Only when the contemplator commissions a review, and only one at a time. |

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

## Commands and configuration

The plugin works with its defaults, including the contemplator and reviewer. Contemplator probes and review notices appear as purple cards in the chat by default; use `/om:settings messages off` to hide newly sent cards without stopping their delivery to the agent.

Useful commands:

- `/om:status` — show memory and background-agent status, including how much recorded memory is still visible vs. pending.
- `/om:view` — inspect visible memory (and attempt to copy it).
- `/om:view full` — inspect the full memory ledger, including everything not yet folded into a compaction.
- `/om:view contemplator` — inspect the contemplator's private transcript and probes.
- `/om:view reviewer` — inspect structural reviewer transcripts and outcomes.
- `/om:settings` — inspect or change session-level settings (including `messages on|off`, `reviewer on|off`, `compaction on|off`).

Model selection, trigger thresholds, passive mode (which stops all background work), compaction behavior, and other tuning are documented in [docs/configuration.md](docs/configuration.md). See [docs/how-it-works.md](docs/how-it-works.md) for the memory lifecycle and [docs/concepts.md](docs/concepts.md) for the mental model.

## Development

```bash
npm install
npm test
npm run test:unit
npm run test:e2e
npm run typecheck
```

`npm test` runs both the unit and RPC end-to-end suites. Use `test:unit` or `test:e2e` to run either suite independently.

`test:e2e` starts a local OpenAI-compatible model server and launches isolated real Pi CLI processes in RPC mode while mocking only the external model-server boundary. The suites cover observer, reflector, dropper, contemplator, reviewer, primary-agent, memory-tool, and compaction flows. They exercise slow and parallel tools, probe races and feedback, hidden/idle delivery, cumulative activity time, process restore, reviewer transcript resume and budget exhaustion, accepted/rejected reviews, manual/failed compaction continuations and non-restarting proactive compaction, compaction observer sidecars, malformed memory records, huge-source bounding, id collisions, role-specific model routing, feature flags, session-tree forks, and concurrent session isolation.

## License

MIT. See [LICENSE](LICENSE).