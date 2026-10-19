// Subagents — let the connector run several autonomous workers in parallel.
//
// ChatGPT in the Chat tab is single-threaded: it can't fan out or recurse. This
// gives it a team it can dispatch to. spawn_subagent starts an autonomous worker
// in the BACKGROUND (its own plan->tool->observe loop, same engine as agent_task)
// and returns immediately; call it several times to run workers in parallel. Each
// subagent gets a SCOPED set of tools (a role or an explicit allow-list) so it
// can only do its job. Poll with subagent_status / list_subagents, collect with
// subagent_result, and stop one with stop_subagent.
//
// The loop is in-process (workers are mostly awaiting the LLM + tools, so many
// run concurrently fine). The machine is kept awake while any subagent runs, and
// you get a notification when one finishes (if notifications are set up).
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {getSecret} from './secrets.mjs';
import {loadAgentCfg, buildToolDefs, runAgentLoop} from './agent.mjs';
import {hold, release} from './keepawake.mjs';
import {sendNotify} from './notify.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});

// meta-tools a subagent must not call (no recursion into the agent/subagent layer).
const META = ['agent_task', 'configure_agent', 'agent_status', 'spawn_subagent', 'subagent_status', 'list_subagents', 'subagent_result', 'stop_subagent'];

// handy role presets -> which connector tools the subagent may use.
const ROLES = {
  researcher: ['read_file', 'list_dir', 'find_files', 'search_in_files', 'project_tree', 'system_info', 'list_processes', 'http_request', 'recall'],
  tester:     ['read_file', 'list_dir', 'find_files', 'search_in_files', 'project_tree', 'run_command'],
  coder:      ['read_file', 'list_dir', 'find_files', 'search_in_files', 'project_tree', 'write_file', 'edit_file', 'apply_edits', 'write_files', 'run_command', 'git', 'update_plan', 'show_plan', 'open_path'],
  // 'full' = all non-meta tools (the default)
};

export function makeSubagentTools(config, {tools, runTool}) {
  const subs = new Map();
  let seq = 0;
  const regFile = join(config.dataDir, 'subagents.json');

  const pub = s => ({id: s.id, name: s.name, role: s.role, status: s.status, steps: s.steps, startedAt: s.startedAt, endedAt: s.endedAt, task: s.task, error: s.error, resultHead: (s.result || '').slice(0, 200)});
  const dur = s => Math.round(((s.endedAt || Date.now()) - s.startedAt) / 1000);
  const persist = () => { try { writeFileSync(regFile, JSON.stringify([...subs.values()].map(pub), null, 2) + '\n'); } catch {} };

  const nonMeta = () => tools.filter(t => !META.includes(t.name));
  function scopedTools(role, allow) {
    let names = null;
    if (Array.isArray(allow) && allow.length) names = new Set(allow);
    else if (role && ROLES[role]) names = new Set(ROLES[role]);
    const list = names ? nonMeta().filter(t => names.has(t.name)) : nonMeta();
    return list.length ? list : nonMeta();
  }

  async function launch(s, cap) {
    hold();
    const cfg = loadAgentCfg(config);
    const key = getSecret(config.dataDir, 'AGENT_KEY') || 'local';
    const scoped = scopedTools(s.role, s.allow);
    const defs = buildToolDefs(scoped);
    const allowed = new Set(scoped.map(t => t.name));
    const scopedRun = async (name, args) => allowed.has(name) ? runTool(name, args) : `Tool "${name}" is not in this subagent's scope.`;
    const sys = `You are subagent "${s.name}" working autonomously as part of a team on the user's computer. `
      + `Do ONLY your assigned task: call tools step by step, verify your work, then finish with a short summary WITHOUT calling a tool. `
      + `Stay strictly within your task and never do anything unrelated or destructive.`;
    try {
      const {transcript, final, steps} = await runAgentLoop({
        cfg, key, goal: s.task, systemPrompt: sys, toolDefs: defs, runTool: scopedRun, cap,
        onStep: (line, n) => { s.steps = n; s.lastLine = line; if (s.transcript.length < 200) s.transcript.push(line); persist(); },
        isCancelled: () => s.cancel,
      });
      s.transcript = transcript.slice(0, 200); s.result = final; s.steps = steps;
      s.status = s.cancel ? 'stopped' : 'done';
    } catch (e) {
      s.status = 'error'; s.error = e.message;
    } finally {
      s.endedAt = Date.now(); release(); persist();
      try { await sendNotify(config, `🤖 Subagent ${s.id} (${s.name}) ${s.status}${s.error ? ': ' + s.error : ''}.`); } catch {}
    }
  }

  return [
    {
      name: 'spawn_subagent', risk: 'exec',
      description: 'Start an autonomous SUBAGENT in the background to carry out ONE task on this machine, and get its id immediately. Call this several times to run subagents IN PARALLEL (e.g. one to write tests, one to refactor, one to update docs). Each runs its own plan->tool->observe loop with a scoped set of tools, then reports back. Do NOT wait synchronously — spawn what you need, then poll subagent_status / list_subagents and collect with subagent_result. Requires configure_agent first.',
      shape: {
        task: z.string().describe('The one task for this subagent, in detail.'),
        name: z.string().optional().describe('Short label, e.g. "tests" or "refactor-auth".'),
        role: z.enum(['coder', 'tester', 'researcher', 'full']).optional().describe('Tool-scope preset: coder (edit+run), tester (read+run, no writes), researcher (read-only+web), full (everything). Default full.'),
        tools: z.array(z.string()).optional().describe('Explicit tool allow-list (overrides role).'),
        max_steps: z.number().optional().describe('Safety cap on tool steps (default 20, max 40).'),
      },
      summarize: a => ({title: `Spawn subagent${a.name ? ': ' + a.name : ''}`, detail: a.task}),
      run: async ({task, name, role, tools: allow, max_steps}) => {
        if (!task || !task.trim()) return fail('Empty task.');
        const cfg = loadAgentCfg(config);
        if (!cfg.model) return fail('The engine is not configured. Use configure_agent (model + api_key) first — then spawn subagents.');
        const id = 'sub' + (++seq);
        const s = {id, name: name || id, role: role || 'full', allow: allow || null, task: task.trim(), status: 'running', steps: 0, startedAt: Date.now(), endedAt: null, transcript: [], result: '', error: null, lastLine: '', cancel: false};
        subs.set(id, s); persist();
        launch(s, Math.min(max_steps || 20, 40));   // not awaited -> runs in the background, in parallel
        return text(`Spawned ${id} (${s.name}) [${s.role}]. It's working in the background. Spawn more to parallelise, or poll subagent_status "${id}". Do not block waiting.`);
      },
    },
    {
      name: 'list_subagents', risk: 'read',
      description: 'List all subagents with their status (running/done/error/stopped), step count, and duration.',
      shape: {},
      summarize: () => ({title: 'List subagents', detail: ''}),
      run: async () => {
        if (!subs.size) return text('No subagents yet. Use spawn_subagent.');
        return text([...subs.values()].map(s => `${s.id}  ${s.status.padEnd(8)}  ${String(s.steps).padStart(2)} steps  ${dur(s)}s  ${s.name}  ·  ${s.task.slice(0, 50)}`).join('\n'));
      },
    },
    {
      name: 'subagent_status', risk: 'read',
      description: 'Check ONE subagent: whether it is still running or finished, how many steps it has taken, its latest action, and (if done) the start of its result.',
      shape: {id: z.string()},
      summarize: a => ({title: 'Check subagent', detail: a.id}),
      run: async ({id}) => {
        const s = subs.get(id); if (!s) return fail(`No subagent "${id}".`);
        const head = `${s.id} (${s.name}) [${s.role}]: ${s.status}  ·  ${s.steps} steps  ·  ${dur(s)}s`;
        if (s.status === 'running') return text(`${head}\nnow: ${s.lastLine || '(thinking…)'}\n\nStill working — poll again shortly; don't give it overlapping work.`);
        if (s.status === 'error') return text(`${head}\nERROR: ${s.error}`);
        return text(`${head}\n\n--- result ---\n${(s.result || '(no result)').slice(0, 2000)}\n\n(use subagent_result for the full transcript)`);
      },
    },
    {
      name: 'subagent_result', risk: 'read',
      description: "Get a finished subagent's full result and its step-by-step transcript.",
      shape: {id: z.string()},
      summarize: a => ({title: 'Get subagent result', detail: a.id}),
      run: async ({id}) => {
        const s = subs.get(id); if (!s) return fail(`No subagent "${id}".`);
        if (s.status === 'running') return text(`${s.id} is still running (${s.steps} steps). Not done yet — poll subagent_status.`);
        return text(`SUBAGENT ${s.id} (${s.name}) — ${s.status} in ${dur(s)}s\n\nSteps (${s.transcript.length}):\n${s.transcript.join('\n') || '(none)'}\n\n--- result ---\n${s.result || s.error || '(none)'}`);
      },
    },
    {
      name: 'stop_subagent', risk: 'exec',
      description: 'Signal a running subagent to stop after its current step.',
      shape: {id: z.string()},
      summarize: a => ({title: 'Stop subagent', detail: a.id}),
      run: async ({id}) => {
        const s = subs.get(id); if (!s) return fail(`No subagent "${id}".`);
        if (s.status !== 'running') return text(`${id} already ${s.status}.`);
        s.cancel = true; return text(`Signalled ${id} to stop after its current step.`);
      },
    },
  ];
}
