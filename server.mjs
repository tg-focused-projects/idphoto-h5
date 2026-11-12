/**
 * 证件照 H5 —— 本地服务（静态站点 + chatgpt2api 生图代理）
 * ------------------------------------------------------------
 * 起：
 *     node server.mjs            # http://127.0.0.1:8088
 *
 * 设计要点：
 *  - 浏览器不接触 admin key，也不直连 38650（跨域 + 密钥泄漏两头都不该）。
 *  - /api/generate 转发到本机 chatgpt2api 的 /v1/images/edits，
 *    请求体与 CLI（C:\DSH\tools\c2a-image.mjs）完全一致：
 *        { model, prompt, n:1, response_format:'b64_json', size, images:[{b64_json,mime_type,filename}] }
 *  - 生成结果落盘到 ./outputs，只把 URL 回给前端（单张 1.7MB，别走 base64 回传）。
 *  - 会员 / 登录 / 广告：本服务一律没有。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUT_DIR = path.join(__dirname, 'outputs');
const PORT = Number(process.env.PORT || 8088);
const HOST = process.env.HOST || '127.0.0.1';

const C2A_BASE = process.env.C2A_BASE || 'http://127.0.0.1:38650';
const C2A_KEY_FILE = path.join(os.homedir(), '.dsh', 'chatgpt2api-native', 'admin-key');
const GEN_TIMEOUT_MS = 420_000; // 号池排队时单张要 40~90s，留足

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

fs.mkdirSync(OUT_DIR, { recursive: true });

function key() {
  try {
    return fs.readFileSync(C2A_KEY_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大（照片请先压到 12MB 内）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 后端健康 + 号池额度 */
async function backendStatus() {
  try {
    const r = await fetch(`${C2A_BASE}/health?format=json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { reachable: false, http: r.status };
    const j = await r.json();
    return {
      reachable: true,
      active: j?.accounts?.active ?? 0,
      quota: j?.accounts?.total_quota ?? 0,
      version: j?.version ?? '',
    };
  } catch (e) {
    return { reachable: false, error: String(e?.message || e) };
  }
}

function sniff(buf) {
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return '.png';
}

/** 解析 data URL → {buffer, mime} */
function parseDataUrl(s) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(s || ''));
  if (!m) throw new Error('图片数据格式不对，需要 data:image/*;base64,...');
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

async function handleGenerate(req, res) {
  const k = key();
  if (!k) return json(res, 500, { ok: false, error: '读不到 chatgpt2api admin-key（先启动一次 DSH）' });

  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (e) {
    return json(res, 400, { ok: false, error: '请求体不是合法 JSON：' + e.message });
  }

  const prompt = String(body.prompt || '').trim();
  if (!prompt) return json(res, 400, { ok: false, error: '缺少 prompt' });

  let img;
  try {
    img = parseDataUrl(body.image);
  } catch (e) {
    return json(res, 400, { ok: false, error: e.message });
  }
  if (img.buffer.length > 12 * 1024 * 1024) {
    return json(res, 400, { ok: false, error: '参考图超过 12MB，请先压缩' });
  }

  const payload = {
    model: body.model || 'gpt-image-2',
    prompt,
    n: 1,
    response_format: 'b64_json',
    ...(body.size ? { size: body.size } : {}),
    images: [{ b64_json: img.buffer.toString('base64'), mime_type: img.mime, filename: 'reference-1.jpg' }],
  };

  const started = Date.now();
  let text = '';
  let status = 0;
  try {
    const r = await fetch(`${C2A_BASE}/v1/images/edits`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
    });
    status = r.status;
    text = await r.text();
  } catch (e) {
    return json(res, 504, {
      ok: false,
      error: '生图请求失败或超时',
      detail: String(e?.message || e),
      timeout_s: GEN_TIMEOUT_MS / 1000,
    });
  }

  let b = null;
  try { b = JSON.parse(text); } catch { /* 非 JSON */ }

  if (status < 200 || status >= 300) {
    const detail = b?.detail?.error || b?.detail?.message || b?.error?.message || b?.error || text.slice(0, 300);
    const s = String(detail);
    const hint = /content[_ ]policy|safety|违反|防护|敏感|挑逗|性暗示/i.test(s)
      ? '上游内容策略拒绝：换成更“证件照”的描述，别写真人特写/写真'
      : /no available image quota|quota/i.test(s)
        ? '号池额度不足：面板「号池管理 → 全部刷新额度」或补号'
        : '';
    return json(res, 502, { ok: false, error: `生图失败 HTTP ${status}`, detail: s.slice(0, 400), ...(hint ? { hint } : {}) });
  }

  const first = b?.data?.[0];
  let bytes = null;
  if (first?.b64_json) bytes = Buffer.from(first.b64_json, 'base64');
  else if (first?.url) {
    const d = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
    bytes = Buffer.from(await d.arrayBuffer());
  }
  if (!bytes) return json(res, 502, { ok: false, error: '响应里没有图片', preview: text.slice(0, 300) });

  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${sniff(bytes)}`;
  await fsp.writeFile(path.join(OUT_DIR, name), bytes);

  return json(res, 200, {
    ok: true,
    url: '/outputs/' + name,
    bytes: bytes.length,
    elapsed_ms: Date.now() - started,
    items: Array.isArray(b?.data) ? b.data.length : 0,
  });
}

async function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';

  let file = p.startsWith('/outputs/')
    ? path.join(OUT_DIR, path.basename(p))
    : path.join(PUBLIC_DIR, p);

  // 防目录穿越
  const root = p.startsWith('/outputs/') ? OUT_DIR : PUBLIC_DIR;
  if (!path.resolve(file).startsWith(path.resolve(root))) return json(res, 403, { ok: false, error: 'forbidden' });

  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': p.startsWith('/outputs/') ? 'public, max-age=3600' : 'no-cache',
    });
    res.end(data);
  } catch {
    const index = path.join(PUBLIC_DIR, 'index.html'); // SPA 兜底
    try {
      const data = await fsp.readFile(index);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      json(res, 404, { ok: false, error: 'not found' });
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (req.method === 'GET' && url === '/api/status') {
      return json(res, 200, { ok: true, backend: await backendStatus(), features: loadFeatures() });
    }
    if (req.method === 'POST' && url === '/api/generate') return await handleGenerate(req, res);
    if (req.method === 'GET' && url === '/api/config') {
      return json(res, 200, { ok: true, ...loadConfig() });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' });
    return await serveStatic(req, res);
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}
function loadFeatures() {
  const c = loadConfig();
  return c.features || {};
}

server.listen(PORT, HOST, () => {
  console.log(`证件照 H5 已启动: http://${HOST}:${PORT}`);
  console.log(`生图后端: ${C2A_BASE}  (key: ${key() ? '已就绪' : '缺失'})`);
});
