// Web agent: drive a real browser (log in, click, type, read, screenshot, run JS).
// Uses puppeteer-core against your INSTALLED Chrome/Edge — no big browser download.
// Install once: npm run install-browser  (adds puppeteer-core)
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

const text = t => ({content: [{type: 'text', text: String(t)}]});
const fail = t => ({isError: true, content: [{type: 'text', text: String(t)}]});
const NEED = 'The web agent needs puppeteer-core. Install it once with:  npm run install-browser';

const CHROME_CANDIDATES = [
  process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

let pup = null, browser = null, page = null;
async function loadPup() { if (pup) return pup; try { pup = await import('puppeteer-core'); return pup; } catch { return null; } }

function chromePath(config) {
  try { const c = JSON.parse(readFileSync(join(config.dataDir, 'browser.json'), 'utf8')); if (c.executablePath) return c.executablePath; } catch {}
  return CHROME_CANDIDATES.find(p => p && existsSync(p));
}
function headlessPref(config) { try { return JSON.parse(readFileSync(join(config.dataDir, 'browser.json'), 'utf8')).headless !== false; } catch { return true; } }

async function ensurePage(config) {
  const p = await loadPup(); if (!p) throw new Error(NEED);
  if (browser && page && !page.isClosed()) return page;
  const exe = chromePath(config); if (!exe) throw new Error('No Chrome/Edge found. Set executablePath in data/browser.json.');
  browser = await p.default.launch({executablePath: exe, headless: headlessPref(config) ? 'new' : false, args: ['--no-first-run', '--no-default-browser-check']});
  page = await browser.newPage();
  await page.setViewport({width: 1280, height: 850});
  return page;
}

export function makeBrowserTools(config) {
  return [
    {
      name: 'browser_open', risk: 'exec',
      description: 'Open a URL in a real browser (starts the browser if needed). Returns the page title. Use the other browser_* tools to interact.',
      shape: {url: z.string()},
      summarize: a => ({title: 'Open in browser', detail: a.url}),
      run: async ({url}) => { try { const pg = await ensurePage(config); await pg.goto(/^https?:\/\//i.test(url) ? url : 'https://' + url, {waitUntil: 'domcontentloaded', timeout: 45000}); return text(`Opened: ${await pg.title()}\n${pg.url()}`); } catch (e) { return fail(e.message); } },
    },
    {
      name: 'browser_read', risk: 'read',
      description: 'Read the visible text of the current browser page.',
      shape: {},
      summarize: () => ({title: 'Read browser page', detail: ''}),
      run: async () => { try { if (!page) return fail('No page open. Use browser_open first.'); const t = await page.evaluate(() => document.body?.innerText || ''); return text((await page.title()) + '\n' + page.url() + '\n\n' + t.slice(0, 100000)); } catch (e) { return fail(e.message); } },
    },
    {
      name: 'browser_screenshot', risk: 'read',
      description: 'Take a screenshot of the current browser page and return it as an image.',
      shape: {full_page: z.boolean().optional()},
      summarize: () => ({title: 'Screenshot browser page', detail: ''}),
      run: async ({full_page}) => { try { if (!page) return fail('No page open.'); const buf = await page.screenshot({fullPage: !!full_page, type: 'png'}); return {content: [{type: 'image', data: Buffer.from(buf).toString('base64'), mimeType: 'image/png'}, {type: 'text', text: 'Page: ' + page.url()}]}; } catch (e) { return fail(e.message); } },
    },
    {
      name: 'browser_click', risk: 'exec',
      description: 'Click an element by CSS selector or by its visible text.',
      shape: {selector: z.string().optional(), text: z.string().optional().describe('Visible text to click (if no selector).')},
      summarize: a => ({title: 'Click in browser', detail: a.selector || a.text}),
      run: async ({selector, text: label}) => {
        try { const pg = await ensurePage(config);
          if (selector) { await pg.click(selector, {timeout: 15000}); return text(`Clicked ${selector}.`); }
          const ok = await pg.evaluate(t => { const el = [...document.querySelectorAll('a,button,[role=button],input,span,div')].find(e => e.innerText?.trim() === t || e.value === t); if (el) { el.click(); return true; } return false; }, label);
          return ok ? text(`Clicked "${label}".`) : fail(`No element with text "${label}".`);
        } catch (e) { return fail(e.message); }
      },
    },
    {
      name: 'browser_type', risk: 'exec',
      description: 'Type text into an input identified by a CSS selector. Optionally press Enter after.',
      shape: {selector: z.string(), text: z.string(), enter: z.boolean().optional()},
      summarize: a => ({title: 'Type in browser', detail: `${a.selector}: ${a.text.slice(0, 80)}`}),
      run: async ({selector, text: t, enter}) => { try { const pg = await ensurePage(config); await pg.type(selector, t, {delay: 15}); if (enter) await pg.keyboard.press('Enter'); return text(`Typed into ${selector}.`); } catch (e) { return fail(e.message); } },
    },
    {
      name: 'browser_eval', risk: 'exec',
      description: 'Run JavaScript in the current page and return the result (for scraping or advanced control).',
      shape: {script: z.string().describe('A JS expression; its value is returned.')},
      summarize: a => ({title: 'Run JS in browser', detail: a.script.slice(0, 160)}),
      run: async ({script}) => { try { if (!page) return fail('No page open.'); const r = await page.evaluate(script); return text((typeof r === 'string' ? r : JSON.stringify(r) ?? 'undefined').slice(0, 50000)); } catch (e) { return fail(e.message); } },
    },
    {
      name: 'browser_close', risk: 'exec',
      description: 'Close the browser.',
      shape: {},
      summarize: () => ({title: 'Close browser', detail: ''}),
      run: async () => { try { if (browser) { await browser.close(); browser = null; page = null; } return text('Browser closed.'); } catch (e) { return fail(e.message); } },
    },
  ];
}
