// Configuration + token. data/config.json is created on first run.
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  // Where commands run unless the caller gives an absolute cwd.
  defaultCwd: process.env.USERPROFILE || process.cwd(),
  // Each command needs a local click unless it matches one of these (regex, case-insensitive).
  // Empty = every command is confirmed on this PC.
  autoApprove: [],
  approvalTimeoutMs: 55000,
  commandTimeoutMs: 110000,
  maxOutputChars: 100000,
};

export function loadConfig(dataDir = join(ROOT, 'data')) {
  mkdirSync(dataDir, {recursive: true});
  const file = join(dataDir, 'config.json');
  const config = {...DEFAULTS, ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})};
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({port: config.port, autoApprove: []}, null, 2) + '\n');
  config.dataDir = dataDir;
  const tokenFile = join(dataDir, 'token.txt');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex') + '\n', {mode: 0o600});
  config.token = process.env.PC_CONNECTOR_TOKEN || readFileSync(tokenFile, 'utf8').trim();
  config.tokenFile = tokenFile;
  return config;
}
