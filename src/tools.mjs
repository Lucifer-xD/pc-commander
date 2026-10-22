// The agent's core capabilities. Each tool declares a risk level that decides
// whether it runs straight away or waits for a local Approve click:
//   read  - inspects the machine, never changes it -> auto (no prompt)
//   write - creates/changes/deletes files          -> prompt (unless Always-allow)
//   exec  - runs code / launches / kills / captures -> prompt (unless Always-allow)
// Cross-platform: file tools use Node fs; system/screen tools branch per OS.
import {readFileSync, writeFileSync, appendFileSync, statSync, readdirSync, existsSync, mkdirSync, rmSync, renameSync, cpSync, mkdtempSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {tmpdir, homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {runCommand} from './exec.mjs';
import {isWin, isMac} from './shell.mjs';
import {snapshot, recycle} from './undo.mjs';
import {resolveSecrets} from './secrets.mjs';

const SHOT = fileURLToPath(new URL('./screenshot.ps1', import.meta.url));
const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const home = () => process.env.USERPROFILE || homedir();
const abs = p => resolve(String(p).replace(/^~(?=[\\/]|$)/, home()));
const human = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const CAP = 200000;

// Paging. ChatGPT (and other MCP hosts) clip long tool results in the MIDDLE before the
// model sees them, so a 60 KB file arrives with its centre missing. Big outputs are
// therefore returned one page at a time, with an explicit "next offset" hint.
export const DEFAULT_PAGE = 12000;
const MAX_PAGE = 40000;

/** Cut text[offset, offset+length) at a line break near the end when one is close. */
export function pageOf(textAll, offset, length) {
  const total = textAll.length;
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, total));
  let end = Math.min(total, start + length);
  if (end < total) {
    const nl = textAll.lastIndexOf('\n', end);
    if (nl > start + Math.floor(length * 0.8)) end = nl + 1;
  }
  return {start, end, total, chunk: textAll.slice(start, end)};
}

/** Footer telling the model exactly how to get the rest. */
export function pageFooter({start, end, total}, how) {
  if (end >= total) return start > 0 ? `\n[end — this was the last page, characters ${start}–${end} of ${total}]` : '';
  return `\n[page: characters ${start}–${end} of ${total} · ${total - end} more — ${how(end)}]`;
}

// The continuation also travels in the PATH ("C:\file.txt::12000", "pc-output://out_x::12000"),
// because MCP hosts such as ChatGPT cache the tool schema and may not know the offset parameter.
function splitPathOffset(raw) {
  const m = String(raw).match(/^(.*)::(\d+)$/);
  return m ? {path: m[1], offset: Number(m[2])} : {path: String(raw), offset: undefined};
}
export const OUTPUT_SCHEME = 'pc-output://';

// run_command output that did not fit one page, kept for read_output (newest 30, 30 min).
const outputs = new Map();
export function keepOutput(textAll) {
  const id = 'out_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  outputs.set(id, {text: textAll, at: Date.now()});
  for (const [k, v] of outputs) if (Date.now() - v.at > 30 * 60_000) outputs.delete(k);
  while (outputs.size > 30) outputs.delete(outputs.keys().next().value);
  return id;
}
const wildToRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

async function sh(command, {timeoutMs = 60000} = {}) {
  const r = await runCommand({command, cwd: home(), timeoutMs, maxOutputChars: CAP});
  if (r.timedOut) throw new Error('timed out');
  return {out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trimEnd(), code: r.exitCode};
}

// Bounded recursive walk (portable). Calls visit(fullPath, dirent); stop when budget hits 0.
function walk(root, visit, {maxVisits = 50000} = {}) {
  let budget = maxVisits;
  const stack = [root];
  const SKIP = new Set(['node_modules', '.git', '$Recycle.Bin', 'Windows', 'AppData']);
  while (stack.length && budget > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { continue; }
    for (const e of entries) {
      if (budget-- <= 0) break;
      const full = join(dir, e.name);
      visit(full, e);
      if (e.isDirectory() && !SKIP.has(e.name)) stack.push(full);
    }
  }
}

export function makeTools(config) {
  const cmdTimeout = config.commandTimeoutMs || 110000;

  return [
    // ---- exec: shell -----------------------------------------------------
    {
      name: 'run_command',
      risk: 'exec',
      description:
        `Run any ${isWin ? 'PowerShell' : 'shell'} command or script on the user's own computer and return stdout, stderr and exit code. ` +
        'This is the user\'s personal machine and they have authorized it. Use it for anything the other tools don\'t cover: ' +
        'git, builds, tests, installing packages, networking, services, etc. Prefer one self-contained command per call.',
      shape: {
        command: z.string().describe(`The exact ${isWin ? 'PowerShell' : 'shell'} command or script.`),
        cwd: z.string().optional().describe('Absolute working directory. Defaults to the user home.'),
      },
      summarize: a => ({title: `Run a ${isWin ? 'PowerShell' : 'shell'} command`, detail: a.command}),
      run: async ({command, cwd}) => {
        command = resolveSecrets(config.dataDir, command);
        const r = await runCommand({command, cwd: cwd || config.defaultCwd, timeoutMs: cmdTimeout, maxOutputChars: config.maxOutputChars || CAP});
        const parts = [`exit code: ${r.timedOut ? 'timed out' : r.exitCode}`, `cwd: ${r.cwd}`];
        if (r.stdout.trim()) parts.push('--- stdout ---\n' + r.stdout.trimEnd());
        if (r.stderr.trim()) parts.push('--- stderr ---\n' + r.stderr.trimEnd());
        if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(no output)');
        const all = parts.join('\n');
        const page = config.pageChars || DEFAULT_PAGE;
        if (all.length <= page) return text(all);
        // long output: first page now, the rest via read_output
        const id = keepOutput(all);
        const pg = pageOf(all, 0, page);
        return text(pg.chunk + pageFooter(pg, (next) => `call read_file with path="${OUTPUT_SCHEME}${id}::${next}" for the next page`));
      },
    },

    // ---- read: files & folders (portable) --------------------------------
    {
      name: 'read_file', risk: 'read',
      description:
        'Read a text file on the computer. Large files are returned one PAGE at a time (default 12,000 characters): ' +
        'the reply ends with "[page: characters A–B of N · … call read_file with path=\\"<file>::B\\" …]" — call read_file again ' +
        'exactly as the footer says (the "::B" suffix is the offset; the offset parameter works too) until it says "[end …]". ' +
        'Read every page when the whole file matters; do not assume the rest. Long run_command output continues the same way.',
      shape: {
        path: z.string().describe('Absolute path (~ allowed).'),
        offset: z.number().optional().describe('Character offset to start from (0 = beginning). Use the offset from the previous page footer.'),
        length: z.number().optional().describe(`Characters to return (default ${DEFAULT_PAGE}, max ${MAX_PAGE}).`),
        max_bytes: z.number().optional().describe('Deprecated alias of length.'),
      },
      summarize: a => ({title: 'Read a file', detail: `${a.path}${a.offset ? `  (from ${a.offset})` : ''}`}),
      run: async ({path, offset, length, max_bytes}) => {
        const sp = splitPathOffset(path);
        const off = offset ?? sp.offset ?? 0;
        const len = Math.max(1, Math.min(Math.floor(length || max_bytes || config.pageChars || DEFAULT_PAGE), MAX_PAGE));
        // a long run_command output, continued through read_file
        if (sp.path.startsWith(OUTPUT_SCHEME)) {
          const id = sp.path.slice(OUTPUT_SCHEME.length);
          const o = outputs.get(id);
          if (!o) return fail(`Unknown or expired output "${id}" (outputs are kept 30 minutes). Re-run the command.`);
          const pg = pageOf(o.text, off, len);
          return text(pg.chunk + pageFooter(pg, (next) => `call read_file with path="${OUTPUT_SCHEME}${id}::${next}" for the next page`));
        }
        const p = abs(sp.path);
        if (!existsSync(p)) return fail(`No such file: ${p}`);
        const st = statSync(p);
        if (st.isDirectory()) return fail(`${p} is a folder — use list_dir.`);
        const data = readFileSync(p, 'utf8');
        const pg = pageOf(data, off, len);
        if (pg.start >= pg.total && pg.total > 0) return fail(`offset ${pg.start} is past the end of ${p} (${pg.total} characters).`);
        const head = pg.end - pg.start < pg.total ? `${p}  (${human(st.size)}, ${pg.total} characters — showing ${pg.start}–${pg.end})` : `${p}  (${human(st.size)})`;
        return text(`${head}\n\n${pg.chunk}${pageFooter(pg, (next) => `call read_file with path="${p}::${next}" for the next page`)}`);
      },
    },
    {
      name: 'read_output', risk: 'read',
      description: 'Read the next page of a long run_command output. Use the output_id and offset from the "[page: …]" footer of run_command.',
      shape: {
        output_id: z.string().describe('The output_id from the run_command footer.'),
        offset: z.number().describe('Character offset from the previous footer.'),
        length: z.number().optional().describe(`Characters to return (default ${DEFAULT_PAGE}, max ${MAX_PAGE}).`),
      },
      summarize: a => ({title: 'Read command output', detail: `${a.output_id} from ${a.offset}`}),
      run: async ({output_id, offset, length}) => {
        const o = outputs.get(output_id);
        if (!o) return fail(`Unknown or expired output_id "${output_id}" (outputs are kept 30 minutes). Re-run the command.`);
        const len = Math.max(1, Math.min(Math.floor(length || config.pageChars || DEFAULT_PAGE), MAX_PAGE));
        const pg = pageOf(o.text, offset, len);
        return text(pg.chunk + pageFooter(pg, (next) => `call read_file with path="${OUTPUT_SCHEME}${output_id}::${next}" for the next page`));
      },
    },
    {
      name: 'list_dir', risk: 'read',
      description: 'List the contents of a folder (names, type, size, modified date).',
      shape: {path: z.string().optional().describe('Folder path. Defaults to home.')},
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
      name: 'find_files', risk: 'read',
      description: 'Find files/folders by name pattern under a folder (recursive). Great for "where is X".',
      shape: {pattern: z.string().describe('Wildcard, e.g. *.pdf, invoice*'), path: z.string().optional(), max_results: z.number().optional()},
      summarize: a => ({title: 'Find files by name', detail: `${a.pattern} in ${a.path || '(home)'}`}),
      run: async ({pattern, path, max_results}) => {
        const root = abs(path || home());
        if (!existsSync(root)) return fail(`No such folder: ${root}`);
        const re = wildToRe(pattern); const limit = max_results || 200; const hits = [];
        walk(root, (full, e) => { if (hits.length < limit && re.test(e.name)) hits.push(full); });
        return text(hits.length ? `Matches for "${pattern}" under ${root}:\n\n${hits.join('\n')}` : `No files matching "${pattern}" under ${root}.`);
      },
    },
    {
      name: 'search_in_files', risk: 'read',
      description: 'Search file CONTENTS for text/regex under a folder (like grep). Returns path:line: text.',
      shape: {query: z.string(), path: z.string().optional(), include: z.string().optional().describe('Only files matching this wildcard, e.g. *.js'), max_results: z.number().optional()},
      summarize: a => ({title: 'Search inside files', detail: `"${a.query}" in ${a.path || '(home)'}`}),
      run: async ({query, path, include, max_results}) => {
        const root = abs(path || home());
        if (!existsSync(root)) return fail(`No such folder: ${root}`);
        let re; try { re = new RegExp(query, 'i'); } catch { return fail('Invalid search pattern.'); }
        const inc = include ? wildToRe(include) : null;
        const limit = max_results || 200; const hits = [];
        walk(root, (full, e) => {
          if (hits.length >= limit || !e.isFile() || (inc && !inc.test(e.name))) return;
          try { if (statSync(full).size > 2_000_000) return; const lines = readFileSync(full, 'utf8').split(/\r?\n/);
            for (let i = 0; i < lines.length && hits.length < limit; i++) if (re.test(lines[i])) hits.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          } catch {}
        });
        return text(hits.length ? `Matches for "${query}" under ${root}:\n\n${hits.join('\n')}` : `No matches for "${query}" under ${root}.`);
      },
    },

    // ---- read: system (per-OS) -------------------------------------------
    {
      name: 'system_info', risk: 'read',
      description: 'A quick snapshot: OS, CPU, RAM used/total, disk free/total, uptime, computer name.',
      shape: {},
      summarize: () => ({title: 'Read system info', detail: 'OS, CPU, RAM, disks, uptime'}),
      run: async () => {
        if (isWin) {
          const cmd = String.raw`
$os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem; $cpu=(Get-CimInstance Win32_Processor | Select-Object -First 1)
$ramTot=[math]::Round($cs.TotalPhysicalMemory/1GB,1); $ramFree=[math]::Round($os.FreePhysicalMemory/1MB/1024,1)
"Computer : $($cs.Name)"; "OS       : $($os.Caption) $($os.Version)"
"CPU      : $($cpu.Name.Trim()) ($($cpu.NumberOfLogicalProcessors) threads)"
"RAM      : $([math]::Round($ramTot-$ramFree,1)) GB used / $ramTot GB"
"Uptime   : $([math]::Round(((Get-Date)-$os.LastBootUpTime).TotalHours,1)) h"
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "Disk $($_.DeviceID)  $([math]::Round($_.FreeSpace/1GB,1)) GB free / $([math]::Round($_.Size/1GB,1)) GB" }`;
          return text((await sh(cmd, {timeoutMs: 30000})).out);
        }
        const cmd = isMac
          ? 'echo "Computer : $(scutil --get ComputerName 2>/dev/null || hostname)"; echo "OS       : $(sw_vers -productName) $(sw_vers -productVersion)"; echo "CPU      : $(sysctl -n machdep.cpu.brand_string) ($(sysctl -n hw.logicalcpu) threads)"; echo "RAM      : $(echo $(sysctl -n hw.memsize)/1073741824 | bc) GB"; echo "Uptime   : $(uptime)"; df -h /'
          : 'echo "Computer : $(hostname)"; echo "OS       : $(. /etc/os-release 2>/dev/null; echo $PRETTY_NAME) $(uname -r)"; echo "CPU      : $(grep -m1 "model name" /proc/cpuinfo | cut -d: -f2 | xargs) ($(nproc) threads)"; echo "RAM      :"; free -h | awk "/Mem:/{print \$3\" used / \"\$2}"; echo "Uptime   : $(uptime -p)"; df -h /';
        return text((await sh(cmd, {timeoutMs: 30000})).out);
      },
    },
    {
      name: 'list_processes', risk: 'read',
      description: 'List running processes, by default the heaviest by memory. Optionally filter by name.',
      shape: {name: z.string().optional(), top: z.number().optional()},
      summarize: a => ({title: 'List processes', detail: a.name ? `name ~ ${a.name}` : `top ${a.top || 20}`}),
      run: async ({name, top}) => {
        const n = top || 20;
        if (isWin) {
          const filt = name ? `Where-Object { $_.ProcessName -like '*${name.replace(/'/g, "''")}*' } | ` : '';
          const cmd = `Get-Process | ${filt}Sort-Object WS -Descending | Select-Object -First ${n} Id,ProcessName,@{n='Mem(MB)';e={[math]::Round($_.WS/1MB,1)}},@{n='CPU(s)';e={[math]::Round($_.CPU,1)}} | Format-Table -AutoSize | Out-String -Width 120`;
          return text((await sh(cmd, {timeoutMs: 30000})).out || '(none)');
        }
        const grep = name ? ` | grep -i '${name.replace(/'/g, "'\\''")}'` : '';
        return text((await sh(`ps aux --sort=-%mem 2>/dev/null | head -n ${n + 1}${grep} || ps aux | head -n ${n + 1}`, {timeoutMs: 30000})).out || '(none)');
      },
    },

    // ---- write: files (portable) -----------------------------------------
    {
      name: 'write_file', risk: 'write',
      description: 'Create a new file or overwrite an existing one. Creates parent folders as needed.',
      shape: {path: z.string(), content: z.string(), append: z.boolean().optional()},
      summarize: a => ({title: a.append ? 'Append to a file' : 'Write a file', detail: `${abs(a.path)}\n\n${a.content.slice(0, 1500)}${a.content.length > 1500 ? '\n…' : ''}`}),
      run: async ({path, content, append}) => {
        const p = abs(path); mkdirSync(dirname(p), {recursive: true});
        if (!append) snapshot(p, 'write');
        if (append) appendFileSync(p, content, 'utf8'); else writeFileSync(p, content, 'utf8');
        return text(`${append ? 'Appended to' : 'Wrote'} ${p} (${human(Buffer.byteLength(content))}).`);
      },
    },
    {
      name: 'edit_file', risk: 'write',
      description: 'Find and replace text inside an existing file. First match by default; all=true for every match.',
      shape: {path: z.string(), find: z.string(), replace: z.string(), all: z.boolean().optional()},
      summarize: a => ({title: 'Edit a file', detail: `${abs(a.path)}\n\nreplace:\n${a.find.slice(0, 500)}\n\nwith:\n${a.replace.slice(0, 500)}`}),
      run: async ({path, find, replace, all}) => {
        const p = abs(path);
        if (!existsSync(p)) return fail(`No such file: ${p}`);
        const before = readFileSync(p, 'utf8');
        if (!before.includes(find)) return fail(`Text not found in ${p}; nothing changed.`);
        const after = all ? before.split(find).join(replace) : before.replace(find, replace);
        snapshot(p, 'edit');
        writeFileSync(p, after, 'utf8');
        return text(`Replaced ${all ? before.split(find).length - 1 : 1} occurrence(s) in ${p}.`);
      },
    },
    {
      name: 'manage_path', risk: 'write',
      description: 'File/folder housekeeping: create a folder, move/rename, copy, or delete a file or folder. Deletes go to the Recycle Bin (recoverable) unless permanent=true.',
      shape: {action: z.enum(['mkdir', 'move', 'copy', 'delete']), path: z.string(), to: z.string().optional(), permanent: z.boolean().optional().describe('For delete: skip the Recycle Bin and remove permanently.')},
      summarize: a => ({title: `File action: ${a.action}${a.action === 'delete' && !a.permanent ? ' (to Recycle Bin)' : ''}`, detail: a.to ? `${abs(a.path)}  ->  ${abs(a.to)}` : abs(a.path)}),
      run: async ({action, path, to, permanent}) => {
        const p = abs(path);
        if (action === 'mkdir') { mkdirSync(p, {recursive: true}); return text(`Created folder ${p}.`); }
        if (action === 'delete') {
          if (!existsSync(p)) return fail(`No such path: ${p}`);
          if (permanent) { rmSync(p, {recursive: true, force: true}); return text(`Permanently deleted ${p}.`); }
          const r = await recycle(p);
          return r.ok ? text(`Sent ${p} to the Recycle Bin (recoverable).`) : fail(`Could not recycle ${p}: ${r.err}`);
        }
        if (!to) return fail(`"to" is required for ${action}.`);
        const d = abs(to);
        if (!existsSync(p)) return fail(`No such source: ${p}`);
        mkdirSync(dirname(d), {recursive: true});
        if (action === 'move') { renameSync(p, d); return text(`Moved ${p} -> ${d}.`); }
        cpSync(p, d, {recursive: true}); return text(`Copied ${p} -> ${d}.`);
      },
    },

    // ---- exec: processes, launching, screen ------------------------------
    {
      name: 'kill_process', risk: 'exec',
      description: 'Stop a running process by PID or by name (all matching).',
      shape: {pid: z.number().optional(), name: z.string().optional()},
      summarize: a => ({title: 'Stop a process', detail: a.pid ? `PID ${a.pid}` : `name: ${a.name}`}),
      run: async ({pid, name}) => {
        if (!pid && !name) return fail('Give a pid or a name.');
        const cmd = isWin
          ? (pid ? `Stop-Process -Id ${pid} -Force -PassThru | Select-Object Id,ProcessName` : `Stop-Process -Name '${String(name).replace(/'/g, "''")}' -Force -PassThru | Select-Object Id,ProcessName`)
          : (pid ? `kill -9 ${pid} && echo "killed ${pid}"` : `pkill -f '${String(name).replace(/'/g, "'\\''")}' && echo "killed ${name}"`);
        const r = await sh(cmd);
        return r.err && !r.out ? fail(r.err) : text(r.out || 'Stopped.');
      },
    },
    {
      name: 'open_path', risk: 'exec',
      description: 'Open a file, folder, app, or URL with its default handler (like double-clicking it).',
      shape: {target: z.string().describe('A file path, folder, app, or URL.')},
      summarize: a => ({title: 'Open something', detail: a.target}),
      run: async ({target}) => {
        const t = /^https?:\/\//i.test(target) ? target : abs(target);
        const q = t.replace(/'/g, isWin ? "''" : "'\\''");
        const cmd = isWin ? `Start-Process '${q}'` : isMac ? `open '${q}'` : `xdg-open '${q}'`;
        await sh(cmd, {timeoutMs: 15000});
        return text(`Opened ${target}.`);
      },
    },
    {
      name: 'screenshot', risk: 'exec',
      description: 'Capture the screen right now and return it as an image, so you can SEE what is on screen.',
      shape: {},
      summarize: () => ({title: 'Capture the screen', detail: 'Takes a screenshot and sends it to ChatGPT.'}),
      run: async () => {
        const dir = mkdtempSync(join(tmpdir(), 'pc-shot-'));
        const out = join(dir, 'shot.png');
        const q = out.replace(/'/g, isWin ? "''" : "'\\''");
        const cmd = isWin ? `& '${SHOT.replace(/'/g, "''")}' -Out '${q}'`
          : isMac ? `screencapture -x '${q}'`
          : `(command -v scrot >/dev/null && scrot '${q}') || (command -v import >/dev/null && import -window root '${q}') || (command -v gnome-screenshot >/dev/null && gnome-screenshot -f '${q}')`;
        try { await sh(cmd, {timeoutMs: 20000}); } catch {}
        if (!existsSync(out)) { try { rmSync(dir, {recursive: true, force: true}); } catch {} return fail('Could not capture the screen (no display, or no screenshot tool installed).'); }
        const b64 = readFileSync(out).toString('base64');
        try { rmSync(dir, {recursive: true, force: true}); } catch {}
        return {content: [{type: 'image', data: b64, mimeType: 'image/png'}, {type: 'text', text: 'Screenshot captured.'}]};
      },
    },
  ];
}
