/**
 * 二进制直传 + 长轮询 的端到端计时（对比 JSON+间隔轮询）
 *   node tools/bench_longpoll.mjs <baseURL> <key> [照片]
 *
 * 1) POST /v1/idphoto/raw?params...  body = 图片字节（省掉 base64 的 33%）
 * 2) GET  /v1/jobs/{id}?wait=25     服务端挂住，任务终态才返回（客户端不用 sleep）
 * 3) 下载 jpeg_url
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [, , baseArg, key, photoArg] = process.argv;
const photo = photoArg || 'C:/DSH/rev/idphoto/out/test-photo.jpg';
const base = new URL(baseArg);
const body = fs.readFileSync(photo);

function call(method, pathname, payload, headers = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const h = { Authorization: 'Bearer ' + key, ...headers };
    if (payload) h['Content-Length'] = payload.length;
    const req = http.request({ host: base.hostname, port: base.port || 80, path: pathname, method, headers: h, timeout: 300000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, ms: performance.now() - t0, json: j, raw: d });
      });
    });
    req.on('error', (e) => resolve({ status: 0, ms: performance.now() - t0, error: e.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const qs = new URLSearchParams({ mode: 'suit', suit: 'black-suit', bg: '438edb', size: '295x413', cleanShave: '1' });
const t0 = performance.now();
const submit = await call('POST', `/v1/idphoto/raw?${qs}`, body, { 'Content-Type': 'image/jpeg' });
const tSubmit = performance.now() - t0;

if (submit.status === 200 && submit.json?.cached) {
  console.log(`命中缓存：${tSubmit.toFixed(0)}ms，0 额度`);
  process.exit(0);
}
if (submit.status !== 202) {
  console.error('submit 失败', submit.status, String(submit.raw).slice(0, 200));
  process.exit(1);
}

const jobId = submit.json.job_id;
let waits = 0;
let view = null;
let tDone = 0;
while (performance.now() - t0 < 400000) {
  const r = await call('GET', `/v1/jobs/${jobId}?wait=25`);
  waits++;
  view = r.json;
  if (view && (view.status === 'succeeded' || view.status === 'failed')) { tDone = performance.now() - t0; break; }
}

if (!view || view.status !== 'succeeded') { console.error('失败', JSON.stringify(view)?.slice(0, 300)); process.exit(1); }

const url = view.result.jpeg_url || view.result.url;
const dl = await new Promise((resolve) => {
  const t = performance.now();
  http.get(url, (res) => { res.resume(); res.on('end', () => resolve({ ms: performance.now() - t, code: res.statusCode })); }).on('error', () => resolve({ ms: 0, code: 0 }));
});

console.log(`照片 ${path.basename(photo)} ${(body.length / 1024).toFixed(0)}KB（RAW，省掉 base64 的 33%）`);
console.table([{
  '提交ms': tSubmit.toFixed(0),
  '服务端生成ms': view.elapsed_ms,
  '长轮询次数': waits,
  '发现延迟ms': (tDone - tSubmit - view.elapsed_ms).toFixed(0),
  '总到图ms': tDone.toFixed(0),
  'jpeg下载ms': dl.ms.toFixed(0),
}]);
