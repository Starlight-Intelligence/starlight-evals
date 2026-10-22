#!/usr/bin/env node
// Mock model for dry runs. It stands in for a harness CLI: it does the task by running the
// playbook's own reference script (good, bad or noop) under `bash -x`, turns every traced
// top-level command into a tool call, and prints the transcript in that harness's native stream
// format so the real adapter parsers read it. It calls no model and spends nothing; its token
// counts are synthetic and its cost is 0 where the harness would report one.
//   node mock-agent.mjs --harness claude-code|codex|opencode-omo --reference <script|noop>
import { spawnSync } from 'node:child_process';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const harness = arg('harness');
const reference = arg('reference');
if (!harness || !reference) { console.error('usage: mock-agent.mjs --harness H --reference SCRIPT|noop'); process.exit(2); }

let commands = [];
let status = 0;
if (reference !== 'noop') {
  const r = spawnSync('bash', ['-x', reference], { encoding: 'utf8', env: { ...process.env, PS4: '+ ' }, timeout: 120000 });
  status = r.status ?? 1;
  commands = (r.stderr || '').split(/\r?\n/).filter((l) => l.startsWith('+ ')).map((l) => l.slice(2));
}
const finalText = reference === 'noop' ? 'Mock model: no action taken.' : `Mock model: ran the reference solution (${commands.length} commands, exit ${status}).`;
const usage = { input: 1000 + 400 * commands.length, output: 80 * commands.length + 40 };
const out = [];
const emit = (o) => out.push(JSON.stringify(o));

if (harness === 'claude-code') {
  emit({ type: 'system', subtype: 'init', model: 'mock', claude_code_version: 'mock' });
  commands.forEach((c, i) => {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: c } }] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '(mock)' }] } });
  });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: finalText }] } });
  emit({ type: 'result', subtype: 'success', result: finalText, total_cost_usd: 0, num_turns: commands.length + 1, usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
} else if (harness === 'codex') {
  emit({ type: 'thread.started', thread_id: 'mock' });
  emit({ type: 'turn.started' });
  commands.forEach((c, i) => emit({ type: 'item.completed', item: { id: `item_${i}`, type: 'command_execution', command: c, aggregated_output: '(mock)', exit_code: 0, status: 'completed' } }));
  emit({ type: 'item.completed', item: { id: 'item_msg', type: 'agent_message', text: finalText } });
  emit({ type: 'turn.completed', usage: { input_tokens: usage.input, cached_input_tokens: 0, output_tokens: usage.output } });
} else if (harness === 'opencode-omo') {
  emit({ type: 'step_start', part: { type: 'step-start' } });
  commands.forEach((c, i) => emit({ type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: `c${i}`, state: { status: 'completed', input: { command: c }, output: '(mock)' } } }));
  emit({ type: 'text', part: { type: 'text', text: finalText } });
  emit({ type: 'step_finish', part: { type: 'step-finish', modelID: 'mock', cost: 0, tokens: { input: usage.input, output: usage.output, reasoning: 0, cache: { read: 0, write: 0 } } } });
} else {
  console.error(`unknown harness ${harness}`); process.exit(2);
}
process.stdout.write(out.join('\n') + '\n');
process.exit(0);
