// One place that knows how to run a shell command on each OS, so the rest of the
// code is platform-agnostic.
//   Windows -> PowerShell (script file, UTF-8 BOM)
//   macOS/Linux -> /bin/sh (script file)
// This is what lets the controlled machine be Windows, a Mac, or a Linux box.
import {writeFileSync} from 'node:fs';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const shellName = isWin ? 'PowerShell' : 'sh';

// Write `command` to `scriptPath` and return {exe, args} to execute it.
export function shellSpec(command, scriptPath) {
  if (isWin) {
    writeFileSync(scriptPath, '﻿' + command, 'utf8'); // BOM so PS reads UTF-8
    return {exe: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]};
  }
  writeFileSync(scriptPath, command, 'utf8');
  return {exe: '/bin/sh', args: [scriptPath]};
}
