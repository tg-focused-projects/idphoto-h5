/**
 * 证件照 H5 —— 生图后端（本地 UI + 公网 API）
 * ============================================================
 *   node server.mjs                  # http://127.0.0.1:8088
 *
 * 两种调用面：
 *
 *  A. 本地 UI（H5 自己用）
 *     POST /api/generate   同步返回结果（等 40~90s，浏览器一直挂着连接）
 *
 *  B. 公网 API（给外部系统用，走 router.mjs + ngrok 暴露）
 *     GET  /api/health                 健康 + 号池额度
 *     POST /v1/jobs                    提交任务 → 202 {job_id, poll_url}
 *     GET  /v1/jobs/{id}               查任务 → pending|running|succeeded|failed
 *     GET  /files/{name}               取结果图
 *
 *     这套「提交任务 → 轮询 → 取图」的形状是照本机 ComfyUI 的
 *     POST /prompt → GET /history/{id} → GET /view?filename= 来的：
 *     生图要几十秒，长连接在公网（尤其移动网络/代理）上容易被掐，异步任务更稳。
 *
 * 鉴权 / 限流：
 *     只有当请求带 `X-Idphoto-Public: 1`（由 router.mjs 打上）时才强制 Bearer key，
 *     这样本机 H5 直接同源调用不需要密钥，公网必须带。
 *     key 从环境变量 IDPHOTO_API_KEYS（逗号分隔）或 api-keys.json 读，**不入库**。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toJpeg } from './lib/jpeg.mjs';
import {
  MODES, SUITS, BGS, SIZES, DEFAULTS,
  normalizeParams, buildPrompt, buildRefinePrompt, describeParams,
} from './lib/prompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const LIB_DIR = path.join(__dirname, 'lib');
const OUT_DIR = path.join(__dirname, 'outputs');
const PORT = Number(process.env.PORT || 8088);
const HOST = process.env.HOST || '127.0.0.1';

const C2A_BASE = process.env.C2A_BASE || 'http://127.0.0.1:38650';
const C2A_KEY_FILE = path.join(os.homedir(), '.dsh', 'chatgpt2api-native', 'admin-key');
const GEN_TIMEOUT_MS = Number(process.env.GEN_TIMEOUT_MS || 420_000);

const PUBLIC_MARKER = 'x-idphoto-public';
const JOB_TTL_MS = 60 * 60 * 1000;          // 任务记录留 1 小时
const JOB_MAX_KEEP = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------------------------------------------------------------- 配置 */
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; }
}
const CONFIG = loadConfig();
const API_CFG = CONFIG.api || {};

// 公网模式：整站对外（frp / 公网反代直接连本进程），所有 /api/*、/v1/* 都要 key。
// 本地同源开发默认不开，H5 直接调不需要密钥。
const PUBLIC_MODE = String(process.env.IDPHOTO_PUBLIC ?? (API_CFG.public ? '1' : '0')) === '1';
const PER_MINUTE = Number(API_CFG.rateLimit?.perMinute ?? 6);
const PER_DAY = Number(API_CFG.rateLimit?.perDay ?? 80);
const POLL_PER_MINUTE = Number(API_CFG.rateLimit?.pollPerMinute ?? 120);
const CORS = Array.isArray(API_CFG.cors) && API_CFG.cors.length ? API_CFG.cors : ['*'];

function loadKeys() {
  const env = String(process.env.IDPHOTO_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'api-keys.json'), 'utf8'));
    return (Array.isArray(j) ? j : j.keys || []).map(String).filter(Boolean);
  } catch { return []; }
}
const KEYS = loadKeys();

function c2aKey() {
  try { return fs.readFileSync(C2A_KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

/* ---------------------------------------------------------------- 工具 */
function json(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allow = CORS.includes('*') ? '*' : (CORS.includes(origin) ? origin : '');
  if (!allow) return {};
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    ...(allow === '*' ? {} : { Vary: 'Origin' }),
  };
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大（照片压到 12MB 内）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientKey(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

function isPublicCall(req) {
  return String(req.headers[PUBLIC_MARKER] || '') === '1';
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 返回 null 表示放行，否则返回 [status, body]
 *  kind: 'gen' 提交生成（按 perMinute/perDay 限）
 *        'poll' 查任务/取图（轮询很密，单独一档，别和生成抢额度）
 */
function guard(req, kind = 'gen') {
  // 本机同源（没走公网入口）且不是公网模式 → 放行
  if (!PUBLIC_MODE && !isPublicCall(req)) return null;
  if (!KEYS.length) return [503, { ok: false, error: '服务端未配置 API key（api-keys.json / IDPHOTO_API_KEYS）' }];
  const k = clientKey(req);
  if (!k) return [401, { ok: false, error: '缺少 Authorization: Bearer <key>' }];
  if (!KEYS.some((x) => safeEqual(x, k))) return [403, { ok: false, error: 'API key 无效' }];

  const now = Date.now();
  const bucket = rl.get(k) || { minStart: now, minCount: 0, dayStart: now, dayCount: 0, pollStart: now, pollCount: 0 };
  if (now - bucket.minStart >= 60_000) { bucket.minStart = now; bucket.minCount = 0; }
  if (now - bucket.dayStart >= 86_400_000) { bucket.dayStart = now; bucket.dayCount = 0; }
  if (now - bucket.pollStart >= 60_000) { bucket.pollStart = now; bucket.pollCount = 0; }

  if (kind === 'poll') {
    bucket.pollCount++;
    rl.set(k, bucket);
    if (bucket.pollCount > POLL_PER_MINUTE) {
      return [429, { ok: false, error: `轮询限流：每分钟最多 ${POLL_PER_MINUTE} 次`, retry_after_s: Math.ceil((bucket.pollStart + 60_000 - now) / 1000) }];
    }
    return null;
  }

  bucket.minCount++;
  bucket.dayCount++;
  rl.set(k, bucket);
  if (bucket.minCount > PER_MINUTE) {
    return [429, { ok: false, error: `限流：每分钟最多 ${PER_MINUTE} 次生成`, retry_after_s: Math.ceil((bucket.minStart + 60_000 - now) / 1000) }];
  }
  if (bucket.dayCount > PER_DAY) {
    return [429, { ok: false, error: `限流：每天最多 ${PER_DAY} 次生成` }];
  }
  return null;
}
const rl = new Map();

function sniff(buf) {
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return '.png';
}

function parseImage(s) {
  const str = String(s || '');
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(str);
  if (m) return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
  if (/^https?:\/\//i.test(str)) return { url: str };
  throw new Error('image 需要 data:image/*;base64,... 或 http(s) 图片地址');
}

async function backendStatus() {
  try {
    const r = await fetch(`${C2A_BASE}/health?format=json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { reachable: false, http: r.status };
    const j = await r.json();
    return { reachable: true, active: j?.accounts?.active ?? 0, quota: j?.accounts?.total_quota ?? 0, version: j?.version ?? '' };
  } catch (e) {
    return { reachable: false, error: String(e?.message || e) };
  }
}

/* ------------------------------------------------------- 调生图后端 */
async function callImageApi({ image, prompt, size, model }) {
  const k = c2aKey();
  if (!k) throw new Error('读不到 chatgpt2api admin-key（先启动一次 DSH）');

  let img;
  if (image.url) {
    const r = await fetch(image.url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`下载参考图失败 HTTP ${r.status}`);
    img = { mime: r.headers.get('content-type') || 'image/jpeg', buffer: Buffer.from(await r.arrayBuffer()) };
  } else {
    img = image;
  }
  if (img.buffer.length > 12 * 1024 * 1024) throw new Error('参考图超过 12MB');

  const payload = {
    model: model || 'gpt-image-2',
    prompt,
    n: 1,
    response_format: 'b64_json',
    ...(size ? { size } : {}),
    images: [{ b64_json: img.buffer.toString('base64'), mime_type: img.mime, filename: 'reference-1.jpg' }],
  };

  const r = await fetch(`${C2A_BASE}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });
  const text = await r.text();
  let b = null;
  try { b = JSON.parse(text); } catch {}

  if (!r.ok) {
    const detail = b?.detail?.error || b?.detail?.message || b?.error?.message || b?.error || text.slice(0, 300);
    const s = String(detail);
    const hint = /content[_ ]policy|safety|违反|防护|敏感|挑逗|性暗示/i.test(s)
      ? '上游内容策略拒绝：换成更「证件照」的描述'
      : /no available image quota|quota/i.test(s) ? '号池额度不足：面板刷新额度或补号' : '';
    const err = new Error(`生图失败 HTTP ${r.status}`);
    err.detail = s.slice(0, 400);
    err.hint = hint;
    throw err;
  }

  const first = b?.data?.[0];
  let bytes = null;
  if (first?.b64_json) bytes = Buffer.from(first.b64_json, 'base64');
  else if (first?.url) {
    const d = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
    bytes = Buffer.from(await d.arrayBuffer());
  }
  if (!bytes) throw new Error('生图响应里没有图片');

  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${sniff(bytes)}`;
  const full = path.join(OUT_DIR, name);
  await fsp.writeFile(full, bytes);

  // 公网带宽很贵：顺手压一张 JPEG（ngrok 免费通道 ~34KB/s，2MB 的 PNG 要 60s，200KB 的 JPEG 只要几秒）
  let jpeg = null;
  if (CONFIG.gen?.jpeg?.enabled !== false && name.endsWith('.png')) {
    jpeg = await toJpeg(full, { quality: Number(CONFIG.gen?.jpeg?.quality ?? 88) });
  }

  return { name, bytes: bytes.length, jpeg };
}

/* ------------------------------------------------------------ 任务队列 */
const jobs = new Map();

function newJobId() {
  return 'job_' + crypto.randomBytes(9).toString('hex');
}

function jobView(id, req) {
  const j = jobs.get(id);
  if (!j) return null;
  const base = publicBase(req);
  const view = {
    job_id: id,
    status: j.status,
    created_at: new Date(j.createdAt).toISOString(),
    elapsed_ms: j.finishedAt ? j.finishedAt - j.startedAt : (j.startedAt ? Date.now() - j.startedAt : 0),
    model: j.model,
    size: j.size,
    passes: j.passes || 1,
    poll_url: `${base}/v1/jobs/${id}`,
  };
  // 结构化入参的任务，把「后端最终拼出来的 prompt」也回给调用方，方便排查效果问题
  if (j.params) {
    view.params = j.params;
    view.params_summary = j.paramsSummary || null;
    view.prompt = j.prompt;
  }
  if (j.status === 'succeeded') {
    view.result = {
      url: `${base}/files/${j.result.name}`,
      bytes: j.result.bytes,
      width: j.result.width || null,
      height: j.result.height || null,
    };
    if (j.result.jpeg) {
      view.result.jpeg_url = `${base}/files/${j.result.jpeg.name}`;
      view.result.jpeg_bytes = j.result.jpeg.bytes;
    }
    if (j.result.firstPass) {
      view.result.first_pass_url = `${base}/files/${j.result.firstPass.name}`;
      view.result.refine_prompt = j.refinePrompt || null;
    }
  }
  if (j.status === 'failed') view.error = { message: j.error, detail: j.errorDetail || null, hint: j.errorHint || null };
  return view;
}

function publicBase(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  const prefix = req.headers['x-forwarded-prefix'] || '';
  return `${proto}://${host}${prefix}`;
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
  if (jobs.size > JOB_MAX_KEEP) {
    const sorted = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of sorted.slice(0, jobs.size - JOB_MAX_KEEP)) jobs.delete(id);
  }
}
setInterval(sweepJobs, 5 * 60 * 1000).unref?.();

async function runJob(id) {
  const j = jobs.get(id);
  if (!j) return;
  j.status = 'running';
  j.startedAt = Date.now();
  try {
    let out = await callImageApi({ image: j.image, prompt: j.prompt, size: j.size, model: j.model });

    // passes=2：拿第一轮结果当参考图再精修一轮（多消耗 1 次额度）
    if (j.passes === 2 && j.refinePrompt) {
      const first = out;
      const pngPath = path.join(OUT_DIR, first.name);
      const buf = await fsp.readFile(pngPath);
      const refined = await callImageApi({
        image: { mime: 'image/png', buffer: buf },
        prompt: j.refinePrompt,
        size: j.size,
        model: j.model,
      });
      refined.firstPass = first;
      out = refined;
    }

    j.status = 'succeeded';
    j.result = out;
    j.finishedAt = Date.now();
  } catch (e) {
    j.status = 'failed';
    j.error = String(e.message || e);
    j.errorDetail = e.detail || null;
    j.errorHint = e.hint || null;
    j.finishedAt = Date.now();
  } finally {
    delete j.image; // 不长期持有参考图
  }
}

/* -------------------------------------------------------------- 路由 */
async function handleApi(req, res, url) {
  // /api/config 是给前端渲染用的非敏感配置（不含 key），公网模式下也放行
  if (req.method === 'GET' && url === '/api/config') {
    return json(res, 200, { ok: true, ...CONFIG, public: PUBLIC_MODE }, corsHeaders(req));
  }

  const isGen = req.method === 'POST' && (url === '/api/generate' || url === '/api/idphoto'
    || url === '/v1/jobs' || url === '/api/jobs' || url === '/v1/idphoto');
  const g = guard(req, isGen ? 'gen' : 'poll');
  if (g) return json(res, g[0], g[1], corsHeaders(req));

  // 可选参数表：前端拿它渲染下拉框，不用把枚举写死在客户端
  if (req.method === 'GET' && (url === '/v1/options' || url === '/api/options')) {
    return json(res, 200, {
      ok: true,
      modes: MODES,
      suits: SUITS,
      bgs: BGS,
      sizes: SIZES,
      defaults: DEFAULTS,
      notes: {
        passes: '1=一轮出图；2=出图后自动用结果再精修一轮（多消耗 1 次额度）',
        size: '出图尺寸，构图裁剪在客户端按规格像素做',
        extra: '自由补充要求，最长 300 字',
      },
    }, corsHeaders(req));
  }

  // 健康 / 状态
  if (req.method === 'GET' && (url === '/api/health' || url === '/api/status')) {
    return json(res, 200, {
      ok: true,
      public: PUBLIC_MODE,
      backend: await backendStatus(),
      jobs: { total: jobs.size, running: [...jobs.values()].filter((j) => j.status === 'running').length },
      limits: { perMinute: PER_MINUTE, perDay: PER_DAY },
      features: CONFIG.features || {},
    }, corsHeaders(req));
  }

  // 同步生成（H5 用）
  if (req.method === 'POST' && url === '/api/generate') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON：' + e.message }, corsHeaders(req));
    }
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json(res, 400, { ok: false, error: '缺少 prompt' }, corsHeaders(req));
    let image;
    try { image = parseImage(body.image); } catch (e) {
      return json(res, 400, { ok: false, error: e.message }, corsHeaders(req));
    }
    const t0 = Date.now();
    try {
      const out = await callImageApi({ image, prompt, size: body.size, model: body.model });
      return json(res, 200, {
        ok: true,
        url: '/files/' + out.name,
        jpeg_url: out.jpeg ? '/files/' + out.jpeg.name : null,
        bytes: out.bytes,
        jpeg_bytes: out.jpeg?.bytes ?? null,
        elapsed_ms: Date.now() - t0,
        model: body.model || 'gpt-image-2',
      }, corsHeaders(req));
    } catch (e) {
      const code = /超时|timeout/i.test(String(e.message)) ? 504 : 502;
      return json(res, code, { ok: false, error: e.message, detail: e.detail, hint: e.hint }, corsHeaders(req));
    }
  }

  // ── 结构化参数：同步版（H5 用）─────────────────────────────
  //    POST /api/idphoto  { image, mode, suit, bg, cleanShave, tidyHair, extra, size, passes }
  //    后端按参数拼 prompt，前端不再传提示词。
  if (req.method === 'POST' && url === '/api/idphoto') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON：' + e.message }, corsHeaders(req));
    }
    const norm = normalizeParams(body);
    if (!norm.ok) return json(res, 400, { ok: false, error: norm.error }, corsHeaders(req));
    let image;
    try { image = parseImage(body.image); } catch (e) {
      return json(res, 400, { ok: false, error: e.message }, corsHeaders(req));
    }

    const params = norm.params;
    const prompt = params.refineOnly ? buildRefinePrompt(params) : buildPrompt(params);
    const t0 = Date.now();
    try {
      let out = await callImageApi({ image, prompt, size: params.size, model: body.model });
      let firstPass = null;
      let refinePrompt = null;
      if (!params.refineOnly && params.passes === 2) {
        firstPass = out;
        refinePrompt = buildRefinePrompt(params);
        const buf = await fsp.readFile(path.join(OUT_DIR, firstPass.name));
        out = await callImageApi({
          image: { mime: 'image/png', buffer: buf },
          prompt: refinePrompt,
          size: params.size,
          model: body.model,
        });
      }
      return json(res, 200, {
        ok: true,
        params,
        params_summary: describeParams(params),
        prompt,
        ...(refinePrompt ? { refine_prompt: refinePrompt } : {}),
        url: '/files/' + out.name,
        jpeg_url: out.jpeg ? '/files/' + out.jpeg.name : null,
        bytes: out.bytes,
        jpeg_bytes: out.jpeg?.bytes ?? null,
        ...(firstPass ? { first_pass_url: '/files/' + firstPass.name } : {}),
        elapsed_ms: Date.now() - t0,
        model: body.model || 'gpt-image-2',
      }, corsHeaders(req));
    } catch (e) {
      const code = /超时|timeout/i.test(String(e.message)) ? 504 : 502;
      return json(res, code, { ok: false, error: e.message, detail: e.detail, hint: e.hint, prompt }, corsHeaders(req));
    }
  }

  // ── 结构化参数：异步版（公网 API 用）───────────────────────
  //    POST /v1/idphoto  → 202 { job_id, poll_url, prompt, params }
  if (req.method === 'POST' && url === '/v1/idphoto') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON：' + e.message }, corsHeaders(req));
    }
    const norm = normalizeParams(body);
    if (!norm.ok) return json(res, 400, { ok: false, error: norm.error }, corsHeaders(req));
    let image;
    try { image = parseImage(body.image); } catch (e) {
      return json(res, 400, { ok: false, error: e.message }, corsHeaders(req));
    }
    if (image.buffer && image.buffer.length > 12 * 1024 * 1024) {
      return json(res, 413, { ok: false, error: '参考图超过 12MB' }, corsHeaders(req));
    }

    const params = norm.params;
    const prompt = params.refineOnly ? buildRefinePrompt(params) : buildPrompt(params);
    const id = newJobId();
    const job = {
      status: 'pending', createdAt: Date.now(), startedAt: 0, finishedAt: 0,
      image, prompt, params, paramsSummary: describeParams(params),
      passes: params.refineOnly ? 1 : params.passes,
      refinePrompt: (!params.refineOnly && params.passes === 2) ? buildRefinePrompt(params) : null,
      size: params.size,
      model: body.model || CONFIG.gen?.model || 'gpt-image-2',
    };
    jobs.set(id, job);
    setImmediate(() => runJob(id));

    return json(res, 202, {
      ok: true,
      job_id: id,
      status: 'pending',
      poll_url: `${publicBase(req)}/v1/jobs/${id}`,
      retry_after_ms: 3000,
      params,
      params_summary: job.paramsSummary,
      prompt,
      ...(job.refinePrompt ? { refine_prompt: job.refinePrompt } : {}),
    }, corsHeaders(req));
  }

  // 异步任务：提交（原始 prompt 版，给需要完全自定义提示词的调用方）
  if (req.method === 'POST' && (url === '/v1/jobs' || url === '/api/jobs')) {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON：' + e.message }, corsHeaders(req));
    }
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json(res, 400, { ok: false, error: '缺少 prompt' }, corsHeaders(req));
    let image;
    try { image = parseImage(body.image); } catch (e) {
      return json(res, 400, { ok: false, error: e.message }, corsHeaders(req));
    }
    if (image.buffer && image.buffer.length > 12 * 1024 * 1024) {
      return json(res, 413, { ok: false, error: '参考图超过 12MB' }, corsHeaders(req));
    }

    const id = newJobId();
    const job = {
      status: 'pending', createdAt: Date.now(), startedAt: 0, finishedAt: 0,
      image, prompt, size: body.size || CONFIG.gen?.size, model: body.model || CONFIG.gen?.model || 'gpt-image-2',
    };
    jobs.set(id, job);
    setImmediate(() => runJob(id));

    return json(res, 202, {
      ok: true,
      job_id: id,
      status: 'pending',
      poll_url: `${publicBase(req)}/v1/jobs/${id}`,
      retry_after_ms: 3000,
    }, corsHeaders(req));
  }

  // 异步任务：查询
  const jm = /^\/(?:v1|api)\/jobs\/([A-Za-z0-9_]+)$/.exec(url);
  if (req.method === 'GET' && jm) {
    const view = jobView(jm[1], req);
    if (!view) return json(res, 404, { ok: false, error: 'job 不存在或已过期' }, corsHeaders(req));
    return json(res, 200, { ok: true, ...view }, corsHeaders(req));
  }

  return json(res, 404, {
    ok: false,
    error: 'not found',
    endpoints: [
      'GET  /api/health',
      'GET  /v1/options',
      'POST /v1/idphoto      ← 结构化参数（推荐）：{ image, mode, suit, bg, cleanShave, tidyHair, extra, size, passes }',
      'POST /v1/jobs         ← 原始 prompt（自定义提示词用）',
      'GET  /v1/jobs/{id}',
      'GET  /files/{name}',
    ],
  }, corsHeaders(req));
}

async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/health') return json(res, 200, { ok: true });

  let file;
  if (p.startsWith('/files/') || p.startsWith('/outputs/')) {
    file = path.join(OUT_DIR, path.basename(p));
    if (!path.resolve(file).startsWith(path.resolve(OUT_DIR))) return json(res, 403, { ok: false, error: 'forbidden' });
  } else if (p.startsWith('/lib/')) {
    // 前后端共用的模块（lib/prompt.mjs 等），浏览器直接 import
    file = path.join(LIB_DIR, path.basename(p));
    if (!path.resolve(file).startsWith(path.resolve(LIB_DIR))) return json(res, 403, { ok: false, error: 'forbidden' });
  } else {
    file = path.join(PUBLIC_DIR, p);
    if (!path.resolve(file).startsWith(path.resolve(PUBLIC_DIR))) return json(res, 403, { ok: false, error: 'forbidden' });
  }

  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': p.startsWith('/files/') || p.startsWith('/outputs/') ? 'public, max-age=3600' : 'no-cache',
      ...corsHeaders(req),
    });
    res.end(data);
  } catch {
    try {
      const data = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
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
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    const isApi = url === '/api/health' || url === '/api/status' || url === '/api/config'
      || url === '/api/options' || url === '/v1/options'
      || url === '/api/idphoto' || url === '/v1/idphoto'
      || url.startsWith('/api/generate') || url.startsWith('/v1/jobs') || url.startsWith('/api/jobs');
    if (isApi) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' });
    return await serveStatic(req, res, url);
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) }, corsHeaders(req));
  }
});

server.listen(PORT, HOST, () => {
  const s = backendStatus();
  console.log(`[idphoto] listening http://${HOST}:${PORT}`);
  console.log(`[idphoto] 生图后端 ${C2A_BASE}  key:${c2aKey() ? 'ok' : 'missing'}`);
  console.log(`[idphoto] 公网调用需 Bearer key（PUBLIC_MODE=${PUBLIC_MODE}）；已加载 key 数: ${KEYS.length}`);
  console.log(`[idphoto] 限流 ${PER_MINUTE}/min, ${PER_DAY}/day`);
});
