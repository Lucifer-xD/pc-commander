// Remote access: control your VPSes over SSH, remote Windows over WinRM, and
// open RDP sessions — all from the same connector. Saved servers live in
// data/servers.json (connection details only; prefer SSH keys over passwords —
// no passwords are stored here).
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {resolveSecrets} from './secrets.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});

// Generic process runner (ssh/scp/mstsc/powershell), captures stdout+stderr.
function run(exe, args, {timeoutMs = 90000, input} = {}) {
  return new Promise(resolve => {
    const child = spawn(exe, args, {windowsHide: true});
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    if (input != null) { child.stdin.write(input); child.stdin.end(); }
    child.on('exit', code => { clearTimeout(timer); resolve({code, out: out.trimEnd(), err: err.trimEnd(), timedOut}); });
    child.on('error', e => { clearTimeout(timer); resolve({code: null, out: '', err: e.message, timedOut}); });
  });
}

export function makeRemoteTools(config) {
  const file = join(config.dataDir, 'servers.json');
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return []; } };
  const save = list => writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
  const find = name => load().find(s => s.name.toLowerCase() === String(name).toLowerCase());

  // Resolve a server either from a saved name or from inline host/user/port/keyfile.
  const resolve = a => {
    if (a.server) { const s = find(a.server); if (!s) throw new Error(`No saved server named "${a.server}". Use list_servers or add_server.`); return s; }
    if (!a.host) throw new Error('Give a saved "server" name, or a "host" (and usually "user").');
    return {host: a.host, user: a.user, port: a.port, keyfile: a.keyfile, type: a.type || 'ssh'};
  };
  const sshArgs = s => {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'];
    if (s.port) args.push('-p', String(s.port));
    if (s.keyfile) args.push('-i', s.keyfile);
    args.push(s.user ? `${s.user}@${s.host}` : s.host);
    return args;
  };
  const shq = c => "'" + String(c).replace(/'/g, "'\\''") + "'";
  const rjFile = join(config.dataDir, 'remote-jobs.json');
  const rjLoad = () => { try { return JSON.parse(readFileSync(rjFile, 'utf8')); } catch { return []; } };
  const rjSave = l => writeFileSync(rjFile, JSON.stringify(l, null, 2) + '\n');

  return [
    {
      name: 'list_servers',
      risk: 'read',
      description: 'List the saved remote servers (your VPSes / remote Windows boxes) you can control.',
      shape: {},
      summarize: () => ({title: 'List saved servers', detail: file}),
      run: async () => {
        const list = load();
        if (!list.length) return text('No saved servers yet. Add one with add_server (name, host, user, and ideally an SSH keyfile).');
        return text(list.map(s => `• ${s.name}  —  ${s.type || 'ssh'}  ${s.user ? s.user + '@' : ''}${s.host}${s.port ? ':' + s.port : ''}${s.keyfile ? '  (key: ' + s.keyfile + ')' : ''}`).join('\n'));
      },
    },
    {
      name: 'add_server',
      risk: 'write',
      description: 'Save a remote server so you can control it by name later. Prefer SSH key auth (give keyfile); passwords are not stored.',
      shape: {
        name: z.string().describe('A short nickname, e.g. "london" or "web1".'),
        host: z.string().describe('Hostname or IP.'),
        user: z.string().optional().describe('Login user (e.g. root).'),
        port: z.number().optional().describe('Port (SSH default 22, RDP 3389).'),
        keyfile: z.string().optional().describe('Path to the SSH private key to use.'),
        type: z.enum(['ssh', 'windows', 'rdp']).optional().describe('ssh (Linux), windows (WinRM), or rdp. Default ssh.'),
      },
      summarize: a => ({title: 'Save a server', detail: `${a.name}: ${a.type || 'ssh'} ${a.user ? a.user + '@' : ''}${a.host}${a.port ? ':' + a.port : ''}`}),
      run: async (a) => {
        const list = load().filter(s => s.name.toLowerCase() !== a.name.toLowerCase());
        list.push({name: a.name, host: a.host, user: a.user, port: a.port, keyfile: a.keyfile, type: a.type || 'ssh'});
        save(list);
        return text(`Saved server "${a.name}".`);
      },
    },
    {
      name: 'remove_server',
      risk: 'write',
      description: 'Forget a saved server.',
      shape: {name: z.string().describe('The nickname to remove.')},
      summarize: a => ({title: 'Remove a saved server', detail: a.name}),
      run: async ({name}) => {
        const before = load(); const after = before.filter(s => s.name.toLowerCase() !== String(name).toLowerCase());
        if (after.length === before.length) return fail(`No saved server named "${name}".`);
        save(after); return text(`Removed "${name}".`);
      },
    },
    {
      name: 'ssh_run',
      risk: 'exec',
      description:
        'Run a command on a remote Linux server over SSH and return its output. Use a saved "server" name, or give host/user directly. ' +
        'This is how you administer the user\'s VPSes — install packages, restart services, check logs, deploy, edit remote files, anything.',
      shape: {
        server: z.string().optional().describe('A saved server nickname.'),
        host: z.string().optional().describe('Or a hostname/IP directly.'),
        user: z.string().optional().describe('Login user (with host).'),
        port: z.number().optional(),
        keyfile: z.string().optional(),
        command: z.string().describe('The shell command to run on the remote server.'),
      },
      summarize: a => ({title: `Run on ${a.server || a.host} (SSH)`, detail: a.command}),
      run: async (a) => {
        const s = resolve(a);
        const r = await run('ssh', [...sshArgs(s), resolveSecrets(config.dataDir, a.command)], {timeoutMs: config.commandTimeoutMs || 110000});
        if (r.timedOut) return fail(`SSH to ${s.host} timed out.`);
        const parts = [`[${s.user ? s.user + '@' : ''}${s.host}] exit ${r.code}`];
        if (r.out) parts.push(r.out);
        if (r.err) parts.push('--- stderr ---\n' + r.err);
        if (!r.out && !r.err) parts.push('(no output)');
        const body = parts.join('\n');
        return r.code === 0 || r.out ? text(body) : fail(body + (r.err.includes('Permission denied') || r.err.includes('publickey') ? '\n\nTip: set up key auth (ssh-copy-id) or pass the right keyfile.' : ''));
      },
    },
    {
      name: 'ssh_copy',
      risk: 'exec',
      description: 'Copy a file to ("up") or from ("down") a remote server over SCP.',
      shape: {
        server: z.string().optional(),
        host: z.string().optional(), user: z.string().optional(), port: z.number().optional(), keyfile: z.string().optional(),
        direction: z.enum(['up', 'down']).describe('up = local->remote, down = remote->local.'),
        local: z.string().describe('Local file path.'),
        remote: z.string().describe('Remote file path.'),
      },
      summarize: a => ({title: `SCP ${a.direction} · ${a.server || a.host}`, detail: a.direction === 'up' ? `${a.local}  ->  ${a.remote}` : `${a.remote}  ->  ${a.local}`}),
      run: async (a) => {
        const s = resolve(a);
        const opts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
        if (s.port) opts.push('-P', String(s.port));
        if (s.keyfile) opts.push('-i', s.keyfile);
        const target = `${s.user ? s.user + '@' : ''}${s.host}:${a.remote}`;
        const args = a.direction === 'up' ? [...opts, a.local, target] : [...opts, target, a.local];
        const r = await run('scp', args, {timeoutMs: 180000});
        return r.code === 0 ? text(`Copied ${a.direction === 'up' ? a.local + ' -> ' + target : target + ' -> ' + a.local}.`) : fail(r.err || 'scp failed.');
      },
    },
    {
      name: 'winrm_run',
      risk: 'exec',
      description: 'Run PowerShell on a remote WINDOWS machine via PowerShell Remoting (Invoke-Command). Uses your current credentials / trusted-hosts setup.',
      shape: {
        server: z.string().optional(), host: z.string().optional(),
        command: z.string().describe('PowerShell to run on the remote Windows machine.'),
      },
      summarize: a => ({title: `Run on ${a.server || a.host} (Windows)`, detail: a.command}),
      run: async (a) => {
        const s = resolve(a);
        const script = `Invoke-Command -ComputerName '${s.host.replace(/'/g, "''")}' -ScriptBlock { ${a.command} } -ErrorAction Stop | Out-String -Width 160`;
        const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {timeoutMs: config.commandTimeoutMs || 110000});
        return r.code === 0 ? text(r.out || '(no output)') : fail((r.err || 'Invoke-Command failed.') + '\n\nTip: WinRM must be enabled on the remote (Enable-PSRemoting) and the host trusted (TrustedHosts).');
      },
    },
    {
      name: 'rdp_connect',
      risk: 'exec',
      description: 'Open a Remote Desktop (RDP) session to a Windows server — pops the remote desktop window on this PC. Use a saved server or a host.',
      shape: {
        server: z.string().optional(), host: z.string().optional(), user: z.string().optional(), port: z.number().optional(),
      },
      summarize: a => ({title: 'Open Remote Desktop', detail: `${a.server || a.host}`}),
      run: async (a) => {
        const s = resolve(a);
        const addr = `${s.host}${s.port ? ':' + s.port : ''}`;
        const args = ['/v:' + addr];
        // stash the username hint so mstsc pre-fills it
        const r = await run('cmd.exe', ['/c', 'start', '', 'mstsc', ...args], {timeoutMs: 15000});
        return r.code === 0 || r.code === null ? text(`Opened a Remote Desktop window to ${addr}${s.user ? ' (log in as ' + s.user + ')' : ''}. Finish signing in on screen.`) : fail(r.err || 'Could not launch mstsc.');
      },
    },
    {
      name: 'ssh_run_all', risk: 'exec',
      description: 'Run the SAME command on EVERY saved SSH server at once (fan-out) and return each result. Great for fleet-wide checks or updates.',
      shape: {command: z.string().describe('The command to run on all saved Linux servers.')},
      summarize: a => ({title: 'Run on ALL servers', detail: a.command}),
      run: async ({command}) => {
        const list = load().filter(s => (s.type || 'ssh') === 'ssh');
        if (!list.length) return fail('No saved SSH servers. Add some with add_server.');
        const results = await Promise.all(list.map(async s => {
          const r = await run('ssh', [...sshArgs(s), command], {timeoutMs: config.commandTimeoutMs || 110000});
          return `=== ${s.name} (${s.host}) · exit ${r.code} ===\n${(r.out || r.err || '(no output)').slice(0, 4000)}`;
        }));
        return text(results.join('\n\n'));
      },
    },
    {
      name: 'start_remote_job', risk: 'exec',
      description: 'Start a long-running job on a remote server that KEEPS RUNNING after you disconnect and even after your own PC shuts down (via nohup). Returns a job id; read its output with remote_job_log. This is the right place for hours-long tasks.',
      shape: {
        server: z.string().optional(), host: z.string().optional(), user: z.string().optional(), port: z.number().optional(), keyfile: z.string().optional(),
        command: z.string().describe('The command to run on the server.'),
        label: z.string().optional(),
      },
      summarize: a => ({title: `Start remote job on ${a.server || a.host}`, detail: a.command}),
      run: async (a) => {
        const s = resolve(a);
        const id = 'rjob' + Date.now().toString(36);
        const log = `$HOME/.pc-jobs/${id}.log`;
        const remote = `mkdir -p ~/.pc-jobs; nohup sh -c ${shq(a.command)} > ${log} 2>&1 & echo "PID:$!"; echo "LOG:${log}"`;
        const r = await run('ssh', [...sshArgs(s), remote], {timeoutMs: 30000});
        const pid = (r.out.match(/PID:(\d+)/) || [])[1];
        if (!pid) return fail(`Could not start remote job.\n${r.err || r.out}`);
        const rec = {id, server: s.name || s.host, host: s.host, user: s.user, port: s.port, keyfile: s.keyfile, pid, log: `~/.pc-jobs/${id}.log`, command: a.command, label: a.label || '', started: Date.now()};
        rjSave([rec, ...rjLoad()].slice(0, 100));
        return text(`Started remote job ${id} (pid ${pid}) on ${s.host}. It survives disconnect and your PC shutting down. Read it with remote_job_log id "${id}".`);
      },
    },
    {
      name: 'remote_job_log', risk: 'read',
      description: 'Check a remote job started with start_remote_job: whether it is still running, and its latest output.',
      shape: {id: z.string()},
      summarize: a => ({title: 'Check remote job', detail: a.id}),
      run: async ({id}) => {
        const rec = rjLoad().find(j => j.id === id);
        if (!rec) return fail(`No remote job "${id}".`);
        const s = {host: rec.host, user: rec.user, port: rec.port, keyfile: rec.keyfile};
        const remote = `(kill -0 ${rec.pid} 2>/dev/null && echo "STATUS:running" || echo "STATUS:finished"); echo "--- output ---"; tail -c 8000 ${rec.log} 2>/dev/null`;
        const r = await run('ssh', [...sshArgs(s), remote], {timeoutMs: 30000});
        return text(`${rec.id}${rec.label ? ' (' + rec.label + ')' : ''} on ${rec.host}\n$ ${rec.command}\n${r.out || r.err}`);
      },
    },
  ];
}
