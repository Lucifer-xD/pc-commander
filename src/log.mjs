import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
export function createLog(file) {
  mkdirSync(dirname(file), {recursive: true});
  return (event, fields = {}) => {
    try { appendFileSync(file, JSON.stringify({t: new Date().toISOString(), event, ...fields}) + '\n'); } catch {}
  };
}
