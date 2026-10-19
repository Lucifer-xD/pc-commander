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

const VERSION = '0.4.0';
const config = loadConfig();
const log = createLog(join(ROOT, 'logs', 'connector.log'));
const SETTINGS = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const modeFile = join(config.dataDir, 'mode.json');
const tools = [...makeTools(config), ...makeRemoteTools(config)];
const recent = [];

function currentMode() {
  try { return JSON.parse(readFileSync(modeFile, 'utf8')).mode === 'always' ? 'always' : 'ask'; }
  catch { return 'ask'; }
}
function setMode(m) { writeFileSync(modeFile, JSON.stringify({mode: m === 'always' ? 'always' : 'ask'}) + '\n'); }

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
      const mode = currentMode();
      const {title, detail} = tool.summarize(args);
      // read-only tools never change the machine -> run straight away.
      // write/exec wait for a click unless the user chose "always".
      const auto = tool.risk === 'read' || mode === 'always'
        || (tool.name === 'run_command' && autoApproved(args.command || '', config.autoApprove));
      const entry = {t: Date.now(), tool: tool.name, command: title + (detail ? ' — ' + String(detail).replace(/\s+/g, ' ').slice(0, 160) : ''), mode, decision: auto ? 'auto' : 'pending'};
      recent.unshift(entry); recent.length = Math.min(recent.length, 50);
      log('request', {tool: tool.name, title, mode, risk: tool.risk, auto});

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
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, {ok: true, name: 'pc-connector', version: VERSION, mode: currentMode(), tools: tools.length});

  if (url.pathname === '/' || url.pathname === '/settings' || url.pathname.startsWith('/api/')) {
    if (!authorized(req, url)) { res.writeHead(401, {'content-type': 'text/plain'}); return res.end('Add ?key=YOUR_TOKEN to the URL.'); }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/settings')) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}); return res.end(SETTINGS);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, {mode: currentMode(), recent, tools: tools.map(t => ({name: t.name, risk: t.risk}))});
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
