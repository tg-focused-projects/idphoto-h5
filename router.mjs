/**
 * 公网路由：一个公网端口同时服务两个本地服务
 * =====================================================
 *   /idphoto/*  → 127.0.0.1:8088   （本项目：生图 API + H5）
 *   其它        → 127.0.0.1:FALLBACK_PORT（默认 38650 chatgpt2api）
 *
 * 两个场景都靠它：
 *   1) ngrok：免费账号 dev 域名唯一，一个端点只能指一个本地端口 → 8090 分流到 8088 / 38650
 *   2) frp  ：frps 只放行 remotePort 8000，而这个口是 Qwen 生图 API 的
 *             → 8095 分流到 8088 / 8000，公网 8000 上两个服务共存
 *
 * 环境变量：
 *   ROUTER_PORT    监听端口（默认 8090）
 *   IDPHOTO_PORT   本项目端口（默认 8088）
 *   FALLBACK_PORT  其它流量转发到哪（默认 38650；走 frp 时设 8000）
 *   ROUTER_PREFIX  路径前缀（默认 /idphoto）
 */

import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.ROUTER_PORT || 8090);
const IDPHOTO = { host: '127.0.0.1', port: Number(process.env.IDPHOTO_PORT || 8088) };
const C2A = { host: '127.0.0.1', port: Number(process.env.FALLBACK_PORT || 38650) };
const PREFIX = process.env.ROUTER_PREFIX || '/idphoto';

function pick(url) {
  if (url === PREFIX || url.startsWith(PREFIX + '/') || url.startsWith(PREFIX + '?')) {
    const stripped = url.slice(PREFIX.length) || '/';
    return { target: IDPHOTO, path: stripped.startsWith('/') ? stripped : '/' + stripped, public: true };
  }
  return { target: C2A, path: url, public: false };
}

function forwardHeaders(req, target, pub) {
  const h = { ...req.headers };
  h.host = `${target.host}:${target.port}`;
  const ip = req.socket.remoteAddress || '';
  h['x-forwarded-for'] = h['x-forwarded-for'] ? `${h['x-forwarded-for']}, ${ip}` : ip;
  h['x-forwarded-proto'] = h['x-forwarded-proto'] || 'https';
  h['x-forwarded-host'] = h['x-forwarded-host'] || req.headers.host || '';
  if (pub) {
    h['x-forwarded-prefix'] = PREFIX;
    h['x-idphoto-public'] = '1';
  }
  return h;
}

const server = http.createServer((req, res) => {
  const { target, path: p, public: pub } = pick(req.url || '/');
  const proxyReq = http.request(
    { host: target.host, port: target.port, method: req.method, path: p, headers: forwardHeaders(req, target, pub) },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.setTimeout(600_000, () => proxyReq.destroy(new Error('upstream timeout')));
  proxyReq.on('error', (e) => {
    if (!res.headersSent) {
      const body = JSON.stringify({ ok: false, error: '上游不可达', detail: String(e.message || e) });
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    } else {
      res.destroy();
    }
  });

  req.pipe(proxyReq);
  req.on('aborted', () => proxyReq.destroy());
});

// WebSocket / upgrade（chatgpt2api 目前不用，但别让 SSE/WS 在这层断掉）
server.on('upgrade', (req, socket, head) => {
  const { target, path: p } = pick(req.url || '/');
  const up = net.connect(target.port, target.host, () => {
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    up.write(`${req.method} ${p} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[router] http://127.0.0.1:${PORT}`);
  console.log(`[router] ${PREFIX}/* -> ${IDPHOTO.host}:${IDPHOTO.port} (idphoto)`);
  console.log(`[router] /*        -> ${C2A.host}:${C2A.port} (fallback)`);
});
