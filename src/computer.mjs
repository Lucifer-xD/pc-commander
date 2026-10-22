// Phase 5 — computer use by accessibility, not by guessing pixels.
// Bridges the open-computer-use engine (MIT, github.com/iFurySt/open-computer-use):
// it reads an app's window as a screenshot plus a numbered tree of its controls
// (buttons, fields, menus …) and acts on a control by its number. That is far
// more reliable than move_mouse/mouse_click on coordinates, and it works on
// apps in the background. One engine process is kept alive and restarted on demand.
//
// Install the engine once:  npm i -g open-computer-use
// Override its location with config.computerUseExe or the OCU_EXE environment variable.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {isWin} from './shell.mjs';
import {DEFAULT_PAGE, OUTPUT_SCHEME, keepOutput, pageFooter, pageOf} from './tools.mjs';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const CALL_TIMEOUT_MS = 120_000;
const WIN_SCRIPT = fileURLToPath(new URL('./windows.ps1', import.meta.url));

/** Run windows.ps1 and parse its JSON. */
function winScript(params) {
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_SCRIPT, ...params], {windowsHide: true});
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30_000);
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) {
        // PowerShell error records: keep the message line, drop the "At line …" / "+ …" location noise
        const msg = err.split(/\r?\n/).map(l => l.trim()).find(l => l && !/^(At |\+|CategoryInfo|FullyQualifiedErrorId)/.test(l));
        resolve({error: (msg || err.trim() || 'failed').replace(/^.*?\.ps1 : /, '')});
        return;
      }
      try { resolve({data: JSON.parse(out.trim() || 'null')}); } catch { resolve({error: 'unexpected output: ' + out.trim().slice(0, 200)}); }
    });
    child.on('error', e => { clearTimeout(timer); resolve({error: e.message}); });
  });
}
const onlyWin = () => fail('Window management is Windows-only for now.');

function engineCommand(config) {
  const explicit = config.computerUseExe || process.env.OCU_EXE;
  if (explicit) return {cmd: explicit, args: ['mcp'], shell: false};
  if (isWin && process.env.APPDATA) {
    const exe = join(process.env.APPDATA, 'npm', 'node_modules', 'open-computer-use', 'dist', 'windows', 'amd64', 'open-computer-use.exe');
    if (existsSync(exe)) return {cmd: exe, args: ['mcp'], shell: false};
  }
  return {cmd: 'open-computer-use', args: ['mcp'], shell: isWin};
}

/** Minimal stdio MCP client for the engine: newline-delimited JSON-RPC. */
class Engine {
  constructor(config) { this.config = config; this.proc = null; this.ready = null; this.next = 1; this.pending = new Map(); }

  start() {
    if (this.ready) return this.ready;
    const {cmd, args, shell} = engineCommand(this.config);
    this.ready = new Promise((resolve, reject) => {
      let proc;
      try { proc = spawn(cmd, args, {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell}); }
      catch (e) { this.ready = null; reject(e); return; }
      this.proc = proc;
      let buf = '';
      proc.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          const p = m.id != null && this.pending.get(m.id);
          if (!p) continue;
          this.pending.delete(m.id); clearTimeout(p.timer);
          if (m.error) p.reject(new Error(m.error.message || 'engine error')); else p.resolve(m.result);
        }
      });
      proc.stderr.on('data', () => {});
      const dead = (why) => {
        if (this.proc !== proc) return;
        this.proc = null; this.ready = null;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); }
        this.pending.clear();
      };
      proc.on('error', e => { dead(e.code === 'ENOENT'
        ? 'The computer-use engine is not installed. Install it on this PC with: npm i -g open-computer-use'
        : 'computer-use engine failed to start: ' + e.message); reject(e); });
      proc.on('exit', code => dead(`computer-use engine exited (code ${code}); it restarts on the next call`));
      this.rpc('initialize', {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'pc-commander', version: '1'}}, 30_000)
        .then(() => { this.notify('notifications/initialized'); resolve(); })
        .catch(e => { try { proc.kill(); } catch {} reject(e); });
    });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  rpc(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.proc) { reject(new Error('computer-use engine is not running')); return; }
      const id = this.next++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`computer-use engine did not answer within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.proc.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    });
  }

  notify(method, params) { this.proc?.stdin.write(JSON.stringify({jsonrpc: '2.0', method, ...(params ? {params} : {})}) + '\n'); }

  async call(name, args) {
    await this.start();
    return this.rpc('tools/call', {name, arguments: args});
  }

  stop() { try { this.proc?.kill(); } catch {} this.proc = null; this.ready = null; }
}

// drop undefined keys so the engine's strict schemas accept the call
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Engine result → MCP result. Long text is paged (ChatGPT clips the middle of long results). */
function relay(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const out = [];
  for (const p of parts) {
    if (p.type === 'text' && p.text.length > DEFAULT_PAGE) {
      const id = keepOutput(p.text);
      const pg = pageOf(p.text, 0, DEFAULT_PAGE);
      out.push({type: 'text', text: pg.chunk + pageFooter(pg, next => `call read_file with path="${OUTPUT_SCHEME}${id}::${next}" for the next page of this tree`)});
    } else if (p.type === 'text' || p.type === 'image') out.push(p);
  }
  if (!out.length) out.push({type: 'text', text: '(done)'});
  return {...(result?.isError ? {isError: true} : {}), content: out};
}

const app = z.string().describe('The app: its name as list_apps shows it (e.g. "Notepad", "chrome") or its process name.');
const element = z.string().describe('The element number from the latest app_state tree.');

export function makeComputerTools(config) {
  const engine = new Engine(config);
  process.once('exit', () => engine.stop());
  const run = (name, args) => engine.call(name, clean(args)).then(relay, e => fail(e.message));

  return [
    {
      name: 'list_windows', risk: 'read',
      description: 'List the open windows on the desktop: title, process, pid, state (normal / minimized / maximized), position and size.',
      shape: {},
      summarize: () => ({title: 'List the open windows', detail: 'titles, processes, positions'}),
      run: async () => {
        if (!isWin) return onlyWin();
        const r = await winScript(['-Action', 'list']);
        if (r.error) return fail(r.error);
        const rows = (r.data || []).map(w => `${w.title} — ${w.process} (pid ${w.pid}) · ${w.state} · ${w.width}×${w.height} at ${w.x},${w.y}`);
        return text(rows.length ? `${rows.length} open windows:\n${rows.join('\n')}` : 'No open windows.');
      },
    },
    {
      name: 'window_control', risk: 'exec',
      description: 'Bring a window to the front, minimize, maximize, restore or close it, or move/resize it. "window" matches part of the title or the process name (e.g. "Notepad", "chrome", "Visual Studio Code"). Close asks the app to close normally, like clicking X, so it can still ask to save.',
      shape: {
        window: z.string().describe('Part of the window title, or the process name.'),
        op: z.enum(['focus', 'minimize', 'maximize', 'restore', 'close', 'move']),
        x: z.number().int().optional().describe('move: new left edge'), y: z.number().int().optional().describe('move: new top edge'),
        width: z.number().int().positive().optional().describe('move: new width'), height: z.number().int().positive().optional().describe('move: new height'),
      },
      summarize: a => ({title: `${a.op[0].toUpperCase() + a.op.slice(1)} window`, detail: a.window + (a.op === 'move' ? ` → ${a.x ?? '·'},${a.y ?? '·'} ${a.width ?? '·'}×${a.height ?? '·'}` : '')}),
      run: async a => {
        if (!isWin) return onlyWin();
        const p = ['-Action', 'control', '-Match', a.window, '-Op', a.op];
        if (a.x != null) p.push('-X', String(a.x)); if (a.y != null) p.push('-Y', String(a.y));
        if (a.width != null) p.push('-W', String(a.width)); if (a.height != null) p.push('-H', String(a.height));
        const r = await winScript(p);
        if (r.error) return fail(r.error);
        const d = r.data;
        const now = d.now ? ` Now ${d.now.state}, ${d.now.width}×${d.now.height} at ${d.now.x},${d.now.y}.` : '';
        return text(`${d.op}: "${d.window}" (${d.process}).${now}${d.matches > 1 ? ` ${d.matches} windows matched; used the first — be more specific to pick another.` : ''}`);
      },
    },
    {
      name: 'launch_app', risk: 'exec',
      description: 'Start an app by program name ("notepad", "calc", "chrome"), full path, or its Start-menu name (works for Store apps such as "Calculator", "Settings", "WhatsApp"). Then use list_apps / app_state to work in it.',
      shape: {name: z.string().describe('Program, path or Start-menu name.'), arguments: z.string().optional().describe('Command-line arguments, e.g. a file to open.')},
      summarize: a => ({title: 'Launch an app', detail: a.name + (a.arguments ? ' ' + a.arguments : '')}),
      run: async a => {
        if (!isWin) return onlyWin();
        const p = ['-Action', 'launch', '-Name', a.name];
        if (a.arguments) p.push('-Arguments', a.arguments);
        const r = await winScript(p);
        if (r.error) return fail(r.error);
        return text(`Started ${r.data.launched}${r.data.via === 'start-menu' ? ' (from the Start menu)' : ''}.`);
      },
    },
    {
      name: 'list_apps', risk: 'read',
      description: 'COMPUTER USE · step 1. List the apps on this PC: the ones running now (with their window titles) and the ones used in the last 14 days. Use the name it shows as "app" in the other computer-use tools.',
      shape: {},
      summarize: () => ({title: 'List the apps on this PC', detail: 'running apps, their windows, recent apps'}),
      run: () => run('list_apps', {}),
    },
    {
      name: 'app_state', risk: 'exec',
      description: 'COMPUTER USE · step 2, and again after every action. Read an app\'s main window: a screenshot plus a numbered tree of its controls (buttons, text fields, menus, list items, links). Act on a control by its number with app_click / app_set_value / app_scroll / app_action. Numbers can change after any action, so read the state again before the next one. Works on apps in the background; the window is not brought to the front unless window_placement says so.',
      shape: {
        app,
        max_tree_nodes: z.number().int().min(1).optional().describe('Most controls to list (default 500; up to 1200 for big windows).'),
        max_tree_depth: z.number().int().min(1).optional().describe('Deepest nesting level to list (default 64).'),
        window_placement: z.enum(['keep', 'agent_display', 'restore']).optional().describe('keep (default) leaves the window where it is; restore un-minimizes it.'),
      },
      summarize: a => ({title: `Read the ${a.app} window`, detail: 'screenshot + list of its controls, sent to the assistant'}),
      run: a => run('get_app_state', {...a, max_tree_nodes: a.max_tree_nodes ?? 500}),
    },
    {
      name: 'app_click', risk: 'exec',
      description: 'COMPUTER USE. Click a control in an app. Prefer element (its number from app_state); otherwise give x,y pixel coordinates in the app_state screenshot. click_count 2 = double-click; mouse_button right = context menu.',
      shape: {
        app,
        element: element.optional(),
        x: z.number().optional().describe('X in the app_state screenshot (when no element number).'),
        y: z.number().optional().describe('Y in the app_state screenshot.'),
        click_count: z.number().int().min(1).max(3).optional(),
        mouse_button: z.enum(['left', 'right', 'middle']).optional(),
      },
      summarize: a => ({title: `Click in ${a.app}`, detail: a.element != null ? `control #${a.element}` : `at ${a.x}, ${a.y}`}),
      run: a => {
        if (a.element == null && (a.x == null || a.y == null)) return fail('Give element (from app_state) or both x and y.');
        return run('click', {app: a.app, element_index: a.element, x: a.x, y: a.y, click_count: a.click_count, mouse_button: a.mouse_button});
      },
    },
    {
      name: 'app_type', risk: 'exec',
      description: 'COMPUTER USE. Type literal text into the app\'s focused control (click or set_value a field first). For a whole field value, app_set_value is more reliable.',
      shape: {app, text: z.string().describe('The literal text to type.')},
      summarize: a => ({title: `Type into ${a.app}`, detail: a.text.slice(0, 200)}),
      run: a => run('type_text', {app: a.app, text: a.text}),
    },
    {
      name: 'app_key', risk: 'exec',
      description: 'COMPUTER USE. Press a key or shortcut in an app, xdotool style: "Return", "Tab", "Escape", "ctrl+s", "ctrl+shift+t", "alt+F4", "Up", "Page_Down".',
      shape: {app, key: z.string().describe('Key or combination, e.g. "Return" or "ctrl+s".')},
      summarize: a => ({title: `Press ${a.key} in ${a.app}`, detail: ''}),
      run: a => run('press_key', {app: a.app, key: a.key}),
    },
    {
      name: 'app_set_value', risk: 'exec',
      description: 'COMPUTER USE. Set the whole value of an editable control (text box, combo box, slider) by its number from app_state. Replaces what was there.',
      shape: {app, element, value: z.string()},
      summarize: a => ({title: `Set a field in ${a.app}`, detail: `control #${a.element} = ${a.value.slice(0, 160)}`}),
      run: a => run('set_value', {app: a.app, element_index: a.element, value: a.value}),
    },
    {
      name: 'app_scroll', risk: 'exec',
      description: 'COMPUTER USE. Scroll a control (list, page, document) by its number from app_state.',
      shape: {app, element, direction: z.enum(['up', 'down', 'left', 'right']), pages: z.number().positive().optional().describe('Pages to scroll (default 1; fractions allowed).')},
      summarize: a => ({title: `Scroll ${a.direction} in ${a.app}`, detail: `control #${a.element}`}),
      run: a => run('scroll', {app: a.app, element_index: a.element, direction: a.direction, pages: a.pages}),
    },
    {
      name: 'app_drag', risk: 'exec',
      description: 'COMPUTER USE. Drag from one point to another (pixel coordinates in the app_state screenshot).',
      shape: {app, from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number()},
      summarize: a => ({title: `Drag in ${a.app}`, detail: `${a.from_x},${a.from_y} → ${a.to_x},${a.to_y}`}),
      run: a => run('drag', a),
    },
    {
      name: 'app_action', risk: 'exec',
      description: 'COMPUTER USE. Run one of the extra actions a control lists in app_state (for example expand, collapse, toggle, select, show menu).',
      shape: {app, element, action: z.string().describe('The action name exactly as app_state lists it.')},
      summarize: a => ({title: `${a.action} in ${a.app}`, detail: `control #${a.element}`}),
      run: a => run('perform_secondary_action', {app: a.app, element_index: a.element, action: a.action}),
    },
  ];
}
