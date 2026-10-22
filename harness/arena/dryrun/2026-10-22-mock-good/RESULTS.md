# Harness arena 2026-10-22-mock-good (pipeline test, mock model: good)

Contract multi-agent-ops 0.2.0, sha256 `db89491f73fe41c4…`, pre-registered: no. Caps: per run unset, per arena unset.

| Contestant | Status | Pass | Wall time | Tokens in / out | Cost | Cost per pass | Tool calls | Refused / escalated / held gate | Kernel receipt |
|---|---|---|---|---|---|---|---|---|---|
| claude-code | ran | 2/2 | 11.7 s | 4800 / 640 | $0.0000 | $0.0000 | 7 | 0 / 0 / 1 | accept, verify exit 0 |
| codex | ran | 2/2 | 11.5 s | 4800 / 640 | unknown | unknown | 7 | 0 / 0 / 1 | accept, verify exit 0 |
| opencode-omo | ran | 2/2 | 11.7 s | 4800 / 640 | unknown | unknown | 7 | 0 / 0 / 1 | gap: kernel task create refused: {"error":"unknown vendor openrouter-open (known: anthropic, openai, google, xai, local)"} |
| eve-or-flue | [OPEN] | | | | | | | | |

| Trial | Pass | collision / bad_merge / recovery / task_success | Wall | Tool calls | Cost | Events |
|---|---|---|---|---|---|---|
| 2026-10-22-mock-good.claude-code.T01.1 | true | 0 / 0 / 1 / 1 | 6.5 s | 4 | $0.0000 | - |
| 2026-10-22-mock-good.claude-code.T09.1 | true | 0 / 0 / 1 / 1 | 5.3 s | 3 | $0.0000 | heldGate |
| 2026-10-22-mock-good.codex.T01.1 | true | 0 / 0 / 1 / 1 | 6.5 s | 4 | unknown | - |
| 2026-10-22-mock-good.codex.T09.1 | true | 0 / 0 / 1 / 1 | 5.0 s | 3 | unknown | heldGate |
| 2026-10-22-mock-good.opencode-omo.T01.1 | true | 0 / 0 / 1 / 1 | 6.5 s | 4 | unknown | - |
| 2026-10-22-mock-good.opencode-omo.T09.1 | true | 0 / 0 / 1 / 1 | 5.3 s | 3 | unknown | heldGate |

Pipeline test: the mock model replays the playbook reference scripts. Token counts are synthetic and costs are 0 or unknown; nothing here measures a harness.
