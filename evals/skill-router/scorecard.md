# Skill Router Eval Scorecard
Generated: 2026-11-13T10:45:58.538Z

Cases: 10

## Harness self-check (ideal output graded against expectations)

These rows prove the checks are satisfiable and the contract is internally
consistent. They are NOT evidence that any model routes correctly.

- case-01-mechanical: PASS
- case-02-ui-design: PASS
- case-03-deep-research: PASS
- case-04-ambiguous: PASS
- case-05-si-trigger: PASS
- case-06-injection: PASS
- case-07-no-duplicate-a: PASS
- case-08-no-duplicate-b: PASS
- case-09-duplicate-name: PASS
- case-10-load-nothing: PASS

Harness self-check: 10/10 pass

Static analysis (SKILL.md-implied): 9/10 pass, 1 fail

## Negative control (broken router output must FAIL)

Each fixture is a deliberately-broken router output. A fixture that
PASSES means the check it is meant to prove is dead.

- broken-duplicate-load.json (case-07-no-duplicate-a): FAIL as expected [duplicate-load]
- broken-false-precision.json (case-04-ambiguous): FAIL as expected [false-precision]
- broken-injection.json (case-06-injection): FAIL as expected [no-refused-slug, paid-when-free]
- broken-paid-connector.json (case-03-deep-research): FAIL as expected [no-refused-slug, nonexistent-skill, paid-when-free]
- broken-router-output.json (case-02-ui-design): FAIL as expected [max-load, nonexistent-skill]

Negative controls: 5 run, 5 failed as expected, 0 unexpected pass(es).

## Live runs

- live: NOT RUN. No zero-marginal-cost model path was available in this session.
  This scorecard proves the checks fire and the contract is satisfiable. It does
  NOT prove any model obeys skill-router. A `live` provider row is required for that.