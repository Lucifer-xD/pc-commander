// Phase 4 — eyes & mouse. Control the mouse and keyboard so the agent can
// operate apps, not just the terminal. Pair with the `screenshot` tool to see,
// then act. Windows only for now (uses Win32 via PowerShell).
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {isWin} from './shell.mjs';

const SCRIPT = fileURLToPath(new URL('./gui.ps1', import.meta.url));
const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});

function gui(params) {
  return new Promise(resolve => {
    const args = ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...params];
    const child = spawn('powershell.exe', args, {windowsHide: true});
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.on('exit', code => resolve({code, out: out.trim(), err: err.trim()}));
    child.on('error', e => resolve({code: null, out: '', err: e.message}));
  });
}

// Escape literal text for SendKeys (these chars are special there).
const escSendKeys = s => s.replace(/[+^%~(){}\[\]]/g, m => `{${m}}`);
const KEYMAP = {enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ', backspace: '{BACKSPACE}', bksp: '{BACKSPACE}', del: '{DEL}', delete: '{DEL}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pgup: '{PGUP}', pgdn: '{PGDN}', ins: '{INSERT}', f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}', f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}'};
const MOD = {ctrl: '^', control: '^', alt: '%', shift: '+'};
// "ctrl+shift+esc" -> "^+{ESC}" ; "a" -> "a"
function toSendKeys(combo) {
  const parts = String(combo).toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
  let mods = '', key = '';
  for (const p of parts) {
    if (MOD[p] && p !== parts[parts.length - 1]) mods += MOD[p];
    else key = KEYMAP[p] || (p.length === 1 ? p : `{${p.toUpperCase()}}`);
  }
  return mods + key;
}

const onlyWin = () => fail('GUI control (mouse/keyboard) is Windows-only for now.');

export function makeGuiTools() {
  return [
    {
      name: 'move_mouse', risk: 'exec',
      description: 'Move the mouse cursor to screen coordinates (pixels from the top-left). Pair with screenshot to find things.',
      shape: {x: z.number(), y: z.number()},
      summarize: a => ({title: 'Move the mouse', detail: `to ${a.x}, ${a.y}`}),
      run: async ({x, y}) => { if (!isWin) return onlyWin(); const r = await gui(['-Action', 'move', '-X', String(x), '-Y', String(y)]); return r.code === 0 ? text(`Moved to ${x},${y}.`) : fail(r.err); },
    },
    {
      name: 'mouse_click', risk: 'exec',
      description: 'Click the mouse. Optionally give x,y to click at a specific spot; omit to click where the cursor is. Supports left/right/middle and double-click.',
      shape: {x: z.number().optional(), y: z.number().optional(), button: z.enum(['left', 'right', 'middle']).optional(), double: z.boolean().optional()},
      summarize: a => ({title: `${a.double ? 'Double-' : ''}${a.button || 'left'} click`, detail: a.x != null ? `at ${a.x}, ${a.y}` : 'at cursor'}),
      run: async ({x, y, button, double}) => {
        if (!isWin) return onlyWin();
        const p = [double ? '-Action' : '-Action', double ? 'double' : 'click'];
        if (x != null && y != null) p.push('-X', String(x), '-Y', String(y));
        if (button) p.push('-Button', button);
        const r = await gui(p);
        return r.code === 0 ? text(`${double ? 'Double-clicked' : 'Clicked'}${x != null ? ' at ' + x + ',' + y : ''}.`) : fail(r.err);
      },
    },
    {
      name: 'type_text', risk: 'exec',
      description: 'Type text into whatever has keyboard focus right now (click a field first if needed).',
      shape: {text: z.string().describe('The literal text to type.')},
      summarize: a => ({title: 'Type text', detail: a.text.slice(0, 200)}),
      run: async ({text: t}) => { if (!isWin) return onlyWin(); const r = await gui(['-Action', 'type', '-Text', escSendKeys(t)]); return r.code === 0 ? text(`Typed ${t.length} characters.`) : fail(r.err); },
    },
    {
      name: 'press_keys', risk: 'exec',
      description: 'Press a key or keyboard shortcut, e.g. "enter", "ctrl+c", "alt+tab", "ctrl+shift+esc", "win" not supported. One combo per call.',
      shape: {keys: z.string().describe('A key or combo like "enter", "ctrl+s", "alt+f4".')},
      summarize: a => ({title: 'Press keys', detail: a.keys}),
      run: async ({keys}) => { if (!isWin) return onlyWin(); const r = await gui(['-Action', 'keys', '-Text', toSendKeys(keys)]); return r.code === 0 ? text(`Pressed ${keys}.`) : fail(r.err); },
    },
    {
      name: 'scroll', risk: 'exec',
      description: 'Scroll the mouse wheel up or down by a number of notches.',
      shape: {direction: z.enum(['up', 'down']), amount: z.number().optional().describe('Notches (default 3).')},
      summarize: a => ({title: 'Scroll', detail: `${a.direction} ${a.amount || 3}`}),
      run: async ({direction, amount}) => { if (!isWin) return onlyWin(); const n = (amount || 3) * (direction === 'down' ? -1 : 1); const r = await gui(['-Action', 'scroll', '-Amount', String(n)]); return r.code === 0 ? text(`Scrolled ${direction}.`) : fail(r.err); },
    },
  ];
}
