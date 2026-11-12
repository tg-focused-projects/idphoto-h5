/**
 * 用 CDP 驱动无头 Chrome，把 H5 的完整链路跑一遍：
 *   选图(DOM.setFileInputFiles) → 点「AI 换正装」→ 等结果 → 截图 → 导出下载 → 校验
 * 依赖：Node 22+ 自带 WebSocket；本机 Chrome。
 *
 *   node tools/cdp_test.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.H5_URL || 'http://127.0.0.1:8088/#/make';
const PHOTO = process.argv[2] || path.join(process.cwd(), 'sample.jpg');
const TAG = process.argv[3] || 'demo';
const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'out');
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(PHOTO)) {
  console.error(`找不到测试照片: ${PHOTO}\n用法: node tools/cdp_test.mjs <照片路径> [标签] [refine]`);
  process.exit(2);
}
const DL = path.join(os.tmpdir(), 'h5-dl-' + Date.now());
const PORT = 9333;

fs.mkdirSync(DL, { recursive: true });

const profile = path.join(os.tmpdir(), 'h5-cdp-' + Date.now());
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1280,1000',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪: ' + url);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); }
      }, 120000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }
}

const log = (...a) => console.log(...a);

let cdp;
try {
  const list = await waitJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  cdp = await CDP.connect(page.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  log('→ navigate', URL);
  await cdp.send('Page.navigate', { url: URL });
  await sleep(1800);

  // 1) 选图
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  if (!q.nodeId) throw new Error('找不到 #file');
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [PHOTO] });
  await sleep(1200);
  const hasPhoto = await cdp.eval(`!!document.querySelector('.stage img')`);
  log('  选图后预览图:', hasPhoto ? 'OK' : 'MISSING');
  if (!hasPhoto) throw new Error('选图没生效');

  // 2) 生成
  log('→ 点击 AI 换正装（会走真实生图，约 40~90s）');
  const waitGen = async (btnSel, label) => {
    const t = Date.now();
    await cdp.eval(`document.querySelector('${btnSel}').click()`);
    await sleep(1500);
    for (let i = 0; i < 240; i++) {
      await sleep(1000);
      const st = await cdp.eval(`(() => {
        const g = document.getElementById('gen');
        const err = document.querySelector('.err');
        const tag = document.querySelector('.stage .tag');
        return { busy: g ? /生成中/.test(g.textContent) : null, hasResult: !!tag, err: err ? err.textContent.slice(0,160) : '' };
      })()`);
      if (st.err) throw new Error('页面报错: ' + st.err);
      if (!st.busy && st.hasResult) { log(`  ${label}完成，用时 ${((Date.now() - t) / 1000).toFixed(1)}s`); return; }
    }
    throw new Error(label + '超时');
  };

  await waitGen('#gen', '生成');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, `h5-${TAG}-result.png`), Buffer.from(shot.data, 'base64'));

  // 2.5) 可选：第二轮局部精修
  if (process.argv[4] === 'refine') {
    log('→ 点击「局部精修」（拿上一版结果当参考图，只清胡渣/发丝）');
    await waitGen('#refine', '精修');
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, `h5-${TAG}-refined.png`), Buffer.from(shot2.data, 'base64'));
  }

  // 4) 客户端合成能力自检
  const check = await cdp.eval(`(async () => {
    const c = await import('/js/compose.js');
    const img = document.querySelector('.stage img');
    await new Promise(r => { if (img.complete) r(); else img.onload = r; });
    const fr = c.analyzeFraming(img);
    const cv = c.cropToSpec(img, [295, 413]);
    const blob = await c.canvasToJpeg(cv, { dpi: 300, quality: 0.95 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const jfif = String.fromCharCode(buf[6], buf[7], buf[8], buf[9]);
    return { natural: [img.naturalWidth, img.naturalHeight], hairTop: Math.round(fr.hairTop),
             headH: Math.round(fr.headH), cx: Math.round(fr.cx),
             crop: [cv.width, cv.height], blobKB: Math.round(blob.size/1024),
             jfif, dpiUnits: buf[13], dpiX: (buf[14]<<8)|buf[15], dpiY: (buf[16]<<8)|buf[17] };
  })()`);
  log('  合成自检:', JSON.stringify(check));

  // 5) 导出：一寸 / 二寸 / 6 寸排版
  const grab = async (label) => {
    const before = new Set(fs.readdirSync(DL));
    await sleep(2600);
    const added = fs.readdirSync(DL).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
    for (const f of added) {
      const src = path.join(DL, f);
      const dst = path.join(OUT, `h5-${TAG}-${label}-${f}`);
      fs.copyFileSync(src, dst);
      const buf = fs.readFileSync(dst);
      let w = 0, h = 0, dpi = '';
      try {
        const r = execFileSync('python', ['-c',
          `from PIL import Image;im=Image.open(r"${dst}");print(im.size[0],im.size[1],im.info.get("dpi"))`]).toString().trim();
        const p = r.replace('(', '').replace(')', '').split(' ');
        w = p[0]; h = p[1]; dpi = p.slice(2).join(' ');
      } catch {}
      log(`  导出[${label}] ${f}  ${buf.length}B  ${w}×${h}  dpi=${dpi}`);
    }
  };

  await cdp.eval(`document.querySelector('[data-act="export"][data-id="1"]').click()`);
  await grab('1inch');
  await cdp.eval(`document.querySelector('[data-act="export"][data-id="10"]').click()`);
  await grab('2inch');
  await cdp.eval(`document.querySelector('[data-act="sheet"]').click()`);
  await grab('sheet');

  log('  下载目录:', fs.readdirSync(DL));

  log('\\n全部通过');
} catch (e) {
  log('失败:', e.message);
  process.exitCode = 1;
} finally {
  try { cdp?.ws.close(); } catch {}
  chrome.kill();
}
