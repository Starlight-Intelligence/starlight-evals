// How each contestant harness starts headless, and how to read what it did from its own output
// stream. The parsers are fed by the mock in the dry run; their fit to each CLI's live output is
// unverified until the first paid run (README, "Not yet").

const lines = (text) => String(text).split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const num = (v) => (Number.isFinite(+v) ? +v : 0);

function empty() {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costUsd: null, usageComplete: false, toolCalls: 0, tools: [], commands: [], finalText: '', model: null, harnessVersion: null };
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
            if (b.type === 'tool_use') { r.toolCalls++; r.tools.push({ name: b.name, id: b.id }); if (b.input?.command) r.commands.push(String(b.input.command)); }
            if (b.type === 'text' && b.text) r.finalText = b.text;
          }
        }
        if (e.type === 'result') {
          // Accounting is complete only when the closing result carries a finite cost.
          r.costUsd = Number.isFinite(e.total_cost_usd) && e.total_cost_usd >= 0 ? e.total_cost_usd : null;
          r.usageComplete = r.costUsd !== null;
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
      let started = 0; let completed = 0; let failed = false;
      for (const e of lines(stdout)) {
        const item = e.item ?? {};
        if (e.type === 'turn.started') started++;
        if (e.type === 'turn.failed' || e.type === 'error') failed = true;
        if (e.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(item.type)) {
          r.toolCalls++;
          r.tools.push({ name: item.type === 'mcp_tool_call' ? (item.tool ?? item.type) : item.type, id: item.id });
          if (item.command) r.commands.push(String(item.command));
        }
        if (e.type === 'item.completed' && item.type === 'agent_message' && item.text) r.finalText = item.text;
        if (e.type === 'turn.completed') {
          const u = e.usage ?? {};
          // A turn counts as accounted only when its usage carries finite, non-negative token counts.
          const ok = ['input_tokens', 'output_tokens'].every((k) => typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0);
          if (ok) completed++; else failed = true;
          r.tokens.input += num(u.input_tokens); r.tokens.cacheRead += num(u.cached_input_tokens); r.tokens.output += num(u.output_tokens); r.tokens.reasoning += num(u.reasoning_output_tokens);
        }
      }
      // A turn that started and never reported usage spent an unknown amount; zero tokens is not zero cost.
      r.usageComplete = started > 0 && started === completed && !failed;
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
      let cost = 0; let starts = 0; let finishes = 0; let costed = 0;
      for (const e of lines(stdout)) {
        const p = e.part ?? {};
        if (e.type === 'tool_use' || p.type === 'tool') {
          r.toolCalls++;
          r.tools.push({ name: p.tool ?? 'tool', id: p.callID });
          const cmd = p.state?.input?.command;
          if (cmd) r.commands.push(String(cmd));
        }
        if (e.type === 'step_start' || p.type === 'step-start') starts++;
        if ((e.type === 'text' || p.type === 'text') && p.text) r.finalText = p.text;
        if (e.type === 'step_finish' || p.type === 'step-finish') {
          const t = p.tokens ?? {};
          r.tokens.input += num(t.input); r.tokens.output += num(t.output); r.tokens.reasoning += num(t.reasoning);
          r.tokens.cacheRead += num(t.cache?.read); r.tokens.cacheWrite += num(t.cache?.write);
          finishes++;
          if (typeof p.cost === 'number' && Number.isFinite(p.cost) && p.cost >= 0) { cost += p.cost; costed++; }
          if (p.modelID) r.model = p.modelID;
        }
      }
      // Every step must finish with its own finite cost. Subagent sessions do not appear in this stream
      // (OpenCode 1.0.162 filters events to the parent session), so this is the parent's cost only. It is
      // published as parentCostUsd; the total comes from the provider's own accounting (the OpenRouter
      // key's usage before and after the run), never from this stream.
      r.parentUsageComplete = starts > 0 && starts === finishes && costed === finishes;
      r.parentCostUsd = r.parentUsageComplete ? cost : null;
      r.usageComplete = false;
      r.costUsd = null;
      return r;
    },
  },
};

/** Cost from the price table, for CLIs that report tokens but no cost. null when the model has no
 * row or the stream's usage is incomplete. */
export function priceCost(pricing, model, tokens, usageComplete = true) {
  if (!usageComplete) return null;
  const p = pricing?.models?.[model];
  if (!p || !Number.isFinite(p.inputPerMTok) || !Number.isFinite(p.outputPerMTok)) return null;
  const cached = Number.isFinite(p.cachedInputPerMTok) ? p.cachedInputPerMTok : p.inputPerMTok;
  return ((tokens.input - tokens.cacheRead) * p.inputPerMTok + tokens.cacheRead * cached + (tokens.output + tokens.reasoning) * p.outputPerMTok) / 1e6;
}
