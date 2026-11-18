# Contributing to Starlight Evals

> This repo is a **published mirror** of the eval discipline that lives canonically
> in the [Starlight Intelligence System](https://github.com/frankxai/Starlight-Intelligence-System).
> The point isn't to consume our scorecards — it's to **run the discipline on your
> own system and publish your own.** That's the mission: help people build their own
> systems, not consume someone else's leaderboard.

## Fork & run in ~10 minutes

You don't need our infrastructure. The harness is a *usage pattern* on
[Claude Code](https://claude.com/claude-code) + plain files — no servers, no DB.

1. **Read `SPEC.md`** — the seven lanes and the scorecard contract.
2. **Pick one lane to start** — the **model lane** is the easiest entry: it's just
   dispatching the same task to two models and checking who got it right.
   - In a Claude Code session, spawn two subagents on the same prompt with different
     `model:` overrides, give them a *self-verifying* task (asserts, or a known
     answer), and record who passed. That's a round.
3. **Write a scorecard** following the JSON shape in `scorecards/` — every metric
   names its `sourceLane`, carries `caveats`, and (the important part) a **named
   weakness**. A green number without a named weakness is incomplete.
4. **Keep it honest** — the three rules that make this trustworthy:
   - *Mechanically verified beats judged.* Prefer asserts/ground-truth over a model
     judge. When you must judge, use a blind, non-contestant, ideally cross-family judge.
   - *Anti-Goodhart.* The scorecard describes your system; it is not a target.
   - *Staleness is visible.* Stamp `ranAt` / `nextRunDue`; show STALE when overdue.

## What we welcome

- **New lanes** — measure a dimension we don't (latency, cost-per-task, multi-turn
  agentic, long-context fidelity). Add it to `lanes.json` with an entrypoint.
- **Cross-family adapters** — run the model lane against GPT / Gemini / OSS models
  (via OpenRouter or direct) and contribute the round receipt.
- **Better ground-truth** — our memory lane is honest that its judge is lexical;
  semantic/labeled relevance sets are gold.
- **Your own scorecards** — open a PR adding a `scorecards/community/<you>-<date>.json`
  from running the discipline on your stack. We'd love a registry of these.

## What we won't merge

- Scorecards without receipts, caveats, or a named weakness.
- Results from a judge grading its own family with no note (state the bias).
- "Our model wins" framing without a `does-NOT-measure` honesty section.

## How to propose

Open an issue (methodology questions, new-lane proposals) or a PR (adapters,
scorecards, fixes). Substantive methodology changes get pressure-tested against the
same Board discipline the canonical repo uses — expect a "what would falsify this?"
question. That's a feature.

Canonical methodology + issues: the
[Starlight Intelligence System](https://github.com/frankxai/Starlight-Intelligence-System)
repo. This mirror tracks published results; methodology debates happen upstream.

### Reproduce a paired arena comparison

In one checkout, compare the published dry-run trial exports. Node 22+ is sufficient. This command reads two files and prints a JSON comparison. It uses no credentials, provider calls or network.

```sh
run=harness/arena/dryrun/2026-10-22-mock-good
node harness/arena/compare-trials.mjs --baseline "$run/claude-code/trials.jsonl" --candidate "$run/codex/trials.jsonl"
node --test harness/arena/test/compare-trials.test.mjs
```

The example has two paired mock tasks. Both contestants pass both. The report marks the pipeline test, suppresses dollar comparisons, and exposes differing fixture vendors. The fixtures establish that the integration works. They cannot rank the models.

For an external reproduction, state the checkout commit, publishable input digests, comparison, and one weakness in the existing scorecard submission. Share approved task identifiers only. Contributors can retain prompts, responses and raw customer traces locally. A maintainer can rerun the command against consented exports and compare both SHA-256 digests.

Pairing requires the same arena, contract, pack, task and repetition, with a single contestant configuration per file. Reordering is allowed. Missing or duplicated pairs fail the comparison. Check the planned run manifest separately: two exports can omit the same task. Different fixture vendors can produce different inputs for a shared task. A null vendor comparison means the export omitted that provenance. Inspect that flag before attributing a difference to a model. Digests identify the files compared; issuer authentication remains with the arena's receipt verifier.

For real trials the report includes spend on failed tasks in cost per pass, preserves unknown spend as null, and identifies the accounting source (including price-table estimates). Ungraded trials have their own paired count. Review each lost or unresolved task before proposing a route change. Submission and reproduction confer no production routing authority.

Built on SIP — Starlight Intelligence Protocol. Code MIT, methodology open.
