// 探针：真实视口宽度、.make 的 grid 轨道、是否有横向溢出
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const W = Number(process.argv[2] || 430);
const H = Number(process.argv[3] || 900);
const PORT = 9444;
const profile = path.join(os.tmpdir(), 'probe-' + Date.now());

const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', `--window-size=${W},${H}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(u) { for (let i = 0; i < 40; i++) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(250); } throw new Error('no cdp'); }

try {
  const list = await json(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); } };
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; pend.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8088/#/make' });
  await sleep(2500);
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const m = document.querySelector('.make');
      const p = document.querySelector('.panel');
      const s = document.querySelector('.stage');
      return {
        innerWidth: innerWidth, dpr: devicePixelRatio,
        docScrollW: document.documentElement.scrollWidth,
        makeCols: m ? getComputedStyle(m).gridTemplateColumns : null,
        makeW: m ? Math.round(m.getBoundingClientRect().width) : null,
        panelW: p ? Math.round(p.getBoundingClientRect().width) : null,
        panelRight: p ? Math.round(p.getBoundingClientRect().right) : null,
        stageRight: s ? Math.round(s.getBoundingClientRect().right) : null,
        mediaMatch: matchMedia('(max-width: 900px)').matches,
      };
    })()`, returnByValue: true,
  });
  console.log(JSON.stringify(r.result.value, null, 1));
  ws.close();
} catch (e) { console.log('ERR', e.message); }
finally { ch.kill(); }
