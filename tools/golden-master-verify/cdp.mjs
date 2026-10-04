// A dependency-free Chrome DevTools Protocol client (Node 22+: global WebSocket / fetch).
// Used by the Golden Master verification tools; it launches a private headless Chrome, so it never
// touches the user's browser profile or any signed-in session.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findChrome() {
  const p = CANDIDATES.find((c) => existsSync(c));
  if (!p) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');
  return p;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ port = 9333 + Math.floor(Math.random() * 500) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gmv-chrome-'));
  const proc = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      '--allow-file-access-from-files',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let version;
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!version) {
    proc.kill();
    throw new Error('Chrome did not start');
  }
  return {
    port,
    version,
    async close() {
      try {
        proc.kill();
      } catch {}
      await sleep(300);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

export class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`)) : res(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) ?? []).forEach((f) => f(msg.params));
      }
    });
  }
  static async open(port) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r);
      ws.addEventListener('error', j);
    });
    const page = new Page(ws);
    page.targetId = target.id;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(method, f) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), f]);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async viewport({ width, height, dpr = 1, mobile = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile,
    });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  }
  async goto(url) {
    const loaded = new Promise((r) => this.on('Page.loadEventFired', r));
    await this.send('Page.navigate', { url });
    await loaded;
  }
  async screenshot(file, fs) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
