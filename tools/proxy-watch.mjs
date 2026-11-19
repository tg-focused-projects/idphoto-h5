/**
 * 节点守护：观察出口是否可用，不可用就自动切到最快的可用节点
 * ============================================================
 *   node tools/proxy-watch.mjs            # 前台
 *   node tools/proxy-watch.mjs --once     # 只跑一轮（调试/被 cron 调）
 *
 * 前提：本机跑着我们自己的 mihomo（tools/make_mihomo_config.py 生成配置，
 *       mixed-port 7891，external-controller 127.0.0.1:9099），c2a 的 proxy 指向 7891。
 *       为什么不用 FlClash：它的控制器不对外、核心是服务进程（无提权杀不掉），
 *       无法程序化切节点。
 *
 * 逻辑（默认 60s 一轮）：
 *   1. 通过 7891 用 CONNECT 打一次 https://chatgpt.com/backend-api/models
 *      期望 401（说明加密出网正常）；超时/连不上 = 出口坏了
 *   2. 坏了：把 PROXY 组里每个节点在控制器上测一次延迟，切到最快的
 *   3. 没坏：每 10 分钟做一次「体检」，若当前节点比最快的慢 2 倍以上也切
 *   4. 所有动作写 proxy-watch.log；单实例靠 .proxy-watch.lock
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'proxy-watch.log');
const LOCK = path.join(ROOT, '.proxy-watch.lock');
const HEARTBEAT = path.join(ROOT, '.proxy-watch.heartbeat');

const PROXY = { host: '127.0.0.1', port: Number(process.env.PROXY_PORT || 7891) };
const CTRL = { host: '127.0.0.1', port: Number(process.env.CLASH_CTRL_PORT || 9099), secret: process.env.CLASH_SECRET || 'idphoto-local-2026' };
const GROUP = process.env.PROXY_GROUP || 'PROXY';
const EGRESS_HOST = process.env.EGRESS_HOST || 'chatgpt.com';
const EGRESS_PATH = process.env.EGRESS_PATH || '/backend-api/models';
const INTERVAL = Number(process.env.WATCH_INTERVAL_MS || 60_000);
const TUNE_EVERY = Number(process.env.TUNE_INTERVAL_MS || 600_000);
const ONCE = process.argv.includes('--once');

const log = (msg) => {
  const line = `${new Date().toISOString()}  ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {}
};

/* ------------------------------ 出口探测 ------------------------------ */
function connectViaProxy(host, port, timeout = 12_000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: PROXY.host, port: PROXY.port, method: 'CONNECT', path: `${host}:${port}` });
    req.setTimeout(timeout, () => req.destroy(new Error('connect timeout')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('proxy CONNECT ' + res.statusCode)); }
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

async function probeEgress() {
  const t0 = Date.now();
  let socket;
  try {
    socket = await connectViaProxy(EGRESS_HOST, 443);
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, why: String(e.message || e) };
  }
  return new Promise((resolve) => {
    const t = tls.connect({ socket, servername: EGRESS_HOST, rejectUnauthorized: false }, () => {
      t.write(`GET ${EGRESS_PATH} HTTP/1.1\r\nHost: ${EGRESS_HOST}\r\nUser-Agent: proxy-watch\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    const done = (ok, why) => {
      try { t.destroy(); } catch {}
      resolve({ ok, status: buf.match(/^HTTP\/1\.[01] (\d{3})/)?.[1], ms: Date.now() - t0, why });
    };
    t.setTimeout(15_000, () => done(false, 'tls timeout'));
    t.on('data', (c) => {
      buf += c.toString('latin1');
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (m) done(Number(m[1]) < 500, null);   // 4xx 也算通（chatgpt 未鉴权会 401）
    });
    t.on('error', (e) => done(false, String(e.message || e)));
  });
}

/* ------------------------------ 控制器 ------------------------------ */
function ctrl(method, pathname, body, timeout = 10_000) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: CTRL.host, port: CTRL.port, path: pathname, method,
      headers: {
        Authorization: 'Bearer ' + CTRL.secret,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      timeout,
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.on('error', () => resolve({ status: 0 }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function groupState() {
  const r = await ctrl('GET', '/proxies');
  if (r.status !== 200 || !r.json?.proxies) return null;
  const g = r.json.proxies[GROUP];
  if (!g) return null;
  return { now: g.now, nodes: (g.all || []).filter((n) => n !== 'AUTO' && n !== 'DIRECT' && n !== 'REJECT') };
}

async function nodeDelay(name) {
  const q = `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent('https://www.gstatic.com/generate_204')}&timeout=5000`;
  const r = await ctrl('GET', q, null, 8000);
  const d = r.json?.delay;
  return r.status === 200 && Number(d) > 0 ? Number(d) : Infinity;
}

async function pickBest(nodes) {
  const results = await Promise.all(nodes.map(async (n) => ({ name: n, delay: await nodeDelay(n) })));
  results.sort((a, b) => a.delay - b.delay);
  const alive = results.filter((x) => Number.isFinite(x.delay));
  return { best: alive[0] || null, alive: alive.length, total: nodes.length, sample: results.slice(0, 3) };
}

async function switchTo(name) {
  const r = await ctrl('PUT', `/proxies/${encodeURIComponent(GROUP)}`, { name });
  return r.status === 204 || r.status === 200;
}

/* ------------------------------ 主循环 ------------------------------ */
let lockFd = null;
if (!ONCE) {
  try { lockFd = fs.openSync(LOCK, 'w'); } catch { try { fs.unlinkSync(LOCK); lockFd = fs.openSync(LOCK, 'w'); } catch { process.exit(0); } }
  process.on('exit', () => { try { fs.closeSync(lockFd); fs.unlinkSync(LOCK); } catch {} });
}

let lastTune = 0;
let switchCount = 0;

async function tick() {
  const g = await groupState();
  if (!g) { log('控制器不可达（mihomo 没在跑？）'); return; }

  const probe = await probeEgress();
  const healthy = probe.ok;
  const head = `出口 ${healthy ? '正常' : '不通'}（${probe.status || probe.why || '?'}, ${probe.ms}ms） 当前=${g.now}`;

  if (!healthy) {
    const pick = await pickBest(g.nodes);
    if (!pick.best) { log(`${head} → 所有 ${pick.total} 个节点都测不通，保持现状`); return; }
    const ok = await switchTo(pick.best.name);
    if (ok) { switchCount += 1; lastTune = Date.now(); }
    log(`${head} → 切到 ${pick.best.name}（${pick.best.delay}ms，可用 ${pick.alive}/${pick.total}，${ok ? '成功' : '失败'}）`);
    return;
  }

  if (Date.now() - lastTune > TUNE_EVERY) {
    const pick = await pickBest(g.nodes);
    lastTune = Date.now();
    if (!pick.best) { log(`${head} 体检：节点全部测不通`); return; }
    const curDelay = await nodeDelay(g.now);
    if (Number.isFinite(curDelay) && pick.best.delay * 2 < curDelay) {
      const ok = await switchTo(pick.best.name);
      if (ok) switchCount += 1;
      log(`${head} 体检：${g.now}(${curDelay}ms) 明显慢于 ${pick.best.name}(${pick.best.delay}ms) → ${ok ? '已切换' : '切换失败'}`);
    } else {
      log(`${head} 体检：可用 ${pick.alive}/${pick.total}，最快 ${pick.best.name} ${pick.best.delay}ms，不切`);
    }
  }
}

if (ONCE) {
  await tick();
  log(`单轮结束；累计切换 ${switchCount} 次`);
  process.exit(0);
}

log(`proxy-watch start  pid=${process.pid}  代理=${PROXY.host}:${PROXY.port}  控制器=${CTRL.host}:${CTRL.port}  组=${GROUP}`);
for (;;) {
  try {
    await tick();
    fs.writeFileSync(HEARTBEAT, new Date().toISOString() + ' pid=' + process.pid + String.fromCharCode(10));
  } catch (e) { log('tick error: ' + String(e?.message || e)); }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
