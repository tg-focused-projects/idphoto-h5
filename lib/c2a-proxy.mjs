/**
 * /c2a/* 网关：把本机 chatgpt2api（默认 127.0.0.1:38650）受控地暴露到公网
 * ============================================================
 * 为什么不是直接开端口：frps 实测只放行 remotePort 8000，其它端口一律 "port not allowed"。
 * 所以走同一条已经打通的 8000，用路径分流。
 *
 * 设计要点（安全第一，c2a 的 /api/* 是管理面，绝对不能外露）：
 *   1. 只放行白名单路径：/v1/images/edits、/v1/images/generations、/v1/models
 *   2. 用独立的「暴露 key」（C2A_EXPOSE_KEYS / api-keys.json → c2aKeys），与 admin key 分离
 *   3. admin key 只在服务端注入，调用方永远看不到
 *   4. 独立限流 + 请求体上限；响应原样流式回传，长请求不被缓冲
 *   5. 每次调用记一行流水（trace 与 X-Trace-Id 对应）
 */
import http from 'node:http';
import crypto from 'node:crypto';

const ALLOW = [
  { method: 'POST', re: /^\/v1\/images\/edits$/ },
  { method: 'POST', re: /^\/v1\/images\/generations$/ },
  { method: 'GET', re: /^\/v1\/models$/ },
];

const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'authorization',
]);

function sameKey(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function createC2aProxy({ base = 'http://127.0.0.1:38650', adminKey = '', keys = [], maxBody = 24 * 1024 * 1024, perMinute = 12 } = {}) {
  const target = new URL(base);
  const buckets = new Map();

  function rateOk(id) {
    const now = Date.now();
    const b = buckets.get(id) || { start: now, count: 0 };
    if (now - b.start >= 60_000) { b.start = now; b.count = 0; }
    b.count += 1;
    buckets.set(id, b);
    return b.count <= perMinute;
  }

  function send(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > maxBody) {
        const e = new Error('请求体过大');
        e.status = 413;
        throw e;
      }
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  /** 返回 true 表示已处理；false 表示不是本网关的路径 */
  async function handle(req, res, url, { trace = '', log = () => {} } = {}) {
    const path = url.replace(/^\/(c2a|chatgpt2api)/, '') || '/';
    const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const t0 = Date.now();

    if (path === '/health' || path === '/') {
      const st = await probeHealth();
      return send(res, st.ok ? 200 : 503, {
        ok: st.ok,
        service: 'chatgpt2api-gateway',
        upstream: st.ok ? 'up' : 'down',
        allow: ALLOW.map((a) => `${a.method} /c2a${a.re.source.replace(/\\/g, '').replace(/^\^|\$$/g, '')}`),
        note: '管理面（/api/*）不对外，只有白名单里的 /v1 接口可用',
        trace_id: trace,
      }), true;
    }

    // 鉴权
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const given = m ? m[1].trim() : '';
    if (!given) return send(res, 401, { ok: false, code: 'missing_key', error: '需要 Authorization: Bearer <c2a 暴露 key>' }), true;
    if (!keys.some((k) => sameKey(k, given))) return send(res, 403, { ok: false, code: 'bad_key', error: 'c2a 暴露 key 无效' }), true;

    // 白名单
    const rule = ALLOW.find((a) => a.method === req.method && a.re.test(path));
    if (!rule) {
      return send(res, 403, {
        ok: false, code: 'path_not_allowed',
        error: `路径不在白名单：${req.method} ${path}`,
        allow: ALLOW.map((a) => `${a.method} /c2a${a.re.source.replace(/\\/g, '').replace(/^\^|\$$/g, '')}`),
      }), true;
    }

    if (!rateOk(clientIp)) return send(res, 429, { ok: false, code: 'rate_limited', error: `超过 ${perMinute} 次/分钟，请稍后再试` }), true;

    let body;
    try {
      body = req.method === 'POST' ? await readBody(req) : null;
    } catch (e) {
      return send(res, e.status || 400, { ok: false, code: 'bad_body', error: String(e.message || e) }), true;
    }

    const headers = { authorization: 'Bearer ' + adminKey };
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    headers['x-forwarded-for'] = clientIp;
    if (body) headers['content-length'] = String(body.length);

    const upstream = await new Promise((resolve) => {
      const r = http.request({
        host: target.hostname, port: Number(target.port || 80), path, method: req.method, headers,
        timeout: 420_000,
      }, (up) => resolve({ up }));
      r.on('timeout', () => r.destroy(new Error('upstream timeout 420s')));
      r.on('error', (e) => resolve({ error: e }));
      if (body) r.write(body);
      r.end();
    });

    if (upstream.error) {
      log({ trace, path, status: 502, ms: Date.now() - t0, bytes: body ? body.length : 0, note: 'upstream_unreachable' });
      return send(res, 502, {
        ok: false, code: 'c2a_unreachable',
        error: `chatgpt2api 不可达（${base}）：${String(upstream.error.message || upstream.error)}`,
        hint: '本机 c2a 没在跑时会这样，等守护拉起（约 60s）或手动启动',
        trace_id: trace,
      }), true;
    }

    const { up } = upstream;
    const outHeaders = {};
    for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k.toLowerCase())) outHeaders[k] = v;
    outHeaders['x-c2a-gateway'] = '1';
    if (trace) outHeaders['x-trace-id'] = trace;
    res.writeHead(up.statusCode || 502, outHeaders);
    up.pipe(res);
    up.on('end', () => log({
      trace, path, status: up.statusCode || 0, ms: Date.now() - t0,
      bytes: body ? body.length : 0, note: 'c2a_proxied',
    }));
    return true;
  }

  function probeHealth() {
    return new Promise((resolve) => {
      const r = http.get({ host: target.hostname, port: Number(target.port || 80), path: '/health?format=json', timeout: 4000 }, (up) => {
        let d = '';
        up.on('data', (c) => (d += c));
        up.on('end', () => {
          try {
            const j = JSON.parse(d);
            const a = j.accounts || {};
            resolve({ ok: String(j.status || '') === 'ok', accounts: a.active, quota: a.total_quota });
          } catch { resolve({ ok: false }); }
        });
      });
      r.on('timeout', () => { r.destroy(); resolve({ ok: false }); });
      r.on('error', () => resolve({ ok: false }));
    });
  }

  return { handle, probeHealth, ALLOW };
}
