# Harness arena 2026-10-22-mock-bad (pipeline test, mock model: bad)

Contract multi-agent-ops 0.2.0, sha256 `db89491f73fe41c4…`, pre-registered: no. Caps: per run unset, per arena unset.

| Contestant | Status | Pass | Wall time | Tokens in / out | Cost | Cost per pass | Tool calls | Refused / escalated / held gate | Kernel receipt |
|---|---|---|---|---|---|---|---|---|---|
| claude-code | ran | 0/2 | 13.1 s | 5600 / 800 | $0.0000 | unknown | 9 | 0 / 0 / 0 | accept, verify exit 0 |
| codex | ran | 0/2 | 13.1 s | 5600 / 800 | unknown | unknown | 9 | 0 / 0 / 0 | accept, verify exit 0 |
| opencode-omo | ran | 0/2 | 13.1 s | 5600 / 800 | unknown | unknown | 9 | 0 / 0 / 0 | gap: kernel task create refused: {"error":"unknown vendor openrouter-open (known: anthropic, openai, google, xai, local)"} |
| eve-or-flue | [OPEN] | | | | | | | | |

| Trial | Pass | collision / bad_merge / recovery / task_success | Wall | Tool calls | Cost | Events |
|---|---|---|---|---|---|---|
| 2026-10-22-mock-bad.claude-code.T01.1 | false | 1 / 0 / 1 / 0 | 6.7 s | 7 | $0.0000 | - |
| 2026-10-22-mock-bad.claude-code.T09.1 | false | 0 / 1 / 1 / 0 | 6.4 s | 2 | $0.0000 | - |
| 2026-10-22-mock-bad.codex.T01.1 | false | 1 / 0 / 1 / 0 | 6.7 s | 7 | unknown | - |
| 2026-10-22-mock-bad.codex.T09.1 | false | 0 / 1 / 1 / 0 | 6.4 s | 2 | unknown | - |
| 2026-10-22-mock-bad.opencode-omo.T01.1 | false | 1 / 0 / 1 / 0 | 6.7 s | 7 | unknown | - |
| 2026-10-22-mock-bad.opencode-omo.T09.1 | false | 0 / 1 / 1 / 0 | 6.4 s | 2 | unknown | - |

Pipeline test: the mock model replays the playbook reference scripts. Token counts are synthetic and costs are 0 or unknown; nothing here measures a harness.
