// Developer-agent tools: a to-do/plan the agent maintains, multi-file patch
// editing, a git helper, and a project map. These make it work like a coding agent.
import {readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {homedir} from 'node:os';
import {z} from 'zod';
import {runCommand} from './exec.mjs';
import {snapshot} from './undo.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const abs = p => resolve(String(p).replace(/^~(?=[\\/]|$)/, process.env.USERPROFILE || homedir()));
const MARK = {pending: '☐', in_progress: '▶', done: '☑'};

export function makeDevTools(config) {
  const planFile = join(config.dataDir, 'plan.json');
  const loadPlan = () => { try { return JSON.parse(readFileSync(planFile, 'utf8')); } catch { return []; } };
  const savePlan = p => writeFileSync(planFile, JSON.stringify(p, null, 2) + '\n');
  const git = (repo, args) => runCommand({command: 'git ' + args, cwd: repo, timeoutMs: 60000, maxOutputChars: 60000});

  return [
    {
      name: 'update_plan', risk: 'read',
      description: 'Set or update the task plan (a to-do list) for the current job. Re-send the full list each time with updated statuses. Use this to plan multi-step work and track progress as you go.',
      shape: {steps: z.array(z.object({text: z.string(), status: z.enum(['pending', 'in_progress', 'done']).optional()})).describe('The full ordered list of steps with their statuses.')},
      summarize: a => ({title: 'Update plan', detail: `${a.steps.length} steps`}),
      run: async ({steps}) => {
        const plan = steps.map(s => ({text: s.text, status: s.status || 'pending'}));
        savePlan(plan);
        return text('Plan updated:\n' + plan.map((s, i) => `${MARK[s.status]} ${i + 1}. ${s.text}`).join('\n'));
      },
    },
    {
      name: 'show_plan', risk: 'read',
      description: 'Show the current task plan and progress.',
      shape: {},
      summarize: () => ({title: 'Show plan', detail: ''}),
      run: async () => {
        const plan = loadPlan();
        return text(plan.length ? plan.map((s, i) => `${MARK[s.status]} ${i + 1}. ${s.text}`).join('\n') : 'No plan yet.');
      },
    },
    {
      name: 'apply_edits', risk: 'write',
      description: 'Apply several find/replace edits across one or more files in a single step (like applying a patch). Validates every find first; if any is missing, nothing is changed. Each edited file is snapshotted so you can undo.',
      shape: {edits: z.array(z.object({path: z.string(), find: z.string(), replace: z.string(), all: z.boolean().optional()})).describe('The edits to apply.')},
      summarize: a => ({title: `Apply ${a.edits.length} edit(s)`, detail: [...new Set(a.edits.map(e => abs(e.path)))].join('\n')}),
      run: async ({edits}) => {
        // validate all first (atomic-ish)
        const files = {};
        for (const e of edits) {
          const p = abs(e.path);
          if (!(p in files)) { if (!existsSync(p)) return fail(`No such file: ${p}`); files[p] = readFileSync(p, 'utf8'); }
          if (!files[p].includes(e.find)) return fail(`Edit not applied — text not found in ${p}:\n${e.find.slice(0, 200)}`);
          files[p] = e.all ? files[p].split(e.find).join(e.replace) : files[p].replace(e.find, e.replace);
        }
        for (const p of Object.keys(files)) { snapshot(p, 'apply_edits'); writeFileSync(p, files[p], 'utf8'); }
        return text(`Applied ${edits.length} edit(s) across ${Object.keys(files).length} file(s):\n${Object.keys(files).join('\n')}`);
      },
    },
    {
      name: 'write_files', risk: 'write',
      description: 'Create or overwrite several files at once (scaffold a project, write multiple outputs). Existing files are snapshotted first.',
      shape: {files: z.array(z.object({path: z.string(), content: z.string()}))},
      summarize: a => ({title: `Write ${a.files.length} file(s)`, detail: a.files.map(f => abs(f.path)).join('\n')}),
      run: async ({files}) => {
        for (const f of files) { const p = abs(f.path); mkdirSync(dirname(p), {recursive: true}); if (existsSync(p)) snapshot(p, 'write_files'); writeFileSync(p, f.content, 'utf8'); }
        return text(`Wrote ${files.length} file(s):\n${files.map(f => abs(f.path)).join('\n')}`);
      },
    },
    {
      name: 'git', risk: 'exec',
      description: 'Run common git actions in a repo: status, diff, log, add, commit, branch, checkout, push, pull, or a raw arg string.',
      shape: {
        action: z.enum(['status', 'diff', 'log', 'add', 'commit', 'branch', 'checkout', 'push', 'pull', 'raw']),
        repo: z.string().optional().describe('Repo folder (defaults to home).'),
        message: z.string().optional().describe('Commit message (for commit).'),
        args: z.string().optional().describe('Extra args, or the full arg string for "raw".'),
      },
      summarize: a => ({title: `git ${a.action}`, detail: `${a.repo || '(home)'}${a.message ? '  "' + a.message + '"' : ''}${a.args ? '  ' + a.args : ''}`}),
      run: async ({action, repo, message, args}) => {
        const dir = abs(repo || (process.env.USERPROFILE || homedir()));
        const map = {
          status: 'status', diff: 'diff', log: 'log --oneline -20', branch: 'branch -a',
          add: `add ${args || '.'}`, commit: `commit -m ${JSON.stringify(message || 'update')}`,
          checkout: `checkout ${args || ''}`, push: `push ${args || ''}`, pull: `pull ${args || ''}`, raw: args || '',
        };
        const r = await git(dir, map[action]);
        const out = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
        return text(`git ${action} (exit ${r.exitCode}) in ${dir}\n\n${out || '(no output)'}`);
      },
    },
    {
      name: 'project_tree', risk: 'read',
      description: 'Show a folder as an indented tree (skips node_modules/.git etc). Good for understanding a project layout.',
      shape: {path: z.string().optional(), depth: z.number().optional().describe('Max depth (default 3).')},
      summarize: a => ({title: 'Project tree', detail: a.path || '(home)'}),
      run: async ({path, depth}) => {
        const root = abs(path || (process.env.USERPROFILE || homedir()));
        if (!existsSync(root)) return fail(`No such folder: ${root}`);
        const maxD = depth || 3; const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '$Recycle.Bin']);
        const lines = []; let count = 0;
        const walk = (dir, prefix, d) => {
          if (d > maxD || count > 800) return;
          let entries; try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
          entries = entries.filter(e => !SKIP.has(e.name)).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
          for (const e of entries) {
            if (count++ > 800) { lines.push(prefix + '…(truncated)'); return; }
            lines.push(prefix + (e.isDirectory() ? '📁 ' : '   ') + e.name);
            if (e.isDirectory()) walk(join(dir, e.name), prefix + '  ', d + 1);
          }
        };
        lines.push(root); walk(root, '  ', 1);
        return text(lines.join('\n').slice(0, 100000));
      },
    },
  ];
}
