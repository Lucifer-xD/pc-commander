// Starts the connector and a public HTTPS tunnel (localhost.run over SSH),
// then prints the exact URL to paste into ChatGPT as a custom connector.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const token = readFileSync(join(root, 'data', 'token.txt'), 'utf8').trim();
const port = (() => { try { return JSON.parse(readFileSync(join(root, 'data', 'config.json'), 'utf8')).port || 8787; } catch { return 8787; } })();

const server = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {stdio: 'inherit'});

// localhost.run: a free SSH reverse tunnel with TLS termination. Works on
// networks that block cloudflared's QUIC/edge. Add an SSH key at
// https://admin.localhost.run for a stable subdomain that survives restarts.
const ssh = spawn('ssh', ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=20', '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'], {stdio: ['ignore', 'pipe', 'pipe']});
let shown = false;
const scan = buf => {
  const m = String(buf).match(/https:\/\/[a-z0-9]+\.lhr\.life/);
  if (m && !shown) {
    shown = true;
    const url = `${m[0]}/mcp?key=${token}`;
    console.log('\n' + '='.repeat(74));
    console.log('  Connector is live. In ChatGPT (web):');
    console.log('  Settings -> Connectors -> Advanced -> Developer mode (on),');
    console.log('  then add a custom connector with this URL:\n');
    console.log('  ' + url + '\n');
    console.log('  Keep this window open while you use it.');
    console.log('  (Random subdomain each start until you register an SSH key');
    console.log('   at https://admin.localhost.run for a stable one.)');
    console.log('='.repeat(74) + '\n');
  }
};
ssh.stdout.on('data', scan);
ssh.stderr.on('data', scan);
const stop = () => { server.kill(); ssh.kill(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
server.on('exit', stop); ssh.on('exit', stop);
