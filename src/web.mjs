// Internet reach: call any HTTP API and download files. Lets the agent fetch
// data, hit webhooks, and pull files onto the machine.
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {z} from 'zod';
import {resolveSecrets} from './secrets.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const abs = p => resolve(String(p).replace(/^~(?=[\\/]|$)/, process.env.USERPROFILE || homedir()));
const CAP = 100000;

export function makeWebTools(config) {
  const sec = s => resolveSecrets(config.dataDir, s);
  return [
    {
      name: 'http_request', risk: 'exec',
      description: 'Make an HTTP request to any URL (call a web API, POST to a webhook, fetch JSON/text). Returns status, headers and body.',
      shape: {
        url: z.string().describe('The full URL.'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional().describe('Default GET.'),
        headers: z.record(z.string()).optional().describe('Request headers as an object.'),
        body: z.string().optional().describe('Request body (string; for JSON, pass the stringified JSON and set a content-type header).'),
      },
      summarize: a => ({title: `HTTP ${a.method || 'GET'}`, detail: a.url}),
      run: async ({url, method, headers, body}) => {
        try {
          url = sec(url); body = body != null ? sec(body) : body;
          const h = {}; for (const [k, v] of Object.entries(headers || {})) h[k] = sec(v);
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 60000);
          const res = await fetch(url, {method: method || 'GET', headers: h, body: body ?? undefined, signal: ctrl.signal, redirect: 'follow'});
          clearTimeout(t);
          let txt = await res.text();
          const truncated = txt.length > CAP;
          if (truncated) txt = txt.slice(0, CAP);
          const hdr = [...res.headers.entries()].slice(0, 15).map(([k, v]) => `${k}: ${v}`).join('\n');
          return text(`HTTP ${res.status} ${res.statusText}\n${hdr}\n\n--- body ---\n${txt}${truncated ? '\n…[truncated]' : ''}`);
        } catch (e) { return fail(`Request failed: ${e.message}`); }
      },
    },
    {
      name: 'download_file', risk: 'write',
      description: 'Download a file from a URL and save it to a path on the machine.',
      shape: {url: z.string(), path: z.string().describe('Where to save it (~ allowed).')},
      summarize: a => ({title: 'Download a file', detail: `${a.url}\n-> ${abs(a.path)}`}),
      run: async ({url, path}) => {
        try {
          const res = await fetch(url, {redirect: 'follow'});
          if (!res.ok) return fail(`Download failed: HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const p = abs(path); mkdirSync(dirname(p), {recursive: true}); writeFileSync(p, buf);
          return text(`Saved ${buf.length} bytes to ${p}.`);
        } catch (e) { return fail(`Download failed: ${e.message}`); }
      },
    },
  ];
}
