# Harness arena

Staged, not run against any paid API. Lead author: Claude (Opus 5.5, Claude Code), 2026-10-22, revision 1. Review state: pending a different-provider review on the PR.

The arena puts several coding-agent harnesses on the same pinned playbook tasks, each in its own container, and records what each one delivered per dollar. Grading uses the playbook's own deterministic graders. Each contestant's result bundle then gets a Starlight Kernel receipt signed under a grader from a different vendor than the contestant.

The tasks are the 29 public Multi-agent Ops tasks and their gh simulator from `Starlight-Intelligence/starlight-playbooks` PR #2. Nothing here invents a task. The contract is pinned by sha256 in `arena.config.json`.

## Contestants

| Id | Harness, pinned | Model | Credential (env name only) |
|---|---|---|---|
| `claude-code` | `@anthropic-ai/claude-code` 2.1.303, `claude -p --output-format stream-json` | `claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| `codex` | `@openai/codex` 0.163.0, `codex exec --json` | `gpt-6-astra` | `OPENAI_API_KEY` |
| `opencode-omo` | `opencode-ai` 1.0.162 + `oh-my-opencode` 2.5.1, `ultrawork` via the Sisyphus agent | OpenRouter `deepseek/deepseek-v4.1-flash-1017`, subagents `qwen/qwen3.8-flash` | `OPENROUTER_API_KEY` (Infisical EU, project 5578966b…, dev) |
| `eve-or-flue` | not run | | |

The models are the playbook contract's own for the first two. The open models are a proposal taken from the public OpenRouter list on 2026-10-22.

omo is a contestant inside its own container and nothing more. It never orchestrates anything here.

## Run it

```bash
# dry run, no spend: mock model, two tasks, three contestants as host processes, Kernel receipts
node harness/arena/run-arena.mjs --pack <starlight-playbooks>/playbooks/multi-agent-ops \
  --tasks T01,T09 --mock good --out /tmp/arena --kernel <starlight-kernel>/bin/starlight.mjs

# negative control: the playbook's bad reference solutions must fail
node harness/arena/run-arena.mjs --pack <...> --tasks T01,T09 --mock bad --out /tmp/arena-bad --kernel <...>

# one container per contestant (Docker or Podman)
node harness/arena/run-arena.mjs --pack <...> --runtime docker --tasks T01,T09 --mock good --out /tmp/arena

# Railway: write the services and commands, deploy nothing
node harness/arena/run-arena.mjs --runtime railway-plan --out /tmp/arena-plan

node --test harness/arena/test/arena.test.mjs
```

Drop `--mock` for a real run. It is refused today (exit 4) with every reason listed: the caps and provider hard limits are empty, contract 0.2.0 has no public pre-registration, no keys are set, and a host run has no credential boundary. Each run needs a fresh `--out`; the default is `runs/<arenaId>`, and a non-empty destination is refused.

## What a run records

Each trial is one `arena-trial.v0` row (`schema/arena-trial.v0.schema.json`) in `<out>/<contestant>/trials.jsonl`:

- **Outcome.** Pass or fail per task. A pass needs collision 0, bad_merge 0, recovery 1 and task_success 1, as the playbook defines them. An LLM-judged task without a verdict is `null`, never a pass.
- **Wall time, tokens, dollar cost, tool calls.** These come from each harness's own output stream. Claude and OpenCode report their own cost. Codex reports tokens only, so its cost needs a price row in `pricing.models`. Without one its cost stays `null` (unknown), never 0.
- **Light events.** These are `refusedUnsafe`, `escalated` and `heldGate`, read from the commands the agent ran and its final message (method `heuristic-v0`). They are signals, not scores.
- **The raw stream.** It is saved as the transcript, with fixture secrets and live credentials redacted. Each transcript is bound into the Kernel receipt by its own sha256, along with the `transcripts.sha256` manifest.
- **One outcome rule.** A run that did not finish normally (timeout, cap, step limit, error, blocked) is a fail, whatever the sandbox shows. The trial row, the aggregate, the Kernel check and the Team Card export all apply the same rule. Only an accepted receipt that verified with the public key alone backs a Team Card outcome.

The orchestrator writes:

- `results.json` (`arena-results.v0`)
- `team-run.jsonl`, one Team Card `team-run.v0` row per trial
- `RESULTS.md`, the table
- `receipts/`, one Kernel receipt per contestant plus the issuer's public key

**Team Card mapping.** `lib.mjs` `toTeamRun()` is the only place arena fields become team-run fields. The target is `schemas/team-run.v0.schema.json` in frankxai/starlight-kernel#9 (draft, 93af8cd), whose attribute names are OpenTelemetry GenAI's:

| arena-trial.v0 | team-run.v0 |
|---|---|
| `trialId`, `startedAt`, `endedAt` | `runId`, `startTime`, `endTime` |
| `contestant`, `harness`, `harnessVersion`, `arenaId` | `gen_ai.agent.id`, `.agent.name`, `.agent.version`, `gen_ai.conversation.id` |
| `vendor`, `model` | `gen_ai.provider.name` (OTel values: anthropic, openai, openrouter), `gen_ai.request.model` |
| `tokens` | `gen_ai.usage.*` |
| `finished` other than done | `error.type` |
| `tools` | `toolCalls[]` (`gen_ai.tool.name`, `gen_ai.tool.call.id`) |
| `costUsd`, `costSource` | `cost.usd`, `cost.basis` (cli-reported, or estimate from the price table) |
| task pass/fail | `outcome`: `goalId` `<pack>-<task>`, `delta` 1 or 0, `evidence` the contestant's `receipt:<id>` |
| `events` | `lightEvents[]` (held-gate, refused-unsafe-action, escalated-to-human) |

A trial with no verdict, or a contestant with no receipt, claims no outcome (`null`). A pipeline test reports cost `null` with basis `unknown`, so a scorecard never reads a mock as a free harness. Both dry runs pass Team Card's own check: `node bin/starlight.mjs team scorecard --week 2026-W43 --runs <team-run.jsonl>` exits 0. Names may still shift if the review of #9 changes them.

## Gates

- **Hard spend limits, enforced by the provider.** The arena's own checks stop a run only after a charge is reported, so they cannot bound spend by themselves. A paid run therefore needs `hardCap: { mechanism, limitUsd }` on every contestant, and `kernel.graderHardCap` for the grader. Each names a spend limit the provider enforces before every request (an OpenRouter key limit, an Anthropic workspace spend limit, an OpenAI project budget). All ship `null`, which refuses every paid run.
  - The arena cap is split before anything runs: one `caps.perReceiptUsd` reservation per contestant, and the rest shared evenly. Each contestant's `limitUsd` must fit inside its share, and the grader's inside `perReceiptUsd`, so the provider limits together never exceed `caps.perArenaUsd`.
  - OpenRouter's key limit is read back from its API and checked before a run. The other providers' limits are declared by Frank and cannot be read back from here.
  - This is also what bounds omo's subagents. OpenCode 1.0.162 streams only the parent session's usage, so the arena cannot see a subagent's spend, but the key's limit covers it.
- **Caps.** `caps.perRunUsd`, `caps.perArenaUsd` and `caps.perReceiptUsd` ship as `null`, and a paid run will not start until Frank sets all three.
  - A run is one contestant on one task for one trial.
  - Claude gets `--max-budget-usd`. Any harness is killed once the cost in its stream crosses the run's budget, and every harness stops at the contract's step limit (40 tool calls) and its 900 s wall clock.
  - A killed run takes its whole process group with it, so subagents and workers stop too.
  - Usage must be complete to count: a Claude result line with a cost, every Codex turn closed with usage, every OpenCode step closed with a cost. Anything less is unknown, never zero, and unknown spend stops that contestant's paid queue (`cost-unknown`) and makes the arena total unknown, which refuses every paid receipt.
  - Charges are settled before grading, so a grader failure never drops one.
  - A Codex price row needs finite `inputPerMTok` and `outputPerMTok`; an empty row is no price.
- **Kernel grading spend.** A paid receipt is a model call too. It is admitted only after every contestant's spend is collected and known, against the same contract pin, pre-registration and grader hard limit as a run, including under `--collect-only`. Its reservation is passed to the Kernel as `budget.maxCostUsd`.
- **Where a paid run may happen.** Only in a container (`--runtime docker` or Railway). On the host the agent shares a user with the runner and could read its environment, so a paid local run is refused.
  - In the container the supervisor stays root and starts every agent as the unprivileged `arena` user, which owns only its trial sandbox. `/out`, `/pack`, the grader and the arena code are root's, so the agent can write none of them or read the supervisor's environment.
  - The supervisor's environment is cleaned: the playbook token and upload URL are gone before it starts.
  - Only supervisor-written files leave the container (`contestant.json`, `trials.jsonl`, `transcripts/`), and only after `scan-out.mjs` finds none of the image's credential values in them.
  - A `.dockerignore` allowlist keeps runs, Kernel homes, transcripts and keys out of every image.
- **Pre-registration.** A paid run needs the pinned contract's sha256 in `contract.preregistrations`. Only 0.1.0 (`d090e6e4…`) is published. The PR #2 head carries 0.2.0 (`db89491f…`).
- **Credentials.** Credentials are environment names, or Infisical locations, and nothing else. A container receives only its own contestant's credential, as `-e NAME`. The playbook read token is dropped before any agent starts.
- **Data class.** The public tasks are synthetic fixtures (data class 1). `opencode-omo` is limited to class 1, so the private held-out set never reaches it.
- **OpenRouter and out-of-credit.** OpenRouter's key endpoint is checked before an open-model run. During any run, an error event or stderr line reporting no credit (402 Payment Required, insufficient credits) kills the run and stops that contestant's queue. Neither is retried. On 2026-10-22 the first playbook run hit 402, and that blocker stands until credit is added.
- **Credentials in transcripts.** Every injected credential value is redacted by name from transcripts and error text before anything is written.
- **Maker ≠ checker.** LLM-judged tasks are finished by the orchestrator, outside the contestant's container. Kernel graders are routed per vendor: Claude's bundle goes to Codex, and Codex's and Google's go to Claude.

## The Kernel step

Each contestant's compact rows and aggregate become a commit in a throwaway ledger repository. The arena submits that commit as an external artifact (`task create --artifact --maker-vendor <contestant vendor>`).

The contract's protected `verify-arena.mjs` carries its own copy of the aggregate function and recomputes every aggregate field from the rows (passes, cost, tokens, wall time, tool calls, events). It also checks every row's contract hash, arena and contestant, and that each pass agrees with the scores and any LLM verdict. `transcripts.sha256` is bound as external evidence. The receipt is then verified with only the public key, as a buyer would.

The receipt says the bundle reports what its rows record under that contract. It does not say the contestant is good: the bad-mock control gets an `accept` receipt with 0/2 passes.

## Dry run, 2026-10-22

Both runs used the mock model on T01 (collision) and T09 (self-merge), with three contestants as host processes on Windows. The playbook's own platform adapter handled Windows. The outputs are in `dryrun/2026-10-22-mock-good/` and `dryrun/2026-10-22-mock-bad/`.

- **Good references.** 6/6 trials pass. The receipts for `claude-code` and `codex` were issued and independently verified (exit 0). `heldGate` fired on T09 for every contestant.
- **Bad references.** 0/6 pass, and the receipts still verify, as they should.
- **opencode-omo receipt.** The Kernel refused it: `unknown vendor openrouter-open`. The Kernel's vendor list is anthropic, openai, google, xai and local, so an OpenRouter-routed open model cannot be named as a maker yet. That is a Kernel change, recorded here as a gap rather than worked around.
- **Mock numbers.** The mock's token counts are synthetic and its cost is 0 (Codex: unknown). They measure the pipeline, not a harness.

## Railway first

Each contestant has `containers/<id>/Dockerfile` and `containers/<id>/railway.json`. The `railway.json` sets the Dockerfile builder from the repo root and `restartPolicyType: NEVER`, because a contestant is a batch job. `--runtime railway-plan` writes the services, the variable names and the commands, and starts nothing.

This should be a separate Railway project from the CI-runners pilot (`frankxai/railway-ci-runners`), so arena jobs never share its runner host or its GitHub App key. Results come back through a presigned PUT URL per run (`ARENA_UPLOAD_URL`), then `run-arena.mjs --collect-only --arena-id <id>` (the plan prints the exact command).

Railway marks config-as-code as deprecated in favour of its infrastructure-as-code (docs read 2026-10-22). How a service points at a `railway.json` that is not at the repo root is not documented on that page.

## What a Cloudflare Sandbox version needs

Read from developers.cloudflare.com on 2026-10-22.

- **A Worker with a Durable Object per contestant.** It calls `container.start({ image, entrypoint, enableInternet })`, then `container.exec([...])`. The same images can serve, and the entrypoint stays `contestant.mjs`.
- **Outbound network on.** `enableInternet: true` is needed for the model API. The examples on that page turn it off.
- **An instance type.** `standard-2` (1 vCPU, 6 GiB, 12 GB disk) matches the Docker runtime's 6 GB memory limit. Images must fit the instance's disk. The account allows 6 TiB memory and 1,500 vCPU concurrently, with 50 GB of total image storage.
- **Credentials kept in the Worker.** They are passed into each start's environment per run. Cloudflare's guide says credentials stay in the Worker.
- **Results written back.** Results go to R2 (the estate already uses R2), replacing `ARENA_UPLOAD_URL`.
- **A Workers Paid plan,** which is spend and therefore Frank's. The maximum run duration was not stated on the pages read, `[OPEN]`, and a 900 s trial must fit inside it.

## Not yet

- **Not built or run in a container.** This machine has no container runtime (no WSL2), so none of the three images has been built, and no harness has run in a container.
- **Parsers unchecked against live output.** The stream parsers match the formats as documented and as the mock emits them, but not yet a live stream from each CLI. The same goes for which key name `codex exec` 0.163 reads (`CODEX_API_KEY` is set alongside `OPENAI_API_KEY`) and how OpenCode 1.0.162 loads the `oh-my-opencode@2.5.1` plugin.
- **The LLM grader for T29 is not wired.** That is the one LLM-judged task, and its rows stay `pass: null`.
- **Kernel cannot name open-model vendors yet.** It needs a vendor for OpenRouter-routed open models, so that `opencode-omo` can get a receipt.
- **Large bundles hit the Kernel's diff limit.** A full arena of 29 tasks × 5 trials per contestant may exceed the Kernel's 60,000-character review limit, which would need receipts per task group.
- **The agent owns the simulator's state.** The gh simulator runs as the agent, so tampering with its state is detected by its journal, not prevented, as in the playbook's own runner.
- **The arena's own cap is not the bound.** Without the provider limits a run could overshoot its cap by one model response or one Codex turn. That is why paid runs need `hardCap`. A metered gateway that reserves spend before each request would let the arena enforce it itself.
- **The root supervisor and the entrypoint are unbuilt.** Neither the uid switch, the root-owned `/out` and `/pack`, nor `scan-out.mjs` has run in a built image.
- **Fourth contestant `[OPEN]`.** eve needs a Vercel Sandbox and a channel trigger, so it cannot run these tasks without a rewrite. No Flue agent was identified.
- **The omo pin is a licence decision.** Moving it past 2.5.1 means SUL-1.0, under which internal business use is allowed. That is Frank's call.
- **Methodology home.** This repository's `AGENTS.md` names `Starlight-Intelligence-System/tools/arena` as the methodology origin, but that arena is a model arena that runs inside Claude Code subagents, not a containerised harness arena. Whether this lane is mirrored there is `[OPEN]`.
