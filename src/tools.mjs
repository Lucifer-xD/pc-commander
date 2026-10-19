// The agent's capabilities. Each tool declares a risk level that decides whether
// it runs straight away or waits for a local Approve click:
//   read  - inspects the machine, never changes it -> auto (no prompt)
//   write - creates/changes/deletes files          -> prompt (unless Always-allow)
//   exec  - runs code / launches / kills / captures -> prompt (unless Always-allow)
import {readFileSync, writeFileSync, appendFileSync, statSync, readdirSync, existsSync, mkdirSync, rmSync, renameSync, mkdtempSync} from 'node:fs';
import {join, resolve, dirname, basename, extname} from 'node:path';
import {tmpdir, homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {runCommand} from './exec.mjs';

const SHOT = fileURLToPath(new URL('./screenshot.ps1', import.meta.url));
const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const home = () => process.env.USERPROFILE || homedir();
const abs = p => resolve(p.replace(/^~(?=[\\/]|$)/, home()));
const human = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const CAP = 200000; // max chars returned from a file/listing

// Run a PowerShell snippet and return trimmed stdout (or throw on stderr/exit).
async function ps(command, {timeoutMs = 60000} = {}) {
  const r = await runCommand({command, cwd: home(), timeoutMs, maxOutputChars: CAP});
  if (r.timedOut) throw new Error('timed out');
  return {out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trimEnd(), code: r.exitCode};
}

export function makeTools(config) {
  const cmdTimeout = config.commandTimeoutMs || 110000;

  return [
    // ---- exec -------------------------------------------------------------
    {
      name: 'run_command',
      risk: 'exec',
      description:
        'Run any PowerShell command or script on the user\'s own Windows PC and return stdout, stderr and exit code. ' +
        'This is the user\'s personal machine and they have authorized it. Use it for anything the other tools don\'t cover: ' +
        'git, builds, tests, installing packages, networking, scheduled tasks, registry, etc. Prefer one self-contained command per call.',
      shape: {
        command: z.string().describe('The exact PowerShell command or script.'),
        cwd: z.string().optional().describe('Absolute working directory. Defaults to the user home.'),
      },
      summarize: a => ({title: 'Run a PowerShell command', detail: a.command}),
      run: async ({command, cwd}) => {
        const r = await runCommand({command, cwd: cwd || config.defaultCwd, timeoutMs: cmdTimeout, maxOutputChars: config.maxOutputChars || CAP});
        const parts = [`exit code: ${r.timedOut ? 'timed out' : r.exitCode}`, `cwd: ${r.cwd}`];
        if (r.stdout.trim()) parts.push('--- stdout ---\n' + r.stdout.trimEnd());
        if (r.stderr.trim()) parts.push('--- stderr ---\n' + r.stderr.trimEnd());
        if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(no output)');
        return text(parts.join('\n'));
      },
    },

    // ---- read: files & folders -------------------------------------------
    {
      name: 'read_file',
      risk: 'read',
      description: 'Read a text file on the PC and return its contents. Use for config files, logs, code, notes, etc.',
      shape: {
        path: z.string().describe('Absolute path to the file (~ allowed for the home folder).'),
        max_bytes: z.number().optional().describe('Cap on bytes to read (default 200000).'),
      },
      summarize: a => ({title: 'Read a file', detail: a.path}),
      run: async ({path, max_bytes}) => {
        const p = abs(path);
        if (!existsSync(p)) return fail(`No such file: ${p}`);
        const st = statSync(p);
        if (st.isDirectory()) return fail(`${p} is a folder — use list_dir.`);
        let data = readFileSync(p, 'utf8');
        const cap = Math.min(max_bytes || CAP, CAP);
        const truncated = data.length > cap;
        if (truncated) data = data.slice(0, cap);
        return text(`${p}  (${human(st.size)}${truncated ? ', truncated' : ''})\n\n${data}`);
      },
    },
    {
      name: 'list_dir',
      risk: 'read',
      description: 'List the contents of a folder (names, type, size, modified date).',
      shape: {path: z.string().optional().describe('Folder path. Defaults to the home folder.')},
      summarize: a => ({title: 'List a folder', detail: a.path || '(home)'}),
      run: async ({path}) => {
        const p = abs(path || home());
        if (!existsSync(p)) return fail(`No such folder: ${p}`);
        const rows = readdirSync(p).map(name => {
          try { const s = statSync(join(p, name)); return {name, dir: s.isDirectory(), size: s.size, m: s.mtime}; }
          catch { return {name, dir: false, size: 0, m: null}; }
        }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
        const lines = rows.map(r => `${r.dir ? '[DIR] ' : '      '}${r.name.padEnd(40).slice(0, 40)}  ${r.dir ? '' : human(r.size).padStart(9)}  ${r.m ? r.m.toISOString().slice(0, 16).replace('T', ' ') : ''}`);
        return text(`${p}  (${rows.length} items)\n\n${lines.join('\n') || '(empty)'}`.slice(0, CAP));
      },
    },
    {
      name: 'find_files',
      risk: 'read',
      description: 'Find files/folders by name pattern under a folder (recursive). Great for "where is X" questions.',
      shape: {
        pattern: z.string().describe('Wildcard name pattern, e.g. *.pdf, invoice*, *.log'),
        path: z.string().optional().describe('Folder to search under. Defaults to the home folder.'),
        max_results: z.number().optional().describe('Default 200.'),
      },
      summarize: a => ({title: 'Search for files by name', detail: `${a.pattern} in ${a.path || '(home)'}`}),
      run: async ({pattern, path, max_results}) => {
        const root = abs(path || home());
        const limit = max_results || 200;
        const cmd = `Get-ChildItem -LiteralPath '${root.replace(/'/g, "''")}' -Recurse -Filter '${pattern.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First ${limit} -ExpandProperty FullName`;
        const r = await ps(cmd, {timeoutMs: 90000});
        return text(r.out ? `Matches for "${pattern}" under ${root}:\n\n${r.out}` : `No files matching "${pattern}" under ${root}.`);
      },
    },
    {
      name: 'search_in_files',
      risk: 'read',
      description: 'Search file CONTENTS for text/regex under a folder (like grep). Returns matching lines with file and line number.',
      shape: {
        query: z.string().describe('Text or regular expression to find inside files.'),
        path: z.string().optional().describe('Folder to search under. Defaults to the home folder.'),
        include: z.string().optional().describe('Only files matching this wildcard, e.g. *.js, *.txt'),
        max_results: z.number().optional().describe('Default 200.'),
      },
      summarize: a => ({title: 'Search inside files', detail: `"${a.query}" in ${a.path || '(home)'}`}),
      run: async ({query, path, include, max_results}) => {
        const root = abs(path || home());
        const limit = max_results || 200;
        const inc = include ? ` -Include '${include.replace(/'/g, "''")}'` : '';
        const cmd = `Get-ChildItem -LiteralPath '${root.replace(/'/g, "''")}' -Recurse -File${inc} -ErrorAction SilentlyContinue | Select-String -Pattern '${query.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First ${limit} | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }`;
        const r = await ps(cmd, {timeoutMs: 120000});
        return text(r.out ? `Matches for "${query}" under ${root}:\n\n${r.out}` : `No matches for "${query}" under ${root}.`);
      },
    },

    // ---- read: system -----------------------------------------------------
    {
      name: 'system_info',
      risk: 'read',
      description: 'A quick snapshot of the PC: OS/version, CPU, RAM used/total, disk free/total per drive, uptime, computer name.',
      shape: {},
      summarize: () => ({title: 'Read system info', detail: 'OS, CPU, RAM, disks, uptime'}),
      run: async () => {
        const cmd = String.raw`
$os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem; $cpu=(Get-CimInstance Win32_Processor | Select-Object -First 1)
$ramTot=[math]::Round($cs.TotalPhysicalMemory/1GB,1); $ramFree=[math]::Round($os.FreePhysicalMemory/1MB/1024,1)
"Computer : $($cs.Name)"
"OS       : $($os.Caption) $($os.Version)"
"CPU      : $($cpu.Name.Trim()) ($($cpu.NumberOfLogicalProcessors) threads)"
"RAM      : $([math]::Round($ramTot-$ramFree,1)) GB used / $ramTot GB"
"Uptime   : $([math]::Round(((Get-Date)-$os.LastBootUpTime).TotalHours,1)) h"
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "Disk $($_.DeviceID)  $([math]::Round($_.FreeSpace/1GB,1)) GB free / $([math]::Round($_.Size/1GB,1)) GB" }`;
        const r = await ps(cmd, {timeoutMs: 30000});
        return text(r.out || r.err || '(no data)');
      },
    },
    {
      name: 'list_processes',
      risk: 'read',
      description: 'List running processes, by default the heaviest ones (by memory). Optionally filter by name.',
      shape: {
        name: z.string().optional().describe('Only processes whose name contains this.'),
        top: z.number().optional().describe('How many to return (default 20).'),
      },
      summarize: a => ({title: 'List processes', detail: a.name ? `name ~ ${a.name}` : `top ${a.top || 20} by memory`}),
      run: async ({name, top}) => {
        const n = top || 20;
        const filt = name ? `Where-Object { $_.ProcessName -like '*${name.replace(/'/g, "''")}*' } | ` : '';
        const cmd = `Get-Process | ${filt}Sort-Object WS -Descending | Select-Object -First ${n} Id,ProcessName,@{n='Mem(MB)';e={[math]::Round($_.WS/1MB,1)}},@{n='CPU(s)';e={[math]::Round($_.CPU,1)}} | Format-Table -AutoSize | Out-String -Width 120`;
        const r = await ps(cmd, {timeoutMs: 30000});
        return text(r.out || '(none)');
      },
    },

    // ---- write: files -----------------------------------------------------
    {
      name: 'write_file',
      risk: 'write',
      description: 'Create a new file or overwrite an existing one with the given text. Creates parent folders as needed.',
      shape: {
        path: z.string().describe('Absolute path to write (~ allowed).'),
        content: z.string().describe('Full text content to write.'),
        append: z.boolean().optional().describe('If true, add to the end instead of overwriting.'),
      },
      summarize: a => ({title: a.append ? 'Append to a file' : 'Write a file', detail: `${abs(a.path)}\n\n${a.content.slice(0, 1500)}${a.content.length > 1500 ? '\n…' : ''}`}),
      run: async ({path, content, append}) => {
        const p = abs(path);
        mkdirSync(dirname(p), {recursive: true});
        if (append) appendFileSync(p, content, 'utf8'); else writeFileSync(p, content, 'utf8');
        return text(`${append ? 'Appended to' : 'Wrote'} ${p} (${human(Buffer.byteLength(content))}).`);
      },
    },
    {
      name: 'edit_file',
      risk: 'write',
      description: 'Find and replace text inside an existing file. By default replaces the first match; set all=true for every match.',
      shape: {
        path: z.string().describe('Absolute path to the file (~ allowed).'),
        find: z.string().describe('Exact text to find.'),
        replace: z.string().describe('Replacement text.'),
        all: z.boolean().optional().describe('Replace every occurrence (default false = first only).'),
      },
      summarize: a => ({title: 'Edit a file', detail: `${abs(a.path)}\n\nreplace:\n${a.find.slice(0, 500)}\n\nwith:\n${a.replace.slice(0, 500)}`}),
      run: async ({path, find, replace, all}) => {
        const p = abs(path);
        if (!existsSync(p)) return fail(`No such file: ${p}`);
        const before = readFileSync(p, 'utf8');
        if (!before.includes(find)) return fail(`Text not found in ${p}; nothing changed.`);
        const after = all ? before.split(find).join(replace) : before.replace(find, replace);
        const count = all ? before.split(find).length - 1 : 1;
        writeFileSync(p, after, 'utf8');
        return text(`Replaced ${count} occurrence(s) in ${p}.`);
      },
    },
    {
      name: 'manage_path',
      risk: 'write',
      description: 'File/folder housekeeping: create a folder, move/rename, copy, or delete a file or folder.',
      shape: {
        action: z.enum(['mkdir', 'move', 'copy', 'delete']).describe('What to do.'),
        path: z.string().describe('The target path (source, for move/copy).'),
        to: z.string().optional().describe('Destination path (required for move/copy).'),
      },
      summarize: a => ({title: `File action: ${a.action}`, detail: a.to ? `${abs(a.path)}  ->  ${abs(a.to)}` : abs(a.path)}),
      run: async ({action, path, to}) => {
        const p = abs(path);
        if (action === 'mkdir') { mkdirSync(p, {recursive: true}); return text(`Created folder ${p}.`); }
        if (action === 'delete') {
          if (!existsSync(p)) return fail(`No such path: ${p}`);
          rmSync(p, {recursive: true, force: true}); return text(`Deleted ${p}.`);
        }
        if (!to) return fail(`"to" is required for ${action}.`);
        const d = abs(to);
        if (!existsSync(p)) return fail(`No such source: ${p}`);
        mkdirSync(dirname(d), {recursive: true});
        if (action === 'move') { renameSync(p, d); return text(`Moved ${p} -> ${d}.`); }
        // copy (via PowerShell for folder support)
        await ps(`Copy-Item -LiteralPath '${p.replace(/'/g, "''")}' -Destination '${d.replace(/'/g, "''")}' -Recurse -Force`);
        return text(`Copied ${p} -> ${d}.`);
      },
    },

    // ---- exec: processes, launching, screen ------------------------------
    {
      name: 'kill_process',
      risk: 'exec',
      description: 'Stop a running process by its PID or by name (stops all matching that name).',
      shape: {
        pid: z.number().optional().describe('Process id to stop.'),
        name: z.string().optional().describe('Process name to stop (all matches), e.g. notepad.'),
      },
      summarize: a => ({title: 'Stop a process', detail: a.pid ? `PID ${a.pid}` : `name: ${a.name}`}),
      run: async ({pid, name}) => {
        if (!pid && !name) return fail('Give a pid or a name.');
        const cmd = pid ? `Stop-Process -Id ${pid} -Force -PassThru | Select-Object Id,ProcessName`
          : `Stop-Process -Name '${String(name).replace(/'/g, "''")}' -Force -PassThru | Select-Object Id,ProcessName`;
        const r = await ps(cmd);
        return r.err && !r.out ? fail(r.err) : text(r.out || 'Stopped.');
      },
    },
    {
      name: 'open_path',
      risk: 'exec',
      description: 'Open a file, folder, app, or URL with its default handler (like double-clicking it). e.g. a URL in the browser, a .docx in Word, Explorer for a folder.',
      shape: {target: z.string().describe('A file path, folder, app name, or URL (http/https).')},
      summarize: a => ({title: 'Open something', detail: a.target}),
      run: async ({target}) => {
        const t = /^https?:\/\//i.test(target) ? target : abs(target);
        await ps(`Start-Process '${t.replace(/'/g, "''")}'`, {timeoutMs: 15000});
        return text(`Opened ${target}.`);
      },
    },
    {
      name: 'screenshot',
      risk: 'exec',
      description: 'Capture the PC screen right now and return it as an image, so you can SEE what is on screen. Use when the user asks what is on their screen, or to verify a visual result.',
      shape: {},
      summarize: () => ({title: 'Capture the screen', detail: 'Takes a screenshot of the desktop and sends it to ChatGPT.'}),
      run: async () => {
        const dir = mkdtempSync(join(tmpdir(), 'pc-shot-'));
        const out = join(dir, 'shot.png');
        await ps(`& '${SHOT.replace(/'/g, "''")}' -Out '${out.replace(/'/g, "''")}'`, {timeoutMs: 20000});
        if (!existsSync(out)) { try { rmSync(dir, {recursive: true, force: true}); } catch {} return fail('Could not capture the screen (is anyone logged in?).'); }
        const b64 = readFileSync(out).toString('base64');
        try { rmSync(dir, {recursive: true, force: true}); } catch {}
        return {content: [{type: 'image', data: b64, mimeType: 'image/png'}, {type: 'text', text: 'Screenshot captured.'}]};
      },
    },
  ];
}
