// Long-term memory. Lets the agent remember facts across chats (your setup,
// preferences, projects, server notes) in data/memory.json.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

const text = t => ({content: [{type: 'text', text: String(t)}]});

export function makeMemoryTools(config) {
  const file = join(config.dataDir, 'memory.json');
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const save = o => writeFileSync(file, JSON.stringify(o, null, 2) + '\n');

  return [
    {
      name: 'remember', risk: 'write',
      description: 'Save a fact, preference, or note to long-term memory under a key, so you recall it in future chats. Use for the user\'s setup, preferences, project details, server notes, recurring tasks, etc.',
      shape: {key: z.string().describe('A short key, e.g. "editor" or "london-server".'), value: z.string().describe('What to remember.')},
      summarize: a => ({title: 'Remember', detail: `${a.key}: ${a.value}`}),
      run: async ({key, value}) => { const o = load(); o[key] = {value, updated: new Date().toISOString()}; save(o); return text(`Remembered "${key}".`); },
    },
    {
      name: 'recall', risk: 'read',
      description: 'Recall from long-term memory. Give a key for one item, or omit to get everything you have remembered.',
      shape: {key: z.string().optional()},
      summarize: a => ({title: 'Recall memory', detail: a.key || '(all)'}),
      run: async ({key}) => {
        const o = load();
        if (key) return text(o[key] ? `${key}: ${o[key].value}` : `Nothing saved under "${key}".`);
        const keys = Object.keys(o);
        return text(keys.length ? keys.map(k => `${k}: ${o[k].value}`).join('\n') : 'Memory is empty.');
      },
    },
    {
      name: 'forget', risk: 'write',
      description: 'Delete a remembered item by key.',
      shape: {key: z.string()},
      summarize: a => ({title: 'Forget', detail: a.key}),
      run: async ({key}) => { const o = load(); if (!(key in o)) return text(`Nothing saved under "${key}".`); delete o[key]; save(o); return text(`Forgot "${key}".`); },
    },
  ];
}
