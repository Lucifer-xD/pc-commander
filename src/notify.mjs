// Notifications: let the agent reach YOU (Telegram, Discord, or any webhook) —
// e.g. when a long job finishes. Config in data/notify.json.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});

function cfgPath(dataDir) { return join(dataDir, 'notify.json'); }
function loadCfg(dataDir) { try { return JSON.parse(readFileSync(cfgPath(dataDir), 'utf8')); } catch { return {}; } }

const post = (url, json) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(json)})
  .then(r => ({ok: r.ok, status: r.status})).catch(e => ({ok: false, status: 0, err: e.message}));

// Send to every configured channel. Returns a list of {channel, ok}.
export async function sendNotify(config, message) {
  const c = loadCfg(config.dataDir);
  const out = [];
  if (c.telegram?.token && c.telegram?.chatId)
    out.push({channel: 'telegram', ...(await post(`https://api.telegram.org/bot${c.telegram.token}/sendMessage`, {chat_id: c.telegram.chatId, text: message}))});
  if (c.discord?.webhook)
    out.push({channel: 'discord', ...(await post(c.discord.webhook, {content: message}))});
  if (c.webhook?.url)
    out.push({channel: 'webhook', ...(await post(c.webhook.url, {text: message}))});
  return out;
}

export function makeNotifyTools(config) {
  return [
    {
      name: 'configure_notify', risk: 'write',
      description: 'Set up where notifications go. Provide ONE of: Telegram (token + chatId), a Discord webhook URL, or a generic webhook URL.',
      shape: {
        telegram_token: z.string().optional(), telegram_chat_id: z.string().optional(),
        discord_webhook: z.string().optional(), webhook_url: z.string().optional(),
      },
      summarize: a => ({title: 'Configure notifications', detail: a.telegram_token ? 'Telegram' : a.discord_webhook ? 'Discord' : 'Webhook'}),
      run: async (a) => {
        const c = loadCfg(config.dataDir);
        if (a.telegram_token && a.telegram_chat_id) c.telegram = {token: a.telegram_token, chatId: a.telegram_chat_id};
        if (a.discord_webhook) c.discord = {webhook: a.discord_webhook};
        if (a.webhook_url) c.webhook = {url: a.webhook_url};
        writeFileSync(cfgPath(config.dataDir), JSON.stringify(c, null, 2) + '\n');
        return text(`Notifications configured (${Object.keys(c).join(', ') || 'none'}).`);
      },
    },
    {
      name: 'notify', risk: 'exec',
      description: 'Send a notification to the user right now through their configured channel (Telegram/Discord/webhook).',
      shape: {message: z.string()},
      summarize: a => ({title: 'Send a notification', detail: a.message.slice(0, 200)}),
      run: async ({message}) => {
        const res = await sendNotify(config, message);
        if (!res.length) return fail('No notification channel configured yet. Use configure_notify first.');
        return text(res.map(r => `${r.channel}: ${r.ok ? 'sent' : 'failed (' + (r.err || r.status) + ')'}`).join('\n'));
      },
    },
  ];
}
