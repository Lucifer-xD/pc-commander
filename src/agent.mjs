// Autonomous engine. `agent_task` gives the connector its own brain: it takes a
// goal, then loops plan -> call a tool -> observe -> repeat (using an LLM via your
// own API key) until the goal is done, and reports back. Works with any
// OpenAI-compatible API (OpenAI, Groq, local Ollama/LM Studio, etc.).
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {setSecret, getSecret} from './secrets.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const short = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };

// ---- minimal zod-shape -> JSON Schema (for function calling) ----
const isOpt = zt => ['ZodOptional', 'ZodDefault'].includes(zt?._def?.typeName);
function jsch(zt) {
  const d = zt?._def; if (!d) return {type: 'string'};
  const desc = d.description; let s;
  switch (d.typeName) {
    case 'ZodString': s = {type: 'string'}; break;
    case 'ZodNumber': s = {type: 'number'}; break;
    case 'ZodBoolean': s = {type: 'boolean'}; break;
    case 'ZodEnum': s = {type: 'string', enum: d.values}; break;
    case 'ZodOptional': case 'ZodDefault': s = jsch(d.innerType); break;
    case 'ZodArray': s = {type: 'array', items: jsch(d.type)}; break;
    case 'ZodRecord': s = {type: 'object', additionalProperties: jsch(d.valueType)}; break;
    case 'ZodObject': { const sh = typeof d.shape === 'function' ? d.shape() : d.shape; s = {type: 'object', properties: {}, required: []}; for (const [k, v] of Object.entries(sh)) { s.properties[k] = jsch(v); if (!isOpt(v)) s.required.push(k); } break; }
    default: s = {type: 'string'};
  }
  if (desc && !s.description) s.description = desc;
  return s;
}
function params(shape) { const p = {type: 'object', properties: {}, required: []}; for (const [k, v] of Object.entries(shape)) { p.properties[k] = jsch(v); if (!isOpt(v)) p.required.push(k); } return p; }

// ---- shared pieces, reused by both agent_task and the subagent system ----
export const DEFAULT_SYS = 'You are an autonomous agent operating the user\'s computer through the provided tools. '
  + 'Accomplish the GOAL by calling tools step by step. Think briefly, then act. Verify results. '
  + 'Keep going until the goal is fully done, then give a short final summary WITHOUT calling a tool. '
  + 'Be careful and never do anything destructive that the goal did not ask for.';

// Build OpenAI function-calling tool defs from a list of connector tools.
export function buildToolDefs(toolList) {
  return toolList.map(t => ({type: 'function', function: {name: t.name, description: t.description.slice(0, 1024), parameters: params(t.shape)}}));
}

// Read the autonomous-engine config (model + baseUrl) from disk.
export function loadAgentCfg(config) { try { return JSON.parse(readFileSync(join(config.dataDir, 'agent.json'), 'utf8')); } catch { return {}; } }

// The core autonomous loop: plan -> call tool(s) -> observe -> repeat until the
// model answers without a tool call (or the cap/cancel is hit). `runTool` must
// return a STRING (already guard-checked). Throws on a fatal LLM error.
export async function runAgentLoop({cfg, key, goal, systemPrompt, toolDefs, runTool, cap = 20, onStep, isCancelled}) {
  const messages = [{role: 'system', content: systemPrompt || DEFAULT_SYS}, {role: 'user', content: 'GOAL: ' + goal}];
  const transcript = []; let final = '';
  for (let step = 0; step < cap; step++) {
    if (isCancelled && isCancelled()) { final = '(cancelled)'; break; }
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + key},
      body: JSON.stringify({model: cfg.model, messages, tools: toolDefs, tool_choice: 'auto', temperature: 0}),
    });
    if (!res.ok) throw new Error(`LLM call failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('LLM returned no message.');
    messages.push(msg);
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        if (isCancelled && isCancelled()) break;
        let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        const result = await runTool(tc.function.name, args);
        const line = `▶ ${tc.function.name}(${short(args, 80)}) → ${short(result, 200)}`;
        transcript.push(line);
        if (onStep) { try { onStep(line, transcript.length); } catch {} }
        messages.push({role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 6000)});
      }
    } else { final = msg.content || ''; break; }
  }
  if (!final) final = '(reached the step limit without a final summary)';
  return {transcript, final, steps: transcript.length};
}

export function makeAgentTools(config, {tools, runTool}) {
  const cfgFile = join(config.dataDir, 'agent.json');
  const loadCfg = () => loadAgentCfg(config);

  // tools the autonomous agent may use (exclude itself and config tools).
  const usable = () => tools.filter(t => !['agent_task', 'configure_agent', 'agent_status'].includes(t.name));

  return [
    {
      name: 'configure_agent', risk: 'write',
      description: 'Set up the autonomous engine: which LLM to use for agent_task. Works with any OpenAI-compatible API. Provide model + api_key, and base_url for non-OpenAI endpoints (e.g. Groq, a local Ollama/LM Studio server).',
      shape: {
        model: z.string().describe('e.g. gpt-4o-mini, llama-3.3-70b, qwen2.5-coder, etc.'),
        api_key: z.string().optional().describe('API key (stored encrypted in the vault). Use "local" for a keyless local server.'),
        base_url: z.string().optional().describe('API base, e.g. https://api.openai.com/v1 (default) or http://localhost:1234/v1'),
      },
      summarize: a => ({title: 'Configure autonomous engine', detail: `${a.model} @ ${a.base_url || 'OpenAI'}`}),
      run: async ({model, api_key, base_url}) => {
        if (api_key) setSecret(config.dataDir, 'AGENT_KEY', api_key);
        writeFileSync(cfgFile, JSON.stringify({model, baseUrl: base_url || 'https://api.openai.com/v1'}, null, 2) + '\n');
        return text(`Autonomous engine set: model ${model} @ ${base_url || 'https://api.openai.com/v1'}.`);
      },
    },
    {
      name: 'agent_status', risk: 'read',
      description: 'Show whether the autonomous engine is configured and with which model.',
      shape: {},
      summarize: () => ({title: 'Autonomous engine status', detail: ''}),
      run: async () => { const c = loadCfg(); return text(c.model ? `Configured: ${c.model} @ ${c.baseUrl}. ${getSecret(config.dataDir, 'AGENT_KEY') ? 'Key set.' : 'No key set.'}` : 'Not configured. Use configure_agent first.'); },
    },
    {
      name: 'agent_task', risk: 'exec',
      description: 'Autonomously carry out a multi-step GOAL on this machine: the engine plans and uses the connector\'s own tools in a loop until done, then reports what it did. Use for bigger jobs you want handled end-to-end (e.g. "set up a Python project, write a scraper, run it, save the output"). Returns a transcript + result.',
      shape: {goal: z.string().describe('What to accomplish, in detail.'), max_steps: z.number().optional().describe('Safety cap on tool steps (default 20).')},
      summarize: a => ({title: 'Run autonomous task', detail: a.goal}),
      run: async ({goal, max_steps}) => {
        const cfg = loadCfg();
        if (!cfg.model) return fail('The autonomous engine is not configured. Use configure_agent (model + api_key) first.');
        const key = getSecret(config.dataDir, 'AGENT_KEY') || 'local';
        const cap = Math.min(max_steps || 20, 40);
        try {
          const {transcript, final} = await runAgentLoop({cfg, key, goal, toolDefs: buildToolDefs(usable()), runTool, cap});
          return text(`AUTONOMOUS TASK COMPLETE\n\nSteps (${transcript.length}):\n${transcript.join('\n') || '(none)'}\n\n--- result ---\n${final}`);
        } catch (e) { return fail(`Autonomous task failed: ${e.message}`); }
      },
    },
  ];
}
