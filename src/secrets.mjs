// Encrypted secrets vault. Stores API keys / tokens / passwords encrypted at rest
// (AES-256-GCM) in data/secrets.enc, keyed by data/vault.key. Other tools can use
// a secret with ${secret:NAME} so the value never appears in chat or logs.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {z} from 'zod';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});

function keyOf(dataDir) {
  const f = join(dataDir, 'vault.key');
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex') + '\n', {mode: 0o600});
  return Buffer.from(readFileSync(f, 'utf8').trim(), 'hex');
}
function vaultFile(dataDir) { return join(dataDir, 'secrets.enc'); }

function loadVault(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(vaultFile(dataDir), 'utf8'));
    const key = keyOf(dataDir); const out = {};
    for (const [name, {iv, tag, data}] of Object.entries(raw)) {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
      d.setAuthTag(Buffer.from(tag, 'hex'));
      out[name] = d.update(Buffer.from(data, 'hex'), undefined, 'utf8') + d.final('utf8');
    }
    return out;
  } catch { return {}; }
}
function saveVault(dataDir, plain) {
  const key = keyOf(dataDir); const raw = {};
  for (const [name, value] of Object.entries(plain)) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
    raw[name] = {iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex')};
  }
  writeFileSync(vaultFile(dataDir), JSON.stringify(raw, null, 2) + '\n', {mode: 0o600});
}

export function setSecret(dataDir, name, value) { const v = loadVault(dataDir); v[name] = value; saveVault(dataDir, v); }
export function getSecret(dataDir, name) { return loadVault(dataDir)[name]; }

// Replace ${secret:NAME} in a string with the decrypted value (used by other tools).
export function resolveSecrets(dataDir, str) {
  if (typeof str !== 'string' || !str.includes('${secret:')) return str;
  const v = loadVault(dataDir);
  return str.replace(/\$\{secret:([A-Za-z0-9_.-]+)\}/g, (m, n) => (n in v ? v[n] : m));
}

export function makeSecretTools(config) {
  return [
    {
      name: 'store_secret', risk: 'write',
      description: 'Store a secret (API key, token, password) encrypted. Use it later in commands/URLs as ${secret:NAME} — the value never appears in chat.',
      shape: {name: z.string().describe('A name like OPENAI_KEY.'), value: z.string().describe('The secret value.')},
      summarize: a => ({title: 'Store a secret', detail: `${a.name} = ••••••••`}),
      run: async ({name, value}) => { const v = loadVault(config.dataDir); v[name] = value; saveVault(config.dataDir, v); return text(`Stored secret "${name}". Use it as \${secret:${name}}.`); },
    },
    {
      name: 'list_secrets', risk: 'read',
      description: 'List the NAMES of stored secrets (never the values).',
      shape: {},
      summarize: () => ({title: 'List secret names', detail: ''}),
      run: async () => { const v = loadVault(config.dataDir); const names = Object.keys(v); return text(names.length ? names.join('\n') : 'No secrets stored.'); },
    },
    {
      name: 'delete_secret', risk: 'write',
      description: 'Delete a stored secret by name.',
      shape: {name: z.string()},
      summarize: a => ({title: 'Delete a secret', detail: a.name}),
      run: async ({name}) => { const v = loadVault(config.dataDir); if (!(name in v)) return fail(`No secret "${name}".`); delete v[name]; saveVault(config.dataDir, v); return text(`Deleted secret "${name}".`); },
    },
  ];
}
