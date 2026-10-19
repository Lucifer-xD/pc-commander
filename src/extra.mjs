// Small but handy extras: clipboard, keep-awake, screen size.
import {z} from 'zod';
import {runCommand} from './exec.mjs';
import {isWin, isMac} from './shell.mjs';
import {pin, active, supported} from './keepawake.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const sh = async (cmd, timeoutMs = 20000) => { const r = await runCommand({command: cmd, timeoutMs, maxOutputChars: 100000}); return {out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trimEnd()}; };

export function makeExtraTools() {
  return [
    {
      name: 'read_clipboard', risk: 'read',
      description: 'Read the current text contents of the clipboard.',
      shape: {},
      summarize: () => ({title: 'Read clipboard', detail: ''}),
      run: async () => {
        const cmd = isWin ? 'Get-Clipboard -Raw' : isMac ? 'pbpaste' : 'xclip -selection clipboard -o 2>/dev/null || xsel -b';
        const r = await sh(cmd);
        return text(r.out || '(clipboard is empty)');
      },
    },
    {
      name: 'set_clipboard', risk: 'write',
      description: 'Put text onto the clipboard.',
      shape: {text: z.string()},
      summarize: a => ({title: 'Set clipboard', detail: a.text.slice(0, 200)}),
      run: async ({text: t}) => {
        const b64 = Buffer.from(t, 'utf8').toString('base64');
        const cmd = isWin
          ? `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t`
          : isMac ? `echo '${b64}' | base64 -d | pbcopy`
          : `echo '${b64}' | base64 -d | xclip -selection clipboard`;
        const r = await sh(cmd);
        return r.err ? fail(r.err) : text('Clipboard set.');
      },
    },
    {
      name: 'keep_awake', risk: 'exec',
      description: 'Keep the computer from sleeping (so long tasks keep running), or turn that off. Note: background jobs already keep it awake automatically while they run.',
      shape: {enabled: z.boolean().describe('true = stay awake, false = allow sleep again.')},
      summarize: a => ({title: a.enabled ? 'Keep the PC awake' : 'Allow the PC to sleep', detail: ''}),
      run: async ({enabled}) => {
        if (!supported()) return fail('keep_awake is Windows-only for now.');
        pin(enabled);
        return text(enabled ? 'The PC will stay awake until you turn this off.' : 'Sleep allowed again.');
      },
    },
    {
      name: 'screen_size', risk: 'read',
      description: 'Get the screen resolution (useful before using move_mouse / mouse_click).',
      shape: {},
      summarize: () => ({title: 'Get screen size', detail: ''}),
      run: async () => {
        if (!isWin) { const r = await sh(isMac ? 'system_profiler SPDisplaysDataType | grep Resolution' : 'xrandr | grep "\\*"'); return text(r.out || 'unknown'); }
        const r = await sh('Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; "$($b.Width)x$($b.Height) (origin $($b.X),$($b.Y))"');
        return text(r.out || 'unknown');
      },
    },
  ];
}
