// Runs a command in PowerShell, capturing stdout, stderr and exit code.
import {spawn} from 'node:child_process';
import {writeFileSync, rmSync, mkdtempSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const cap = (s, max) => s.length > max ? s.slice(0, 2000) + `\n…[${s.length - max} chars omitted]…\n` + s.slice(s.length - (max - 2000)) : s;

export function runCommand({command, cwd, timeoutMs, maxOutputChars}) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-exec-'));
  const scriptFile = join(dir, 'cmd.ps1');
  writeFileSync(scriptFile, '﻿' + command, 'utf8');
  const workdir = cwd && existsSync(cwd) ? cwd : undefined;
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {cwd: workdir, windowsHide: true});
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => {
      clearTimeout(timer);
      try { rmSync(dir, {recursive: true, force: true}); } catch {}
      resolve({exitCode: timedOut ? null : code, timedOut, stdout: cap(out, maxOutputChars), stderr: cap(err, maxOutputChars), cwd: workdir || process.cwd()});
    });
    child.on('error', e => { clearTimeout(timer); resolve({exitCode: null, error: e.message, stdout: '', stderr: e.message, cwd: workdir || process.cwd()}); });
  });
}
