// MCP connector over streamable HTTP. One tool, run_command, that (depending on
// the current mode) either asks for a local Approve click on this PC or runs
// straight away. Mode is flipped live from the settings page.
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {loadConfig, ROOT} from './config.mjs';
import {requestApproval, autoApproved} from './approve.mjs';
import {runCommand} from './exec.mjs';
import {createLog} from './log.mjs';

const config = loadConfig();
const log = createLog(join(ROOT, 'logs', 'connector.log'));
const SETTINGS = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const modeFile = join(config.dataDir, 'mode.json');
const recent = [];

function currentMode() {
  try { return JSON.parse(readFileSync(modeFile, 'utf8')).mode === 'always' ? 'always' : 'ask'; }
  catch { return config.approvalMode === 'always' ? 'always' : 'ask'; }
}
function setMode(m) { writeFileSync(modeFile, JSON.stringify({mode: m === 'always' ? 'always' : 'ask'}) + '\n'); }

function authorized(req, url) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const key = bearer || url.searchParams.get('key') || '';
  const a = Buffer.from(key), b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function buildServer() {
  const server = new McpServer({name: 'pc-connector', version: '0.2.0'});
  server.tool(
    'run_command',
    'Run a command on the user\'s own Windows PC (their laptop) in PowerShell and return its stdout, stderr and exit code. ' +
    'THIS IS THE USER\'S PERSONAL MACHINE. Whenever the user asks you to do anything on "my PC" / "my computer" / "my laptop" — ' +
    'run a command or script, check or change files and folders, inspect the system, use git, run builds or tests, open or launch apps, ' +
    'manage processes, or anything else a terminal can do — call this tool directly. Do NOT ask the user to run it themselves and do NOT ' +
    'say you are unable to; you ARE able, through this tool. The user has already authorized it, and each command is gated by their own ' +
    'local Approve prompt (or runs immediately if they set it to always-allow), so you never need to ask for permission in chat — just call it. ' +
    'Prefer one self-contained PowerShell command per call.',
    {
      command: z.string().describe('The exact PowerShell command or script to run.'),
      cwd: z.string().optional().describe('Absolute working directory. Defaults to the user home.'),
    },
    async ({command, cwd}) => {
      const workdir = cwd || config.defaultCwd;
      const mode = currentMode();
      const auto = mode === 'always' || autoApproved(command, config.autoApprove);
      const entry = {t: Date.now(), command: command.slice(0, 300), mode, decision: auto ? 'auto' : 'pending'};
      recent.unshift(entry); recent.length = Math.min(recent.length, 50);
      log('request', {command: command.slice(0, 500), cwd: workdir, mode, auto});
      if (!auto) {
        const decision = await requestApproval({command, cwd: workdir, timeoutMs: config.approvalTimeoutMs});
        entry.decision = decision;
        log('decision', {decision});
        if (decision !== 'approved') {
          return {isError: true, content: [{type: 'text', text: decision === 'timeout'
            ? 'The user did not respond to the approval prompt in time. The command was NOT run. Ask them before retrying.'
            : 'The user DENIED this command. It was NOT run. Do not retry it without a different approach the user asks for.'}]};
        }
      }
      const r = await runCommand({command, cwd: workdir, timeoutMs: config.commandTimeoutMs, maxOutputChars: config.maxOutputChars});
      log('result', {exitCode: r.exitCode, timedOut: !!r.timedOut, outLen: r.stdout.length, errLen: r.stderr.length});
      const parts = [`exit code: ${r.timedOut ? 'timed out' : r.exitCode}`, `cwd: ${r.cwd}`];
      if (r.stdout.trim()) parts.push('--- stdout ---\n' + r.stdout.trimEnd());
      if (r.stderr.trim()) parts.push('--- stderr ---\n' + r.stderr.trimEnd());
      if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(no output)');
      return {content: [{type: 'text', text: parts.join('\n')}]};
    },
  );
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
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, {ok: true, name: 'pc-connector', version: '0.2.0', mode: currentMode()});

  // Settings page + mode API: gated by the same token (the tunnel exposes all
  // paths, so changing the mode must require the key too).
  if (url.pathname === '/' || url.pathname === '/settings' || url.pathname.startsWith('/api/')) {
    if (!authorized(req, url)) { res.writeHead(401, {'content-type': 'text/plain'}); return res.end('Add ?key=YOUR_TOKEN to the URL.'); }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/settings')) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}); return res.end(SETTINGS);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, {mode: currentMode(), recent});
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
  console.log(`PC connector on http://${config.host}:${config.port}/mcp  (mode: ${currentMode()})`);
  console.log(`Settings: http://127.0.0.1:${config.port}/?key=${config.token}`);
  log('started', {port: config.port, mode: currentMode()});
});
