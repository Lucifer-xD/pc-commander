// Safety guard. Looks at an action BEFORE it runs and can:
//   block   - refuse outright (catastrophic / irreversible), even in Always-allow
//   confirm - force the Approve dialog even in Always-allow mode
//   ok      - let the normal risk/mode rules decide
// Tunable via data/guard.json. The point: "hands-off" should still be safe from
// disasters and typos.
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';

// System locations: writing/deleting INSIDE these is blocked.
const SYSTEM_DIRS = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
  '/etc', '/bin', '/sbin', '/usr', '/boot', '/var', '/lib', '/lib64',
  '/System', '/Library', '/private',
];
// Whole-disk roots: deleting/formatting these (or an ancestor of a system dir) is blocked.
const ROOTS = ['C:\\', 'D:\\', 'E:\\', '/'];

// Catastrophic command shapes -> hard block.
const BLOCK = [
  /rm\s+-rf?\s+(--no-preserve-root\s+)?\/(?:\s|$|\*|\.)/i,
  /\bmkfs\.[a-z0-9]+\b|\bmkfs\s/i,
  /\bdd\b[^\n|]*\bof=\/dev\/[sh]d/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /format\s+[a-z]:\s*\/(q|y|fs)/i,
  /Format-Volume\b/i,
  /Remove-Item\s+(-[A-Za-z]+\s+)*['"]?[cC]:\\?['"]?\s+(-Recurse|-Force|\s|$)/i,
  /\bdel\s+\/[sfq]\s+[cC]:\\\*/i,
  /cipher\s+\/w/i,
  /Clear-Disk\b|Initialize-Disk\b/i,
];
// Sensitive but legitimate -> force a confirmation click.
const CONFIRM = [
  /\bshutdown\b|Restart-Computer|Stop-Computer|\breboot\b|\bhalt\b|\bpoweroff\b/i,
  /\bdiskpart\b/i,
  /reg\s+delete|Remove-Item\s+-?Path?\s*['"]?HK(LM|CU|CR|U|CC)/i,
  /net\s+user\s+\S+\s+\/(add|delete)|New-LocalUser|Remove-LocalUser/i,
  /Set-ExecutionPolicy/i,
  /netsh\s+advfirewall|New-NetFirewallRule|Disable-NetAdapter/i,
  /\buninstall\b|Uninstall-Package|Uninstall-WindowsFeature/i,
];

const toRe = p => { try { return new RegExp(p, 'i'); } catch { return /^\b$/; } };
const home = () => process.env.USERPROFILE || homedir();
const norm = p => resolve(String(p).replace(/^~(?=[\\/]|$)/, home())).replace(/[\\/]+$/, '').toLowerCase() || '/';
const inside = (t, dir) => { const nd = norm(dir); return t === nd || t.startsWith(nd + '\\') || t.startsWith(nd + '/'); };

export function loadGuard(dataDir) {
  let user = {};
  try { user = JSON.parse(readFileSync(join(dataDir, 'guard.json'), 'utf8')); } catch {}
  return {
    enabled: user.enabled !== false,
    systemDirs: [...SYSTEM_DIRS, ...(user.protectedPaths || [])],
    roots: ROOTS,
    allowedRoots: (user.allowedRoots || []).map(norm),
    block: [...BLOCK, ...(user.block || []).map(toRe)],
    confirm: [...CONFIRM, ...(user.confirm || []).map(toRe)],
  };
}

// Returns {level:'ok'|'confirm'|'block', reason}.
export function assess(tool, args, g) {
  if (!g.enabled) return {level: 'ok'};
  const name = tool.name;

  const cmd = args.command || '';
  if (cmd) {
    for (const re of g.block) if (re.test(cmd)) return {level: 'block', reason: `This looks catastrophic and is blocked by the safety guard. Nothing was run.`};
    for (const re of g.confirm) if (re.test(cmd)) return {level: 'confirm', reason: 'This is a sensitive system action — confirming on the PC first.'};
  }

  const destructive = (name === 'manage_path' && (args.action === 'delete' || args.action === 'move')) || name === 'write_file' || name === 'edit_file';
  if (destructive) {
    const target = args.path || args.to || '';
    if (target) {
      const t = norm(target);
      // writing/deleting inside a system location
      for (const d of g.systemDirs) if (inside(t, d)) return {level: 'block', reason: `Refusing to modify ${target} — it is inside a protected system location (${d}).`};
      // deleting a whole drive root, or a folder that CONTAINS a system location
      if (name === 'manage_path' && args.action === 'delete') {
        for (const d of [...g.roots, ...g.systemDirs]) { const nd = norm(d); if (t === nd || nd.startsWith(t + '\\') || nd.startsWith(t + '/')) return {level: 'block', reason: `Refusing to delete ${target} — it is or contains a protected location.`}; }
      }
      if (g.allowedRoots.length && !g.allowedRoots.some(r => inside(t, r))) return {level: 'confirm', reason: `${target} is outside your allowed folders — confirming first.`};
    }
  }
  return {level: 'ok'};
}
