// MCP connector over streamable HTTP. Registers the agent's tools (see tools.mjs),
// each gated by risk + the current mode:
//   read  -> always runs (never changes the PC)
//   write/exec -> waits for a local Approve click, unless mode is "always"
// Mode is flipped live from the settings page.
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {loadConfig, ROOT} from './config.mjs';
import {requestApproval, autoApproved} from './approve.mjs';
import {createLog} from './log.mjs';
import {makeTools} from './tools.mjs';
import {makeRemoteTools} from './remote.mjs';
import {makeJobTools, initJobs} from './jobs.mjs';
import {makeGuiTools} from './gui.mjs';
import {makeMemoryTools} from './memory.mjs';
import {makeWebTools} from './web.mjs';
import {makeNotifyTools} from './notify.mjs';
import {makeExtraTools} from './extra.mjs';
import {makeSchedulerTools, initScheduler} from './scheduler.mjs';
import {makeUndoTools, initUndo} from './undo.mjs';
import {makeSecretTools} from './secrets.mjs';
import {makeDevTools} from './dev.mjs';
import {makeAgentTools} from './agent.mjs';
import {loadGuard, assess} from './guard.mjs';
import {z} from 'zod';

const VERSION = '0.7.0';
const config = loadConfig();
const log = createLog(join(ROOT, 'logs', 'connector.log'));
const SETTINGS = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const modeFile = join(config.dataDir, 'mode.json');
const guard = loadGuard(config.dataDir);
initJobs(config);
initScheduler(config);
initUndo(config);

// A small built-in control tool: toggle dry-run (preview) mode.
const controlTools = [{
  name: 'set_dry_run', risk: 'read',
  description: 'Turn DRY-RUN (preview) mode on or off. When ON, the agent reports what each change/command WOULD do without actually doing it. Reads still work normally.',
  shape: {enabled: z.boolean()},
  summarize: a => ({title: a.enabled ? 'Enable dry-run (preview)' : 'Disable dry-run', detail: ''}),
  run: async ({enabled}) => { setDryRun(enabled); return {content: [{type: 'text', text: `Dry-run is now ${enabled ? 'ON — changes are previewed, not performed' : 'OFF — changes happen for real'}.`}]}; },
}];

const baseTools = [
  ...makeTools(config), ...makeRemoteTools(config), ...makeJobTools(config), ...makeGuiTools(),
  ...makeMemoryTools(config), ...makeWebTools(config), ...makeNotifyTools(config), ...makeExtraTools(), ...makeSchedulerTools(),
  ...makeUndoTools(), ...makeSecretTools(config), ...makeDevTools(config), ...controlTools,
];

// How the autonomous engine runs a tool: guard-checked, no per-step dialog
// (you approve launching agent_task itself), catastrophic actions still blocked.
async function runToolAutonomous(name, args) {
  const tool = baseTools.find(t => t.name === name);
  if (!tool) return 'No such tool: ' + name;
  const g = assess(tool, args, guard);
  if (g.level === 'block') return 'BLOCKED by safety guard: ' + g.reason;
  if (g.level === 'confirm') return 'SKIPPED (this sensitive action needs a human to confirm it): ' + g.reason;
  try { const out = await tool.run(args); return (out.content || []).map(c => c.type === 'text' ? c.text : '[image]').join('\n') || '(done)'; }
  catch (e) { return 'ERROR: ' + e.message; }
}

const tools = [...baseTools, ...makeAgentTools(config, {tools: baseTools, runTool: runToolAutonomous})];

// Simple rate limiter: cap tool invocations per rolling minute (runaway-loop guard).
const MAX_PER_MIN = config.maxPerMinute || 120;
const hits = [];
function rateOk() { const now = Date.now(); while (hits.length && now - hits[0] > 60000) hits.shift(); if (hits.length >= MAX_PER_MIN) return false; hits.push(now); return true; }
const recent = [];

function readState() { try { return JSON.parse(readFileSync(modeFile, 'utf8')); } catch { return {}; } }
function currentMode() { return readState().mode === 'always' ? 'always' : 'ask'; }
function currentDryRun() { return !!readState().dryRun; }
function setMode(m) { const s = readState(); writeFileSync(modeFile, JSON.stringify({...s, mode: m === 'always' ? 'always' : 'ask'}) + '\n'); }
function setDryRun(v) { const s = readState(); writeFileSync(modeFile, JSON.stringify({...s, dryRun: !!v}) + '\n'); }

function authorized(req, url) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const key = bearer || url.searchParams.get('key') || '';
  const a = Buffer.from(key), b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function buildServer() {
  const server = new McpServer({name: 'pc-connector', version: VERSION});
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.shape, async (args) => {
      if (!rateOk()) return {isError: true, content: [{type: 'text', text: `Rate limit: more than ${MAX_PER_MIN} actions in a minute. Pausing to avoid a runaway loop — slow down or wait a moment.`}]};
      const mode = currentMode();
      let {title, detail} = tool.summarize(args);

      // Safety guard: can hard-block catastrophic actions or force a confirmation.
      const g = assess(tool, args, guard);
      if (g.level === 'block') {
        recent.unshift({t: Date.now(), tool: tool.name, command: '⛔ ' + title, mode, decision: 'denied'}); recent.length = Math.min(recent.length, 50);
        log('blocked', {tool: tool.name, reason: g.reason});
        return {isError: true, content: [{type: 'text', text: 'BLOCKED by safety guard. ' + g.reason}]};
      }
      if (g.level === 'confirm') detail = '⚠ ' + g.reason + '\n\n' + (detail || '');

      // Dry-run: preview what a change/exec WOULD do, without doing it. Reads still run.
      if (currentDryRun() && tool.risk !== 'read') {
        recent.unshift({t: Date.now(), tool: tool.name, command: '👁 ' + title, mode, decision: 'auto'}); recent.length = Math.min(recent.length, 50);
        log('dry_run', {tool: tool.name, title});
        return {content: [{type: 'text', text: `DRY RUN (preview — nothing was changed).\nWould: ${title}${detail ? '\n' + detail : ''}\n\nTurn off dry-run to perform it for real.`}]};
      }

      // read-only tools never change the machine -> run straight away.
      // write/exec wait for a click unless Always-allow. A guard "confirm" always prompts.
      const auto = g.level !== 'confirm' && (tool.risk === 'read' || mode === 'always'
        || (tool.name === 'run_command' && autoApproved(args.command || '', config.autoApprove)));
      const entry = {t: Date.now(), tool: tool.name, command: title + (detail ? ' — ' + String(detail).replace(/\s+/g, ' ').slice(0, 160) : ''), mode, decision: auto ? 'auto' : 'pending'};
      recent.unshift(entry); recent.length = Math.min(recent.length, 50);
      log('request', {tool: tool.name, title, mode, risk: tool.risk, auto, guard: g.level});

      if (!auto) {
        const decision = await requestApproval({title, detail, cwd: args.cwd, timeoutMs: config.approvalTimeoutMs});
        entry.decision = decision;
        log('decision', {tool: tool.name, decision});
        if (decision !== 'approved') {
          return {isError: true, content: [{type: 'text', text: decision === 'timeout'
            ? `The user did not respond to the approval prompt in time. "${title}" was NOT done. Ask them before retrying.`
            : `The user DENIED "${title}". It was NOT done. Do not retry without a different approach the user asks for.`}]};
        }
      }
      try {
        const out = await tool.run(args);
        log('result', {tool: tool.name, ok: !out.isError});
        return out;
      } catch (e) {
        log('error', {tool: tool.name, message: e.message});
        return {isError: true, content: [{type: 'text', text: `${tool.name} failed: ${e.message}`}]};
      }
    });
  }
  return server;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}
const sendJson = (res, status, data) => { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(data)); };

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, {ok: true, name: 'pc-connector', version: VERSION, mode: currentMode(), dryRun: currentDryRun(), tools: tools.length});

  if (url.pathname === '/' || url.pathname === '/settings' || url.pathname.startsWith('/api/')) {
    if (!authorized(req, url)) { res.writeHead(401, {'content-type': 'text/plain'}); return res.end('Add ?key=YOUR_TOKEN to the URL.'); }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/settings')) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}); return res.end(SETTINGS);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, {mode: currentMode(), dryRun: currentDryRun(), recent, tools: tools.map(t => ({name: t.name, risk: t.risk}))});
    if (req.method === 'POST' && url.pathname === '/api/mode') {
      const body = await readBody(req).catch(() => ({}));
      setMode(body?.mode); log('mode_changed', {mode: currentMode()});
      return sendJson(res, 200, {mode: currentMode()});
    }
    return sendJson(res, 404, {error: 'not found'});
  }

  if (url.pathname === '/mcp') {
    if (!authorized(req, url)) return sendJson(res, 401, {jsonrpc: '2.0', error: {code: -32001, message: 'Unauthorized'}, id: null});
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined});
      res.on('close', () => transport.close());
      const server = buildServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log('error', {message: e.message});
      if (!res.headersSent) sendJson(res, 500, {jsonrpc: '2.0', error: {code: -32603, message: e.message}, id: null});
    }
    return;
  }
  res.writeHead(404); res.end('not found');
});

if (!existsSync(modeFile)) setMode('ask');
httpServer.listen(config.port, config.host, () => {
  console.log(`PC Commander v${VERSION} on http://${config.host}:${config.port}/mcp  (${tools.length} tools, mode: ${currentMode()})`);
  console.log(`Settings: http://127.0.0.1:${config.port}/?key=${config.token}`);
  log('started', {port: config.port, mode: currentMode(), tools: tools.length});
});
