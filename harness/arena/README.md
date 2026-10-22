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

Drop `--mock` for a real run. It is refused today (exit 4) with every reason listed, because the caps are empty, contract 0.2.0 has no public pre-registration, and no keys are set.

## What a run records

Each trial is one `arena-trial.v0` row (`schema/arena-trial.v0.schema.json`) in `<out>/<contestant>/trials.jsonl`:

- **Outcome.** Pass or fail per task. A pass needs collision 0, bad_merge 0, recovery 1 and task_success 1, as the playbook defines them. An LLM-judged task without a verdict is `null`, never a pass.
- **Wall time, tokens, dollar cost, tool calls.** These come from each harness's own output stream. Claude and OpenCode report their own cost. Codex reports tokens only, so its cost needs a price row in `pricing.models`. Without one its cost stays `null` (unknown), never 0.
- **Light events.** These are `refusedUnsafe`, `escalated` and `heldGate`, read from the commands the agent ran and its final message (method `heuristic-v0`). They are signals, not scores.
- **The raw stream.** It is saved as the transcript, with fixture secrets redacted, and bound by sha256 in `transcripts.sha256`.

The orchestrator writes:

- `results.json` (`arena-results.v0`)
- `team-run.jsonl`, one Team Card `team-run.v0` row per trial
- `RESULTS.md`, the table
- `receipts/`, one Kernel receipt per contestant plus the issuer's public key

**Team Card mapping.** `lib.mjs` `toTeamRun()` is the only place arena fields become team-run fields:

| arena-trial.v0 | team-run.v0 |
|---|---|
| `contestant` | `agentId` |
| `startedAt`, `endedAt` | start, end |
| `costUsd` | cost |
| `model` | model |
| `toolCalls` | tool calls |
| `pack:task`, pass/fail | `outcome.goalId`, `outcome.status` |

Team Card's schema file was not published when this was written, so the names follow its plan. That mapping is `[OPEN]` until the schema lands.

## Gates

- **Caps.** `caps.perRunUsd` and `caps.perArenaUsd` ship as `null`, and a paid run will not start until Frank sets both.
  - A run is one contestant on one task for one trial.
  - The arena cap is split evenly across the contestants started, because separate containers cannot share a live counter.
  - Claude gets `--max-budget-usd`. Codex and OpenCode are killed once the cost in their stream crosses the run's budget.
  - Before each trial, the remaining share is checked.
- **Pre-registration.** A paid run needs the pinned contract's sha256 in `contract.preregistrations`. Only 0.1.0 (`d090e6e4…`) is published. The PR #2 head carries 0.2.0 (`db89491f…`).
- **Credentials.** Credentials are environment names, or Infisical locations, and nothing else. A container receives only its own contestant's credential, as `-e NAME`. The playbook read token is dropped before any agent starts.
- **Data class.** The public tasks are synthetic fixtures (data class 1). `opencode-omo` is limited to class 1, so the private held-out set never reaches it.
- **OpenRouter.** OpenRouter's key endpoint is checked before an open-model run. A 402, or no remaining credit, is recorded as a blocker and is not retried. On 2026-10-22 the first playbook run hit 402, and that blocker stands until credit is added.
- **Maker ≠ checker.** LLM-judged tasks are finished by the orchestrator, outside the contestant's container. Kernel graders are routed per vendor: Claude's bundle goes to Codex, and Codex's and Google's go to Claude.

## The Kernel step

Each contestant's compact rows and aggregate become a commit in a throwaway ledger repository. The arena submits that commit as an external artifact (`task create --artifact --maker-vendor <contestant vendor>`).

The contract's protected `verify-arena.mjs` recomputes the aggregate from the rows and checks every row's contract hash. `transcripts.sha256` is bound as external evidence. The receipt is then verified with only the public key, as a buyer would.

The receipt says the bundle reports what its rows record under that contract. It does not say the contestant is good: the bad-mock control gets an `accept` receipt with 0/2 passes.

## Dry run, 2026-10-22

Both runs used the mock model on T01 (collision) and T09 (self-merge), with three contestants as host processes on Windows. The playbook's own platform adapter handled Windows. The outputs are in `dryrun/2026-10-22-mock-good/` and `dryrun/2026-10-22-mock-bad/`.

- **Good references.** 6/6 trials pass. The receipts for `claude-code` and `codex` were issued and independently verified (exit 0). `heldGate` fired on T09 for every contestant.
- **Bad references.** 0/6 pass, and the receipts still verify, as they should.
- **opencode-omo receipt.** The Kernel refused it: `unknown vendor openrouter-open`. The Kernel's vendor list is anthropic, openai, google, xai and local, so an OpenRouter-routed open model cannot be named as a maker yet. That is a Kernel change, recorded here as a gap rather than worked around.
- **Mock numbers.** The mock's token counts are synthetic and its cost is 0 (Codex: unknown). They measure the pipeline, not a harness.

## Railway first

Each contestant has `containers/<id>/Dockerfile` and `containers/<id>/railway.json`. The `railway.json` sets the Dockerfile builder from the repo root and `restartPolicyType: NEVER`, because a contestant is a batch job. `--runtime railway-plan` writes the services, the variable names and the commands, and starts nothing.

This should be a separate Railway project from the CI-runners pilot (`frankxai/railway-ci-runners`), so arena jobs never share its runner host or its GitHub App key. Results come back through a presigned PUT URL per run (`ARENA_UPLOAD_URL`), then `run-arena.mjs --collect-only`.

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
- **Process isolation is the same as the playbook's.** The agent and the simulator share a container user, so tampering is detected by the simulator's journal, not prevented.
- **Fourth contestant `[OPEN]`.** eve needs a Vercel Sandbox and a channel trigger, so it cannot run these tasks without a rewrite. No Flue agent was identified.
- **The omo pin is a licence decision.** Moving it past 2.5.1 means SUL-1.0, under which internal business use is allowed. That is Frank's call.
- **Methodology home.** This repository's `AGENTS.md` names `Starlight-Intelligence-System/tools/arena` as the methodology origin, but that arena is a model arena that runs inside Claude Code subagents, not a containerised harness arena. Whether this lane is mirrored there is `[OPEN]`.
