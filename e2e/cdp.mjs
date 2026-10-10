// A minimal Chrome DevTools Protocol driver for end-to-end tests. Unlike Playwright it attaches
// only to the pages we ask for, so tabs the extension discards (lazy restore, suspend) are left
// alone; Playwright's auto-attach to every tab makes Chromium drop the session when a tab it
// watches is discarded.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = '/opt/pw-browsers';
  if (existsSync(root)) {
    for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const candidate = `${root}/${dir}/chrome-linux/chrome`;
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chromium found. Set CHROME_PATH.');
}

export async function launchChrome({ extensionDir, userDataDir, width = 1440, height = 900 }) {
  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ];
  if (process.getuid?.() === 0) args.unshift('--no-sandbox');
  const proc = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`Chromium did not start:\n${buffer}`)), 20_000);
    proc.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('exit', (code) => reject(new Error(`Chromium exited (${code}):\n${buffer}`)));
  });
  const browser = new Browser(proc, new WebSocket(wsUrl));
  await browser.ready;
  return browser;
}

class Browser {
  constructor(proc, socket) {
    this.proc = proc;
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.ready = new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} ${message.error.data ?? ''}`));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async targets() {
    return (await this.send('Target.getTargets')).targetInfos;
  }

  /** The extension id, from its service worker. */
  async extensionId(timeout = 20_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const worker = (await this.targets()).find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
      if (worker) return new URL(worker.url).host;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Extension service worker not found');
  }

  async openPage(url, { width = 1440, height = 900 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    return this.attach(targetId, { width, height, url });
  }

  async attach(targetId, { width = 1440, height = 900, url } = {}) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.init(width, height);
    if (url) await page.goto(url);
    return page;
  }

  /** Attach to the extension's service worker to collect its console errors. */
  async attachWorker() {
    const worker = (await this.targets()).find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    if (!worker) return null;
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    const page = new Page(this, sessionId, worker.targetId);
    await page.send('Runtime.enable');
    return page;
  }

  async close() {
    try {
      await Promise.race([this.send('Browser.close'), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      // Already gone.
    }
    await new Promise((resolve) => {
      if (this.proc.exitCode !== null) return resolve();
      this.proc.once('exit', resolve);
      setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, 5000);
    });
    this.socket.close();
  }
}

class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.errors = [];
    browser.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.errors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  async init(width, height) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.viewport(width, height);
  }

  viewport(width, height) {
    return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  colorScheme(value) {
    return this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor(() => document.readyState === 'complete' && location.href !== 'about:blank');
  }

  /** Run a function in the page and return its (JSON-able) result. Awaits promises. */
  async evaluate(fn, arg) {
    const expression = `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async waitFor(fn, arg, timeout = 10_000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await this.evaluate(fn, arg);
        if (last) return last;
      } catch {
        // Page still navigating.
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return last;
  }

  waitForText(text, timeout) {
    return this.waitFor((t) => document.body?.innerText.includes(t), text, timeout);
  }

  /** Focus an input and type, replacing what is there (real input events, so React sees them). */
  async type(selector, text) {
    await this.evaluate((s) => {
      const el = document.querySelector(s);
      el.focus();
      el.select?.();
    }, selector);
    if (text) await this.send('Input.insertText', { text });
    else await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  }

  /** Click the first button or link whose text includes `text`. */
  clickText(text) {
    return this.evaluate((t) => {
      const el = [...document.querySelectorAll('button, a, [role=option]')].find((e) => e.innerText.includes(t));
      if (!el) return false;
      el.click();
      return true;
    }, text);
  }

  async screenshot(path, { fullPage = false } = {}) {
    let clip;
    if (fullPage) {
      const { cssContentSize } = await this.send('Page.getLayoutMetrics');
      clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }

  close() {
    return this.browser.send('Target.closeTarget', { targetId: this.targetId });
  }
}
