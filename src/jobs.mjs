// Long-running / background jobs. start_job kicks a command off and returns an
// id immediately; job_status streams back its output as it goes; stop_job kills
// it. This lets the agent run builds, big downloads, long scripts, servers, etc.
// without hitting the per-command timeout.
import {spawn} from 'node:child_process';
import {createWriteStream, readFileSync, existsSync, mkdtempSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {shellSpec, isWin} from './shell.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const jobs = new Map(); // id -> {id, command, proc, file, status, code, started, ended}
let seq = 0;

function tail(file, chars = 8000) {
  try { const s = readFileSync(file, 'utf8'); return s.length > chars ? '…' + s.slice(-chars) : s; } catch { return ''; }
}

export function makeJobTools(config) {
  const home = () => process.env.USERPROFILE || homedir();
  return [
    {
      name: 'start_job',
      risk: 'exec',
      description: 'Start a long-running command in the background and get a job id immediately (for builds, downloads, servers, long scripts). Check on it with job_status.',
      shape: {
        command: z.string().describe('The command to run in the background.'),
        cwd: z.string().optional().describe('Working directory.'),
        label: z.string().optional().describe('A short name to recognize this job.'),
      },
      summarize: a => ({title: `Start background job${a.label ? ': ' + a.label : ''}`, detail: a.command}),
      run: async ({command, cwd, label}) => {
        const id = 'job' + (++seq);
        const dir = mkdtempSync(join(tmpdir(), 'pc-job-'));
        const scriptFile = join(dir, isWin ? 'job.ps1' : 'job.sh');
        const outFile = join(dir, 'out.log');
        const {exe, args} = shellSpec(command, scriptFile);
        const workdir = cwd && existsSync(cwd) ? cwd : home();
        const sink = createWriteStream(outFile);
        const proc = spawn(exe, args, {cwd: workdir, windowsHide: true});
        proc.stdout.pipe(sink); proc.stderr.pipe(sink);
        const job = {id, label: label || '', command, file: outFile, proc, status: 'running', code: null, started: Date.now(), ended: null};
        proc.on('exit', c => { job.status = 'exited'; job.code = c; job.ended = Date.now(); });
        proc.on('error', e => { job.status = 'error'; job.err = e.message; job.ended = Date.now(); });
        jobs.set(id, job);
        return text(`Started ${id}${label ? ' (' + label + ')' : ''}. Use job_status with id "${id}" to see progress.`);
      },
    },
    {
      name: 'job_status',
      risk: 'read',
      description: 'Check a background job: whether it is still running or finished, and its latest output.',
      shape: {id: z.string().describe('The job id from start_job.')},
      summarize: a => ({title: 'Check background job', detail: a.id}),
      run: async ({id}) => {
        const j = jobs.get(id);
        if (!j) return fail(`No job "${id}".`);
        const dur = Math.round(((j.ended || Date.now()) - j.started) / 1000);
        const head = `${j.id}${j.label ? ' (' + j.label + ')' : ''}: ${j.status}${j.code != null ? ' (exit ' + j.code + ')' : ''}  ·  ${dur}s\n$ ${j.command}`;
        return text(`${head}\n\n--- output ---\n${tail(j.file) || '(nothing yet)'}`);
      },
    },
    {
      name: 'list_jobs',
      risk: 'read',
      description: 'List background jobs and their status.',
      shape: {},
      summarize: () => ({title: 'List background jobs', detail: ''}),
      run: async () => {
        if (!jobs.size) return text('No background jobs.');
        return text([...jobs.values()].map(j => `${j.id}  ${j.status.padEnd(8)}  ${j.label || j.command.slice(0, 50)}`).join('\n'));
      },
    },
    {
      name: 'stop_job',
      risk: 'exec',
      description: 'Stop a running background job.',
      shape: {id: z.string().describe('The job id to stop.')},
      summarize: a => ({title: 'Stop background job', detail: a.id}),
      run: async ({id}) => {
        const j = jobs.get(id);
        if (!j) return fail(`No job "${id}".`);
        if (j.status !== 'running') return text(`${id} already ${j.status}.`);
        try { j.proc.kill(); } catch {}
        return text(`Stopped ${id}.`);
      },
    },
  ];
}
