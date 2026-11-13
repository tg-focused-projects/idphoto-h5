/**
 * 复现「连接被掐、收不到 HTTP 响应」：针对公网 /v1/idphoto 做四组传输层测试
 *   node tools/repro_conn_reset.mjs <baseURL> <apiKey>
 *
 * T1 小 JSON（有 Content-Length）
 * T2 大 JSON（~5MB base64，模拟手机原图）
 * T3 chunked（无 Content-Length，Nuxt/h3 流式转发常见）
 * T4 keep-alive 连接空闲 8s 后复用（代理池里的陈旧连接）
 * T5 空闲 30s 后复用
 */
import http from 'node:http';
import zlib from 'node:zlib';

const [, , baseArg, key] = process.argv;
if (!baseArg || !key) {
  console.error('用法: node tools/repro_conn_reset.mjs <baseURL> <apiKey>');
  process.exit(2);
}
const u = new URL(baseArg);
const host = u.hostname;
const port = Number(u.port || 80);

const smallBody = (payload) => JSON.stringify({ image: 'data:image/jpeg;base64,AAAA', params: { mode: '__bad__' }, payload });

function send({ label, body, chunked = false, agent, idleBeforeMs = 0 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({
      host, port, path: '/v1/idphoto', method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        ...(chunked ? {} : { 'Content-Length': Buffer.byteLength(body) }),
      },
      agent,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ label, ok: true, status: res.statusCode, ms: Date.now() - t0, body: data.slice(0, 120) }));
    });
    req.on('error', (e) => resolve({ label, ok: false, error: `${e.code || ''} ${e.message}`, ms: Date.now() - t0 }));
    req.setTimeout(60000, () => req.destroy(new Error('client timeout 60s')));

    const go = () => {
      if (chunked) {
        // 分块发送，不带 Content-Length
        const buf = Buffer.from(body);
        for (let i = 0; i < buf.length; i += 64 * 1024) req.write(buf.subarray(i, i + 64 * 1024));
        req.end();
      } else {
        req.end(body);
      }
    };
    idleBeforeMs ? setTimeout(go, idleBeforeMs) : go();
  });
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

console.log(`目标 ${baseArg}\n`);

const big = smallBody('x'.repeat(4 * 1024 * 1024));   // ~5MB body（含 base64 外的填充）
const results = [];
results.push(await send({ label: 'T1 小 JSON', body: smallBody('a'), agent }));
results.push(await send({ label: 'T2 大 JSON(~5MB)', body: big, agent }));
results.push(await send({ label: 'T3 chunked(~5MB)', body: big, chunked: true, agent: false }));
results.push(await send({ label: 'T4 keep-alive 复用(空闲 8s)', body: smallBody('b'), agent, idleBeforeMs: 8000 }));
results.push(await send({ label: 'T5 keep-alive 复用(空闲 30s)', body: smallBody('c'), agent, idleBeforeMs: 30000 }));
results.push(await send({ label: 'T6 keep-alive 复用(空闲 60s)', body: smallBody('d'), agent, idleBeforeMs: 60000 }));

agent.destroy();

for (const r of results) {
  console.log(r.ok
    ? `✔ ${r.label.padEnd(26)} HTTP ${r.status}  ${r.ms}ms  ${r.body}`
    : `✘ ${r.label.padEnd(26)} ${r.ms}ms  ${r.error}`);
}
