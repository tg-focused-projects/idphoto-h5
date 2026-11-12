// 手机视口截图（390×844 @2x）。--window-size 会被 Chrome 强制最小 512 宽，所以走 CDP 的 Emulation。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.H5_URL || 'http://127.0.0.1:8088/';
const PORT = Number(process.env.CDP_PORT || 9445);
const route = process.argv[2] || '#/';
const outFile = process.argv[3] || path.join(process.cwd(), 'out', 'h5-mobile.png');
const profile = path.join(os.tmpdir(), 'shotm-' + Date.now());
fs.mkdirSync(path.dirname(outFile), { recursive: true });

const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(u) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

try {
  const list = await json(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id);
      pend.delete(m.id);
      m.error ? p.j(new Error(m.error.message)) : p.r(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((r, j) => {
    const i = ++id;
    pend.set(i, { r, j });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE + route });
  await sleep(2600);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));

  const r = await send('Runtime.evaluate', {
    expression: 'innerWidth + "x" + innerHeight + " scrollW=" + document.documentElement.scrollWidth',
    returnByValue: true,
  });
  console.log('saved', outFile, r.result.value);
  ws.close();
} catch (e) {
  console.log('ERR', e.message);
} finally {
  ch.kill();
}
