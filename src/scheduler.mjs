// Scheduled tasks: run a command on a repeating interval (or once after a delay),
// even when you're not chatting. Persisted to data/schedules.json and re-armed on
// startup. Honors the safety guard (won't auto-run catastrophic commands) and can
// notify you with the result.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {runCommand} from './exec.mjs';
import {loadGuard, assess} from './guard.mjs';
import {sendNotify} from './notify.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
let file, cfg, guard, seq = 0, timer = null;
let tasks = [];

const save = () => { try { writeFileSync(file, JSON.stringify(tasks, null, 2) + '\n'); } catch {} };
const load = () => { try { tasks = JSON.parse(readFileSync(file, 'utf8')); } catch { tasks = []; } };

async function runTask(t) {
  t.lastRun = Date.now();
  const g = assess({name: 'run_command'}, {command: t.command}, guard);
  if (g.level === 'block') { t.lastStatus = 'blocked'; t.lastOutput = g.reason; save(); try { await sendNotify(cfg, `⛔ Scheduled "${t.name}" blocked by safety guard.`); } catch {} return; }
  const r = await runCommand({command: t.command, cwd: cfg.defaultCwd, timeoutMs: cfg.commandTimeoutMs || 110000, maxOutputChars: 8000});
  t.lastStatus = r.timedOut ? 'timeout' : `exit ${r.exitCode}`;
  t.lastOutput = ((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')).trim().slice(0, 4000);
  if (t.once) t.enabled = false; else t.nextRun = Date.now() + t.everyMinutes * 60000;
  save();
  if (t.notify) { try { await sendNotify(cfg, `⏰ Scheduled "${t.name}" ran (${t.lastStatus}).\n${t.lastOutput.slice(0, 500)}`); } catch {} }
}

function tick() {
  const now = Date.now();
  for (const t of tasks) if (t.enabled && t.nextRun <= now) runTask(t).catch(() => {});
}

export function initScheduler(config) {
  cfg = config; guard = loadGuard(config.dataDir);
  file = join(config.dataDir, 'schedules.json');
  load();
  for (const t of tasks) { const n = Number((t.id || '').replace('sched', '')); if (n > seq) seq = n; }
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 30000);
  timer.unref?.();
}

export function makeSchedulerTools() {
  return [
    {
      name: 'schedule_task', risk: 'write',
      description: 'Schedule a command to run automatically — repeating every N minutes, or once after a delay. Optionally notify you with the result. Runs even when you are not chatting.',
      shape: {
        name: z.string().describe('A short name for the task.'),
        command: z.string().describe('The command to run.'),
        every_minutes: z.number().describe('Interval in minutes (e.g. 60 = hourly, 1440 = daily). For a one-shot, this is the delay before it runs.'),
        once: z.boolean().optional().describe('If true, run a single time after every_minutes, then stop.'),
        notify: z.boolean().optional().describe('If true, send you a notification with the result each run.'),
      },
      summarize: a => ({title: `Schedule "${a.name}"`, detail: `${a.once ? 'once after' : 'every'} ${a.every_minutes} min${a.notify ? ' (notify)' : ''}\n${a.command}`}),
      run: async ({name, command, every_minutes, once, notify}) => {
        const id = 'sched' + (++seq);
        tasks.push({id, name, command, everyMinutes: Math.max(1, every_minutes), once: !!once, notify: !!notify, enabled: true, nextRun: Date.now() + Math.max(1, every_minutes) * 60000, lastRun: null, lastStatus: null, lastOutput: null});
        save();
        return text(`Scheduled "${name}" (${id}) — ${once ? 'once after' : 'every'} ${every_minutes} min. First run at ${new Date(Date.now() + every_minutes * 60000).toLocaleString()}.`);
      },
    },
    {
      name: 'list_scheduled', risk: 'read',
      description: 'List scheduled tasks and when they next run / last ran.',
      shape: {},
      summarize: () => ({title: 'List scheduled tasks', detail: ''}),
      run: async () => {
        if (!tasks.length) return text('No scheduled tasks.');
        return text(tasks.map(t => `${t.id}  ${t.enabled ? 'on ' : 'off'}  "${t.name}"  ${t.once ? 'once' : 'every ' + t.everyMinutes + 'm'}  next:${t.enabled ? new Date(t.nextRun).toLocaleString() : '-'}  last:${t.lastStatus || '-'}`).join('\n'));
      },
    },
    {
      name: 'cancel_scheduled', risk: 'write',
      description: 'Cancel/remove a scheduled task by id or name.',
      shape: {id_or_name: z.string()},
      summarize: a => ({title: 'Cancel scheduled task', detail: a.id_or_name}),
      run: async ({id_or_name}) => {
        const n = id_or_name.toLowerCase(); const before = tasks.length;
        tasks = tasks.filter(t => t.id.toLowerCase() !== n && t.name.toLowerCase() !== n);
        save();
        return text(before === tasks.length ? `No task matching "${id_or_name}".` : `Cancelled "${id_or_name}".`);
      },
    },
    {
      name: 'run_scheduled_now', risk: 'exec',
      description: 'Run a scheduled task immediately (without waiting for its next time).',
      shape: {id_or_name: z.string()},
      summarize: a => ({title: 'Run scheduled task now', detail: a.id_or_name}),
      run: async ({id_or_name}) => {
        const n = id_or_name.toLowerCase();
        const t = tasks.find(x => x.id.toLowerCase() === n || x.name.toLowerCase() === n);
        if (!t) return text(`No task matching "${id_or_name}".`);
        await runTask(t);
        return text(`Ran "${t.name}" (${t.lastStatus}).\n${(t.lastOutput || '').slice(0, 1500)}`);
      },
    },
  ];
}
