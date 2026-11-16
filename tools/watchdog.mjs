/**
 * 守护进程：保证「本机 8000 服务 + frpc 隧道」一直活着
 * ------------------------------------------------------------
 *   node tools/watchdog.mjs            # 前台跑（调试用）
 *   start /min node tools\watchdog.mjs # 后台
 *
 * 为什么用 Node 而不是 PowerShell：这台机器上 PS 5.1 的 .ps1 需要 BOM，
 * 重定向和嵌套调用还有别的坑，Node 行为稳定、好测。
 *
 * 循环（默认 30s 一轮）：
 *   1. 8000 没监听            → 起 server.mjs（公网模式，注入 C2A_KEY_FILE）
 *   2. 本地 health 不是 401/200 → 杀掉重启
 *   3. frpc 没有              → 起 frpc（token 从 .env 注入）
 *   4. 本地正常但公网不通      → 重启 frpc
 *
 * 只在有动作时写 watchdog.log，避免刷屏。
 */
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'watchdog.log');
const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 30_000);
const LOCAL_PORT = 8000;
const PUBLIC_URL = process.env.PUBLIC_BASE || 'http://110.40.183.197:8000';
const C2A_KEY_FILE = path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', '.dsh', 'chatgpt2api-native', 'admin-key');
const FRPC_CANDIDATES = [
  'D:\\Qwen-Image-Edit-2511\\tools\\frp\\frp_0.70.1_windows_amd64\\frpc.exe',
  'C:\\DSH\\tools\\frp\\frpc.exe',
];

const log = (msg) => {
  const line = `${new Date().toISOString()}  ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {}
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tcpOpen(port, host = '127.0.0.1', timeout = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function httpCode(url, timeout = 8000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

function frpcRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq frpc.exe', '/NH'], { encoding: 'utf8', timeout: 8000 });
    return /frpc\.exe/i.test(out);
  } catch { return false; }
}

function frpToken() {
  const files = [path.join(ROOT, '.env'), 'D:\\Qwen-Image-Edit-2511\\.env'];
  for (const f of files) {
    try {
      const m = /^FRP_AUTH_TOKEN=(.+)$/m.exec(fs.readFileSync(f, 'utf8'));
      if (m) return m[1].trim();
    } catch {}
  }
  return '';
}

function spawnDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
  child.unref();
  return child;
}

function startServer() {
  spawnDetached(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(LOCAL_PORT), IDPHOTO_PUBLIC: '1', C2A_KEY_FILE },
  });
}

function startFrpc() {
  const bin = FRPC_CANDIDATES.find((p) => fs.existsSync(p));
  if (!bin) return false;
  const token = frpToken();
  if (!token) return false;
  spawnDetached(bin, ['-c', path.join(ROOT, 'frpc.toml')], { env: { ...process.env, FRP_AUTH_TOKEN: token } });
  return true;
}

function killByPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 8000 });
    const line = out.split(/\r?\n/).find((l) => new RegExp(`:${port}\\s+.*LISTENING`).test(l));
    if (!line) return false;
    const pid = line.trim().split(/\s+/).pop();
    if (!pid || pid === '0') return false;
    execFileSync('taskkill', ['/PID', pid, '/F'], { timeout: 8000 });
    return true;
  } catch { return false; }
}

function killFrpc() {
  try { execFileSync('taskkill', ['/IM', 'frpc.exe', '/F'], { timeout: 8000 }); } catch {}
}

let lastRestart = 0;
const cooldownOk = () => Date.now() - lastRestart > 45_000;

async function tick() {
  const acts = [];

  // 1) 本地服务
  if (!(await tcpOpen(LOCAL_PORT))) {
    if (!cooldownOk()) return;
    startServer();
    for (let i = 0; i < 20 && !(await tcpOpen(LOCAL_PORT)); i++) await sleep(500);
    acts.push((await tcpOpen(LOCAL_PORT)) ? 'started server:8000' : 'FAILED start server:8000');
    lastRestart = Date.now();
  }

  // 2) 本地 health
  const localCode = await httpCode(`http://127.0.0.1:${LOCAL_PORT}/api/health`);
  if (localCode !== 200 && localCode !== 401) {
    if (!cooldownOk()) return;
    killByPort(LOCAL_PORT);
    await sleep(800);
    startServer();
    for (let i = 0; i < 20 && !(await tcpOpen(LOCAL_PORT)); i++) await sleep(500);
    acts.push(`local health=${localCode} -> restarted`);
    lastRestart = Date.now();
  }

  // 3) 隧道进程
  if (!frpcRunning()) {
    acts.push(startFrpc() ? 'started frpc' : 'FAILED start frpc (bin/token missing)');
    await sleep(4000);
  }

  // 4) 公网体检
  const c2 = await httpCode(`http://127.0.0.1:${LOCAL_PORT}/api/health`);
  if (c2 === 200 || c2 === 401) {
    const pub = await httpCode(`${PUBLIC_URL}/api/health`, 12000);
    if (pub !== 200 && pub !== 401) {
      if (!cooldownOk()) return;
      killFrpc();
      await sleep(1500);
      startFrpc();
      await sleep(6000);
      acts.push(`public=${pub} -> restarted frpc, now=${await httpCode(`${PUBLIC_URL}/api/health`, 12000)}`);
      lastRestart = Date.now();
    }
  }

  if (acts.length) log(acts.join('; '));
}

log(`watchdog start  root=${ROOT}  interval=${INTERVAL_MS}ms  public=${PUBLIC_URL}`);
for (;;) {
  try { await tick(); } catch (e) { log('tick error: ' + String(e?.message || e)); }
  await sleep(INTERVAL_MS);
}
