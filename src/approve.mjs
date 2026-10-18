// Local approval gate. Shows a topmost dialog on THIS PC and blocks until the
// human clicks Approve/Deny (or it times out). This is the real security
// boundary: nothing executes without a click here, even if the token leaks.
import {spawn} from 'node:child_process';
import {writeFileSync, rmSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT = fileURLToPath(new URL('./approve.ps1', import.meta.url));

export function autoApproved(command, patterns) {
  return (patterns || []).some(p => { try { return new RegExp(p, 'i').test(command); } catch { return false; } });
}

// Returns 'approved' | 'denied' | 'timeout'.
export function requestApproval({command, cwd, timeoutMs}) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-approve-'));
  const reqFile = join(dir, 'req.json');
  writeFileSync(reqFile, JSON.stringify({command, cwd}));
  const timeoutSec = Math.max(3, Math.round(timeoutMs / 1000));
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (done) return; done = true; clearTimeout(killer); try { rmSync(dir, {recursive: true, force: true}); } catch {} resolve(r); };
    // Visible window (STA by default in Windows PowerShell); not hidden, so its timer runs.
    const child = spawn('powershell.exe', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-RequestFile', reqFile, '-TimeoutSec', String(timeoutSec)]);
    // Hard backstop in case the dialog can't show (e.g. no interactive desktop).
    const killer = setTimeout(() => { try { child.kill(); } catch {} finish('timeout'); }, timeoutMs + 4000);
    child.on('exit', code => finish(code === 0 ? 'approved' : code === 2 ? 'timeout' : 'denied'));
    child.on('error', () => finish('denied'));
  });
}
