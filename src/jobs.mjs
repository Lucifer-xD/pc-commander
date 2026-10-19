// Long-running / background jobs — now DURABLE:
//  - output + metadata persist to disk (survive a server restart)
//  - the child is detached (keeps running if the server restarts)
//  - the machine is kept awake while any job runs
//  - you get a notification when a job finishes (if notifications are set up)
import {spawn} from 'node:child_process';
import {openSync, closeSync, writeFileSync, readFileSync, existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {shellSpec, isWin} from './shell.mjs';
import {hold, release} from './keepawake.mjs';
import {sendNotify} from './notify.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const jobs = new Map();
let dir, regFile, cfgRef;
let seq = 0;

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tailFile = (f, chars = 8000) => { try { const s = readFileSync(f, 'utf8'); return s.length > chars ? '…' + s.slice(-chars) : s; } catch { return ''; } };
function persist() {
  const arr = [...jobs.values()].map(j => ({id: j.id, label: j.label, command: j.command, file: j.file, status: j.status, code: j.code, started: j.started, ended: j.ended, pid: j.pid}));
  try { writeFileSync(regFile, JSON.stringify(arr, null, 2) + '\n'); } catch {}
}

export function initJobs(config) {
  cfgRef = config;
  dir = join(config.dataDir, 'jobs');
  regFile = join(config.dataDir, 'jobs.json');
  mkdirSync(dir, {recursive: true});
  // reload previous jobs; re-check which are still alive.
  try {
    for (const j of JSON.parse(readFileSync(regFile, 'utf8'))) {
      const n = Number((j.id || '').replace('job', '')); if (n > seq) seq = n;
      if (j.status === 'running' && j.pid && alive(j.pid)) { jobs.set(j.id, {...j, proc: null}); hold(); }
      else jobs.set(j.id, {...j, proc: null, status: j.status === 'running' ? 'ended' : j.status});
    }
  } catch {}
  persist();
}

export function makeJobTools(config) {
  return [
    {
      name: 'start_job', risk: 'exec',
      description: 'Start a long-running command in the background and get a job id immediately (builds, downloads, long scripts). It keeps running regardless of the chat; check it with job_status. The PC is kept awake while it runs, and you are notified when it finishes. (For jobs that must survive a laptop shutdown, use start_remote_job on a server instead.)',
      shape: {command: z.string(), cwd: z.string().optional(), label: z.string().optional()},
      summarize: a => ({title: `Start background job${a.label ? ': ' + a.label : ''}`, detail: a.command}),
      run: async ({command, cwd, label}) => {
        const id = 'job' + (++seq);
        const scriptFile = join(dir, id + (isWin ? '.ps1' : '.sh'));
        const outFile = join(dir, id + '.log');
        const {exe, args} = shellSpec(command, scriptFile);
        const workdir = cwd && existsSync(cwd) ? cwd : process.env.USERPROFILE || process.cwd();
        const fd = openSync(outFile, 'a');
        const proc = spawn(exe, args, {cwd: workdir, windowsHide: true, stdio: ['ignore', fd, fd]});
        try { closeSync(fd); } catch {}
        const job = {id, label: label || '', command, file: outFile, proc, status: 'running', code: null, started: Date.now(), ended: null, pid: proc.pid};
        jobs.set(id, job); hold(); persist();
        proc.on('exit', async c => {
          job.status = 'exited'; job.code = c; job.ended = Date.now(); job.proc = null; release(); persist();
          try { await sendNotify(config, `✅ Job ${id}${label ? ' (' + label + ')' : ''} finished (exit ${c}).`); } catch {}
        });
        proc.on('error', e => { job.status = 'error'; job.err = e.message; job.ended = Date.now(); release(); persist(); });
        return text(`Started ${id}${label ? ' (' + label + ')' : ''} in the background. Check it with job_status id "${id}".`);
      },
    },
    {
      name: 'job_status', risk: 'read',
      description: 'Check a background job: whether it is still running or finished, and its latest output.',
      shape: {id: z.string()},
      summarize: a => ({title: 'Check background job', detail: a.id}),
      run: async ({id}) => {
        const j = jobs.get(id);
        if (!j) return fail(`No job "${id}".`);
        if (j.status === 'running' && j.pid && !alive(j.pid)) { j.status = 'ended'; j.ended = Date.now(); persist(); }
        const dur = Math.round(((j.ended || Date.now()) - j.started) / 1000);
        const head = `${j.id}${j.label ? ' (' + j.label + ')' : ''}: ${j.status}${j.code != null ? ' (exit ' + j.code + ')' : ''}  ·  ${dur}s\n$ ${j.command}`;
        return text(`${head}\n\n--- output ---\n${tailFile(j.file) || '(nothing yet)'}`);
      },
    },
    {
      name: 'list_jobs', risk: 'read',
      description: 'List background jobs and their status.',
      shape: {},
      summarize: () => ({title: 'List background jobs', detail: ''}),
      run: async () => {
        if (!jobs.size) return text('No background jobs.');
        for (const j of jobs.values()) if (j.status === 'running' && j.pid && !alive(j.pid)) { j.status = 'ended'; j.ended = Date.now(); }
        persist();
        return text([...jobs.values()].map(j => `${j.id}  ${j.status.padEnd(8)}  ${j.label || j.command.slice(0, 50)}`).join('\n'));
      },
    },
    {
      name: 'stop_job', risk: 'exec',
      description: 'Stop a running background job.',
      shape: {id: z.string()},
      summarize: a => ({title: 'Stop background job', detail: a.id}),
      run: async ({id}) => {
        const j = jobs.get(id);
        if (!j) return fail(`No job "${id}".`);
        if (j.status !== 'running') return text(`${id} already ${j.status}.`);
        try { if (j.proc) j.proc.kill(); else if (j.pid) process.kill(j.pid); } catch {}
        j.status = 'stopped'; j.ended = Date.now(); release(); persist();
        return text(`Stopped ${id}.`);
      },
    },
  ];
}
