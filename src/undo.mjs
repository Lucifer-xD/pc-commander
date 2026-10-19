// Undo safety net:
//  - deletes go to the Recycle Bin / Trash (recoverable), not permanent
//  - every write/edit snapshots the previous file first
//  - restore_backup / undo_last bring content back
import {readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync} from 'node:fs';
import {join, basename} from 'node:path';
import {z} from 'zod';
import {runCommand} from './exec.mjs';
import {isWin, isMac} from './shell.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});

let backupsDir, regFile;
const load = () => { try { return JSON.parse(readFileSync(regFile, 'utf8')); } catch { return []; } };
const save = l => { try { writeFileSync(regFile, JSON.stringify(l, null, 2) + '\n'); } catch {} };

export function initUndo(config) {
  backupsDir = join(config.dataDir, 'backups');
  regFile = join(config.dataDir, 'backups.json');
  mkdirSync(backupsDir, {recursive: true});
}

// Snapshot a file before it is changed/overwritten. Safe no-op if it doesn't exist.
export function snapshot(path, action = 'edit') {
  try {
    if (!backupsDir || !existsSync(path) || statSync(path).isDirectory()) return null;
    const id = 'bak' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const dest = join(backupsDir, id + '__' + basename(path));
    copyFileSync(path, dest);
    const reg = load(); reg.unshift({id, path, backup: dest, action, time: Date.now()}); save(reg.slice(0, 200));
    return id;
  } catch { return null; }
}

// Send a path to the Recycle Bin / Trash instead of deleting permanently.
export async function recycle(path) {
  let cmd;
  if (isWin) cmd = `Add-Type -AssemblyName Microsoft.VisualBasic; $p='${path.replace(/'/g, "''")}'; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }`;
  else if (isMac) cmd = `mkdir -p ~/.Trash && mv '${path.replace(/'/g, "'\\''")}' ~/.Trash/`;
  else cmd = `(command -v gio >/dev/null && gio trash '${path.replace(/'/g, "'\\''")}') || (mkdir -p ~/.local/share/Trash/files && mv '${path.replace(/'/g, "'\\''")}' ~/.local/share/Trash/files/)`;
  const r = await runCommand({command: cmd, timeoutMs: 30000, maxOutputChars: 4000});
  return {ok: (r.exitCode === 0 || r.exitCode === null) && !r.stderr.trim(), err: r.stderr.trim()};
}

export function makeUndoTools() {
  return [
    {
      name: 'list_backups', risk: 'read',
      description: 'List recent file snapshots taken before changes (for undo/restore).',
      shape: {},
      summarize: () => ({title: 'List backups', detail: ''}),
      run: async () => {
        const reg = load();
        if (!reg.length) return text('No backups yet.');
        return text(reg.slice(0, 40).map(b => `${b.id}  ${new Date(b.time).toLocaleString()}  ${b.action}  ${b.path}`).join('\n'));
      },
    },
    {
      name: 'restore_backup', risk: 'write',
      description: 'Restore a file from a snapshot id (from list_backups), putting the old content back.',
      shape: {id: z.string()},
      summarize: a => ({title: 'Restore a backup', detail: a.id}),
      run: async ({id}) => {
        const b = load().find(x => x.id === id);
        if (!b) return fail(`No backup "${id}".`);
        if (!existsSync(b.backup)) return fail(`Backup data missing for ${id}.`);
        snapshot(b.path, 'pre-restore');
        copyFileSync(b.backup, b.path);
        return text(`Restored ${b.path} from ${id}.`);
      },
    },
    {
      name: 'undo_last', risk: 'write',
      description: 'Undo the most recent file change by restoring its snapshot.',
      shape: {},
      summarize: () => ({title: 'Undo last file change', detail: ''}),
      run: async () => {
        const reg = load();
        const b = reg.find(x => x.action !== 'pre-restore');
        if (!b) return fail('Nothing to undo.');
        if (!existsSync(b.backup)) return fail('Backup data missing.');
        copyFileSync(b.backup, b.path);
        return text(`Undid the last change to ${b.path} (restored snapshot ${b.id}).`);
      },
    },
  ];
}
