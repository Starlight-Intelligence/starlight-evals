// How each contestant harness starts headless, and how to read what it did from its own output
// stream. The parsers are fed by the mock in the dry run; their fit to each CLI's live output is
// unverified until the first paid run (README, "Not yet").

const lines = (text) => String(text).split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const num = (v) => (Number.isFinite(+v) ? +v : 0);

function empty() {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costUsd: null, toolCalls: 0, commands: [], finalText: '', model: null, harnessVersion: null };
}

export const ADAPTERS = {
  // claude -p --output-format stream-json: one JSON object per line; tool calls are tool_use blocks
  // inside assistant messages, and the closing "result" line carries the CLI's own cost and usage.
  'claude-code': {
    binary: 'claude',
    credentials: ['ANTHROPIC_API_KEY'],
    systemPromptDelivery: '--append-system-prompt',
    command({ model, systemPrompt, prompt, perRunUsd }) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
        '--no-session-persistence', '--strict-mcp-config', '--append-system-prompt', systemPrompt];
      if (model) args.push('--model', model);
      if (perRunUsd != null) args.push('--max-budget-usd', String(perRunUsd));
      return { cmd: 'claude', args, stdin: prompt };
    },
    parse(stdout) {
      const r = empty();
      for (const e of lines(stdout)) {
        if (e.type === 'system' && e.subtype === 'init') { r.model = e.model ?? r.model; r.harnessVersion = e.claude_code_version ?? r.harnessVersion; }
        if (e.type === 'assistant') {
          for (const b of e.message?.content ?? []) {
            if (b.type === 'tool_use') { r.toolCalls++; if (b.input?.command) r.commands.push(String(b.input.command)); }
            if (b.type === 'text' && b.text) r.finalText = b.text;
          }
        }
        if (e.type === 'result') {
          r.costUsd = e.total_cost_usd ?? null;
          const u = e.usage ?? {};
          r.tokens = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), reasoning: 0 };
          if (e.result) r.finalText = e.result;
        }
      }
      return r;
    },
  },

  // codex exec --json: JSONL thread/turn/item events. Usage arrives per turn and carries no cost,
  // so cost comes from the configured price table or stays unknown.
  codex: {
    binary: 'codex',
    credentials: ['OPENAI_API_KEY'],
    // The container is the sandbox, which is the case the bypass flag is documented for. Codex has no
    // system-prompt flag in exec mode, so the contract's system prompt leads the message.
    systemPromptDelivery: 'prepended to the prompt',
    command({ model, systemPrompt, prompt }) {
      const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--dangerously-bypass-approvals-and-sandbox'];
      if (model) args.push('-m', model);
      args.push('-');
      return { cmd: 'codex', args, stdin: `${systemPrompt}\n\n${prompt}` };
    },
    parse(stdout) {
      const r = empty();
      for (const e of lines(stdout)) {
        const item = e.item ?? {};
        if (e.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(item.type)) {
          r.toolCalls++;
          if (item.command) r.commands.push(String(item.command));
        }
        if (e.type === 'item.completed' && item.type === 'agent_message' && item.text) r.finalText = item.text;
        if (e.type === 'turn.completed') {
          const u = e.usage ?? {};
          r.tokens.input += num(u.input_tokens); r.tokens.cacheRead += num(u.cached_input_tokens); r.tokens.output += num(u.output_tokens); r.tokens.reasoning += num(u.reasoning_output_tokens);
        }
      }
      return r;
    },
  },

  // opencode run --format json: one event per line; tool_use parts are tool calls, and every
  // step_finish part carries tokens and the cost OpenCode computed for that step.
  'opencode-omo': {
    binary: 'opencode',
    credentials: ['OPENROUTER_API_KEY'],
    // "ultrawork" is the omo 2.5.1 keyword (/\b(ultrawork|ulw)\b/i) that switches Sisyphus into its
    // plan-prove-verify mode. OpenCode takes the message as an argument, not on stdin.
    systemPromptDelivery: 'prepended to the prompt',
    command({ model, systemPrompt, prompt }) {
      const args = ['run', '--format', 'json', '--agent', 'Sisyphus'];
      if (model) args.push('--model', model);
      args.push(`ultrawork\n\n${systemPrompt}\n\n${prompt}`);
      return { cmd: 'opencode', args, stdin: null };
    },
    parse(stdout) {
      const r = empty();
      let cost = 0; let sawCost = false;
      for (const e of lines(stdout)) {
        const p = e.part ?? {};
        if (e.type === 'tool_use' || p.type === 'tool') {
          r.toolCalls++;
          const cmd = p.state?.input?.command;
          if (cmd) r.commands.push(String(cmd));
        }
        if ((e.type === 'text' || p.type === 'text') && p.text) r.finalText = p.text;
        if (e.type === 'step_finish' || p.type === 'step-finish') {
          const t = p.tokens ?? {};
          r.tokens.input += num(t.input); r.tokens.output += num(t.output); r.tokens.reasoning += num(t.reasoning);
          r.tokens.cacheRead += num(t.cache?.read); r.tokens.cacheWrite += num(t.cache?.write);
          if (p.cost !== undefined) { cost += num(p.cost); sawCost = true; }
          if (p.modelID) r.model = p.modelID;
        }
      }
      r.costUsd = sawCost ? cost : null;
      return r;
    },
  },
};

/** Cost from the price table, for CLIs that report tokens but no cost. null when the model has no row. */
export function priceCost(pricing, model, tokens) {
  const p = pricing?.models?.[model];
  if (!p || !Number.isFinite(p.inputPerMTok) || !Number.isFinite(p.outputPerMTok)) return null;
  const cached = Number.isFinite(p.cachedInputPerMTok) ? p.cachedInputPerMTok : p.inputPerMTok;
  return ((tokens.input - tokens.cacheRead) * p.inputPerMTok + tokens.cacheRead * cached + (tokens.output + tokens.reasoning) * p.outputPerMTok) / 1e6;
}
