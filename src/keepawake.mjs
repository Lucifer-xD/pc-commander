// Keeps the machine from sleeping while long work runs. Refcounted: jobs/schedules
// hold() while active and release() when done; the keep_awake tool can pin it too.
// Windows: a background process holding SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED).
import {spawn} from 'node:child_process';
import {isWin, isMac} from './shell.mjs';

let proc = null, refs = 0, pinned = false;

function start() {
  if (proc || !isWin) return;
  const ps = 'Add-Type -Namespace W -Name K -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);\'; '
    + '[W.K]::SetThreadExecutionState(0x80000001) | Out-Null; while ($true) { Start-Sleep -Seconds 50; [W.K]::SetThreadExecutionState(0x80000001) | Out-Null }';
  try { proc = spawn('powershell.exe', ['-NoProfile', '-Command', ps], {windowsHide: true}); proc.on('exit', () => { proc = null; }); } catch { proc = null; }
}
function stopIfIdle() { if (refs <= 0 && !pinned && proc) { try { proc.kill(); } catch {} proc = null; } }

export function hold() { refs++; start(); }
export function release() { refs = Math.max(0, refs - 1); stopIfIdle(); }
export function pin(on) { pinned = !!on; if (pinned) start(); else stopIfIdle(); return active(); }
export function active() { return !!proc; }
export function supported() { return isWin; }
