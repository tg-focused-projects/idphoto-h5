/**
 * 公网 API 客户端（推荐写法）
 * ============================================================
 *   node tools/public_api_client.mjs <照片> <baseURL> <apiKey> [prompt]
 *
 * 推荐链路（比 JSON + 定时轮询快、也省流量）：
 *   1) POST /v1/idphoto/raw?...     body 直接是图片字节，省掉 base64 的 33%
 *   2) GET  /v1/jobs/{id}?wait=25   长轮询，服务端挂住到任务终态才返回
 *   3) GET  result.jpeg_url        取图（/files 不需要 key）
 *
 * 传了第 4 个参数（prompt）则走原始提示词接口 POST /v1/jobs（自定义提示词用）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [, , photoArg, baseArg, keyArg, promptArg] = process.argv;
if (!photoArg || !baseArg || !keyArg) {
  console.error('用法: node tools/public_api_client.mjs <照片> <baseURL> <apiKey> [prompt]');
  process.exit(2);
}

const base = new URL(baseArg);
const body = fs.readFileSync(photoArg);
const t0 = performance.now();

function call(method, pathname, payload, headers = {}) {
  return new Promise((resolve) => {
    const h = { Authorization: 'Bearer ' + keyArg, ...headers };
    if (payload) h['Content-Length'] = payload.length;
    const req = http.request({ host: base.hostname, port: base.port || 80, path: pathname, method, headers: h, timeout: 400000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, json: j, raw: d });
      });
    });
    req.on('error', (e) => resolve({ status: 0, raw: e.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

let jobId = null;

if (promptArg) {
  // 原始提示词：仍走 JSON（要带 prompt）
  const payload = Buffer.from(JSON.stringify({ image: 'data:image/jpeg;base64,' + body.toString('base64'), prompt: promptArg, size: '1024x1536' }));
  const r = await call('POST', '/v1/jobs', payload, { 'Content-Type': 'application/json' });
  if (r.status !== 202) { console.error('submit 失败', r.status, String(r.raw).slice(0, 200)); process.exit(1); }
  jobId = r.json.job_id;
  console.log(`submit(JSON+prompt) 202  job=${jobId}`);
} else {
  const qs = new URLSearchParams({ mode: 'suit', suit: 'black-suit', bg: '438edb', size: '295x413', cleanShave: '1' });
  const r = await call('POST', `/v1/idphoto/raw?${qs}`, body, { 'Content-Type': 'image/jpeg' });
  if (r.status === 200 && r.json?.cached) {
    console.log(`命中缓存 ${((performance.now() - t0) / 1000).toFixed(2)}s  0 额度`);
    console.log('  ', r.json.result.jpeg_url);
    process.exit(0);
  }
  if (r.status !== 202) { console.error('submit 失败', r.status, String(r.raw).slice(0, 200)); process.exit(1); }
  jobId = r.json.job_id;
  console.log(`submit(RAW ${(body.length / 1024).toFixed(0)}KB) 202  job=${jobId}  ${((performance.now() - t0) / 1000).toFixed(2)}s`);
}

let view = null;
let waits = 0;
while (performance.now() - t0 < 420000) {
  const r = await call('GET', `/v1/jobs/${jobId}?wait=25`);
  waits++;
  view = r.json;
  if (view && (view.status === 'succeeded' || view.status === 'failed')) break;
}

if (!view || view.status !== 'succeeded') {
  console.error('失败:', JSON.stringify(view)?.slice(0, 300));
  process.exit(1);
}

const url = view.result.jpeg_url || view.result.url;
const buf = await new Promise((resolve) => {
  http.get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
  }).on('error', () => resolve(Buffer.alloc(0)));
});
const out = path.join(process.cwd(), 'out', `public-api-${Date.now()}${url.endsWith('.jpg') ? '.jpg' : '.png'}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);

console.log(`长轮询 ${waits} 次，服务端生成 ${(view.elapsed_ms / 1000).toFixed(1)}s`);
console.log(`总耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s  →  ${out}  ${(buf.length / 1024).toFixed(0)}KB`);
