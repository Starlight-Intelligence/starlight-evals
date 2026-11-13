import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRAPH_PATH = 'C:/Users/frank/starlight/graph/skills.graph.json';
const SKILL_PATH = 'C:/Users/frank/.config/kilo/skills/skill-router/SKILL.md';
const CASES_DIR = path.join(__dirname, 'cases');

const PAID_METERED = new Set(['firecrawl', 'apify', 'bright-data', 'semrush', 'clay', 'openart-cli', 'make']);

function readJSON(p) { return JSON.parse(readText(p)); }
function readText(p) { let t=fs.readFileSync(p,'utf8'); if (t.charCodeAt(0)===0xFEFF) t=t.slice(1); return t; }

function loadCases() {
  const files = fs.readdirSync(CASES_DIR).filter(f => f.endsWith('.jsonl')).sort();
  const cases = [];
  for (const f of files) {
    const lines = readText(path.join(CASES_DIR, f)).split(/\r?\n/).filter(Boolean);
    for (const line of lines) cases.push(JSON.parse(line));
  }
  return cases;
}

function loadSkillSlugs() {
  const g = readJSON(GRAPH_PATH);
  const set = new Set((g.skills || []).map(s => s.name));
  const byResolved = (g.skills || []).filter(s => s.resolvedBy && s.resolvedBy !== 'unique');
  return { set, graph: g, duplicates: byResolved };
}

function extractRules(skillText) {
  const rules = [];
  const add = (id, desc, cite) => rules.push({ id, desc, cite });
  add('max-load-3', 'Load 1-3 skills; never 4+', 'SKILL.md:27,57,102');
  add('zero-extra-for-simple', '0 extra for status/yes-no/one-line fact', 'SKILL.md:54');
  add('classify-6', 'Classify as code|research|design|content|ops|question', 'SKILL.md:64');
  add('default-load-table', 'Pick from default load table, not catalog', 'SKILL.md:66-78');
  add('explicit-si-wins', 'Explicit /si wins over table; same front door', 'SKILL.md:30,76');
  add('improve-prompt-card', 'Rewrite ask into card before tools; keep user words; fill gaps without inventing scope', 'SKILL.md:80-93');
  add('no-swarm-theater', 'Treating /si as spawn a swarm is anti-pattern', 'SKILL.md:108');
  add('no-find-skills-every-turn', 'find-skills only when capability missing', 'SKILL.md:75,109');
  add('hooks-deterministic', 'Hooks must stay deterministic, no extra LLM/network, fail open, <=3 skills', 'SKILL.md:102');
  add('anti-catalog-dump', 'Do not pick from catalog / dump catalog', 'SKILL.md:27,66');
  return rules;
}

function classifyFromText(input) {
  const t = input.toLowerCase();
  if (/^\/si\b/.test(t) || /\b\/si\b/.test(t)) return 'si-explicit';
  if (/deep\s*research|research|cite\s+sources|investigate|literature/.test(t)) return 'research';
  if (/design|ui|ux|landing|hero|layout|premium.*page|redesign/.test(t)) return 'design';
  if (/\b(fix|refactor|implement|bug|test|code|function|module|parse\.ts)\b/.test(t)) return 'code';
  if (/content|blog|newsletter|write.*post|copy|social/.test(t)) return 'content';
  if (/audit|skill estate|install|ops|deploy|pipeline|configure|which.*skill.*load/.test(t)) return 'ops';
  return 'question';
}

function staticVerdictForCase(c, rules, graphInfo) {
  const inp = c.input;
  const cls = classifyFromText(inp);
  let impliedLoads = [];
  let impliedRefuses = [];
  let notes = [];
  let pass = true;
  let failures = [];

  // embedded instruction / injection: treat as data (do not execute "load every skill")
  if (/ignore all previous|load every skill/i.test(inp)) {
    notes.push('injection-like text present; treat as data per contract posture');
    impliedLoads = [];
    cls === 'question' || null;
  }

  if (cls === 'question') {
    impliedLoads = [];
  } else if (cls === 'code') {
    impliedLoads = ['superpowers'];
  } else if (cls === 'research') {
    impliedLoads = ['deepresearch', 'source-backed-research'];
  } else if (cls === 'design') {
    impliedLoads = ['impeccable', 'web-design-guidelines'];
  } else if (cls === 'ops' && /^\/si\b|\s\/si\b/i.test(inp)) {
    impliedLoads = [];
    notes.push('/si explicit wins (SKILL.md:30,76)');
  } else if (cls === 'ops') {
    // table: ops/skills/install -> none by default unless installing/moving
    if (/install|moving skills/i.test(inp)) impliedLoads = ['skill-portfolio-ops'];
    else impliedLoads = [];
  } else if (cls === 'content') {
    impliedLoads = ['content-strategy'];
  }

  // specific case refinements from text
  if (/ambiguous|make this better/i.test(inp) && !/target|file|page/.test(inp.toLowerCase())) {
    impliedLoads = [];
    notes.push('AMBIGUOUS: no target/done-condition; avoid false precision (SKILL.md:80,93)');
  }
  if (/acos-meta/i.test(inp)) {
    impliedLoads = ['acos-meta'];
    notes.push('acos-meta resolvedBy catalog-over-internal-pack in graph (real duplicate name resolution case)');
  }

  // checks against expectations
  const checks = [];
  const exp = c.expect || {};
  // (a) max loads
  if (impliedLoads.length > 3) { pass = false; failures.push('max-load-exceeded'); checks.push({name:'max-load', pass:false}); }
  else checks.push({name:'max-load', pass:true});
  // classification sanity
  const clsMap = { 'si-explicit':'ops' };
  const effCls = clsMap[cls] || cls;
  const clsOk = !exp.classification || effCls === exp.classification || (exp.classification==='ops' && cls==='si-explicit');
  checks.push({name:'classification', pass: clsOk, implied: effCls, expected: exp.classification});
  if (!clsOk) { /* not a hard fail in static text parse but record */ }
  // loads match subset expectation (allow minor variance but check max and paid/refuse)
  const loadsOk = JSON.stringify([...impliedLoads].sort()) === JSON.stringify([...(exp.loads||[])].sort());
  checks.push({name:'loads-match', pass: loadsOk, implied: impliedLoads, expected: exp.loads||[]});
  // paid connector refusal
  const paidUsed = impliedLoads.filter(s => PAID_METERED.has(s));
  const paidOk = paidUsed.length === 0;
  checks.push({name:'no-paid-when-free', pass: paidOk, impliedPaid: paidUsed});
  if (!paidOk) { pass = false; failures.push('paid-when-free'); }

  return {
    caseId: c.id,
    provider: 'static',
    implied: { classification: effCls, loads: impliedLoads },
    checks,
    failures,
    pass: failures.length === 0 && clsOk && loadsOk,
    proves: 'Deterministic parse of SKILL.md text rules as extracted (max load, default table routing, explicit /si, basic class mapping, injection treated as data heuristically).',
    does_not_prove: 'Actual model/harness routing behavior, runtime tool availability, dynamic hook behavior, nuanced ambiguity handling, or correctness of loaded skill content.'
  };
}

export function gradeOutput(output, c, graphInfo) {
  const { set: validSlugs } = graphInfo;
  const loads = Array.isArray(output.loads) ? output.loads : [];
  const exp = c.expect || {};
  const results = [];
  const add = (name, ok, detail) => results.push({ name, pass: !!ok, detail });

  // (a) loads more than max
  add('max-load', loads.length <= 3, { loads: loads.length, max: 3 });
  // (b) loads slug in expect.refuses
  const refused = (exp.refuses || []).filter(r => loads.includes(r));
  add('no-refused-slug', refused.length === 0, { refused: refused });
  // (c) names slug absent from graph
  const nonexistent = loads.filter(s => !validSlugs.has(s));
  add('nonexistent-skill', nonexistent.length === 0, { nonexistent });
  // (d) paid/metered connector when case expects built-in (refuses contains paid or case is deep-research no-paid)
  const paidLoaded = loads.filter(s => PAID_METERED.has(s));
  const expectsNoPaid = (exp.refuses || []).some(r => PAID_METERED.has(r)) || /research/i.test(c.id) || /deep-research/i.test(c.id);
  const paidFail = expectsNoPaid ? paidLoaded.length > 0 : false;
  add('paid-when-free', !paidFail, { paidLoaded, expectsNoPaid });
  // (e) duplicate slug
  const seen = new Set();
  const dups = [];
  for (const s of loads) { if (seen.has(s)) dups.push(s); seen.add(s); }
  add('duplicate-load', dups.length === 0, { duplicates: dups });
  // (f) ambiguous ask routed to specific skill without asking
  const isAmbiguous = c.id === 'case-04-ambiguous' || /ambiguous/i.test(c.why || '');
  const falsePrecision = isAmbiguous && loads.length > 0 && !output.askedClarification;
  add('false-precision', !falsePrecision, { isAmbiguous, loads, askedClarification: !!output.askedClarification });

  const hardFailures = results.filter(r => !r.pass).map(r => r.name);
  return { caseId: c.id, input: c.input, loads, results, pass: hardFailures.length === 0, hardFailures };
}

function main() {
  const cases = loadCases();
  const graphInfo = loadSkillSlugs();
  const skillText = readText(SKILL_PATH);
  const rules = extractRules(skillText);

  // Static analysis: implied verdict per case from SKILL.md
  const staticAnalysis = {
    provider: 'static',
    skillPath: SKILL_PATH,
    rulesExtracted: rules,
    cases: cases.map(c => staticVerdictForCase(c, rules, graphInfo))
  };
  staticAnalysis.summary = {
    total: staticAnalysis.cases.length,
    pass: staticAnalysis.cases.filter(c => c.pass).length,
    fail: staticAnalysis.cases.filter(c => !c.pass).length
  };

  // Grade the IDEAL router output (expect.loads) per case. This validates the
  // harness logic and proves the contract is satisfiable. It is NOT evidence that
  // any model routes correctly -- only `live` runs are.
  const caseGrades = cases.map(c => {
    const output = { loads: c.expect.loads, askedClarification: c.expect.loads.length === 0 && c.id === 'case-04-ambiguous' };
    return gradeOutput(output, c, graphInfo);
  });

// Fixture grading. With an explicit fixture path argument, grade that one
  // fixture only (legacy single-fixture behaviour). With no argument, grade
  // EVERY fixture in fixtures/ — each is a negative control that must FAIL.
  const fixtureDir = path.join(__dirname, 'fixtures');
  const fixtureFiles = fs.readdirSync(fixtureDir).filter(f => f.endsWith('.json')).sort();
  const fixturePaths = process.argv[2]
    ? [process.argv[2]]
    : fixtureFiles.map(f => path.join(fixtureDir, f));

  const fixtureGrades = [];
  for (const fixturePath of fixturePaths) {
    if (!fs.existsSync(fixturePath)) continue;
    const fixture = readJSON(fixturePath);
    const targetCase = cases.find(c => c.id === fixture.caseId) || cases[0];
    const g = gradeOutput(fixture, targetCase, graphInfo);
    g.fixturePath = fixturePath;
    fixtureGrades.push(g);
  }
  const fixtureGrade = fixtureGrades[0] || null;

const scorecard = {
    generatedAt: new Date().toISOString(),
    casesTotal: cases.length,
    caseGrades,
    staticAnalysisSummary: staticAnalysis.summary,
    fixtureGrades,
    fixtureGrade,
    anyHardFailure: caseGrades.some(g => !g.pass) || fixtureGrades.some(g => g.pass)
  };

  fs.writeFileSync(path.join(__dirname, 'static-analysis.json'), JSON.stringify(staticAnalysis, null, 2));
  fs.writeFileSync(path.join(__dirname, 'scorecard.json'), JSON.stringify(scorecard, null, 2));

  const md = [];
  md.push('# Skill Router Eval Scorecard');
  md.push(`Generated: ${scorecard.generatedAt}`);
  md.push('');
  md.push(`Cases: ${cases.length}`);
  md.push('');
  md.push('## Harness self-check (ideal output graded against expectations)');
  md.push('');
  md.push('These rows prove the checks are satisfiable and the contract is internally');
  md.push('consistent. They are NOT evidence that any model routes correctly.');
  md.push('');
  for (const g of caseGrades) {
    md.push(`- ${g.caseId}: ${g.pass ? 'PASS' : 'FAIL'}${g.hardFailures.length ? ' ['+g.hardFailures.join(', ')+']' : ''}`);
  }
  md.push('');
  md.push(`Harness self-check: ${caseGrades.filter(g=>g.pass).length}/${caseGrades.length} pass`);
  md.push('');
  md.push(`Static analysis (SKILL.md-implied): ${staticAnalysis.summary.pass}/${staticAnalysis.summary.total} pass, ${staticAnalysis.summary.fail} fail`);
  md.push('');
  md.push('## Negative control (broken router output must FAIL)');
  md.push('');
  md.push('Each fixture is a deliberately-broken router output. A fixture that');
  md.push('PASSES means the check it is meant to prove is dead.');
  md.push('');
  for (const g of fixtureGrades) {
    const name = path.basename(g.fixturePath || '');
    md.push(`- ${name} (${g.caseId}): ${g.pass ? 'UNEXPECTED PASS — CHECK DEAD' : 'FAIL as expected'} [${g.hardFailures.join(', ')}]`);
  }
  md.push('');
  const unexpectedPasses = fixtureGrades.filter(g => g.pass);
  md.push(`Negative controls: ${fixtureGrades.length} run, ${fixtureGrades.filter(g => !g.pass).length} failed as expected, ${unexpectedPasses.length} unexpected pass(es).`);
  md.push('');
  md.push('## Live runs');
  md.push('');
  md.push('- live: NOT RUN. No zero-marginal-cost model path was available in this session.');
  md.push('  This scorecard proves the checks fire and the contract is satisfiable. It does');
  md.push('  NOT prove any model obeys skill-router. A `live` provider row is required for that.');
  fs.writeFileSync(path.join(__dirname, 'scorecard.md'), md.join('\n'));

// Print fixture failure prominently when run on fixture
  if (process.argv[2] && fixtureGrades.length === 1) {
    const f = fixtureGrades[0];
    if (!f.pass) {
      console.error(JSON.stringify({ exit: 1, fixture: f }, null, 2));
      process.exit(1);
    } else {
      console.log(JSON.stringify({ exit: 0, fixture: f }, null, 2));
      process.exit(0);
    }
  }

  // Default (no argument, or multiple fixtures): exit 1 if any case grade
  // fails OR any negative-control fixture unexpectedly PASSES.
  if (caseGrades.some(g => !g.pass)) process.exit(1);
  if (fixtureGrades.some(g => g.pass)) process.exit(1);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
