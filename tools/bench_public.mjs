/**
 * 公网换装接口耗时拆解
 *   node tools/bench_public.mjs upload <baseURL> <key>
 *   node tools/bench_public.mjs gen    <baseURL> <key> [照片] [size] [pollMs]
 *
 * upload 模式（不消耗额度）：用非法参数触发 400，只测「上传 + 往返」，对比
 *   - 小图 / 大图
 *   - 明文 / gzip（Content-Encoding: gzip）
 *
 * gen 模式（消耗 1 次额度）：异步提交，记录
 *   submit(含上传) → 服务端生成 → 轮询发现延迟 → 下载 JPEG
 */
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';

const [, , mode, baseArg, key, arg3, arg4, arg5] = process.argv;
if (!mode || !baseArg || !key) {
  console.error('用法: node tools/bench_public.mjs upload|gen <baseURL> <key> [照片] [size] [pollMs]');
  process.exit(2);
}
const base = new URL(baseArg);

function req(method, pathname, body, { gzip = false, timeout = 300000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    let payload = body;
    if (body !== undefined && body !== null) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      if (gzip) {
        payload = zlib.gzipSync(payload, { level: 6 });
        headers['Content-Encoding'] = 'gzip';
      }
      headers['Content-Length'] = payload.length;
    }
    const r = http.request({
      host: base.hostname, port: base.port || 80, path: pathname, method, headers, timeout,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, ms: performance.now() - t0, json, raw: data, bytes: payload ? payload.length : 0, headers: res.headers });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ status: 0, ms: performance.now() - t0, error: e.message, bytes: payload ? payload.length : 0 }));
    if (payload) r.write(payload);
    r.end();
  });
}

function body(mime, buf, params) {
  return { image: `data:${mime};base64,` + buf.toString('base64'), params: params || { mode: '__bad__' } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === 'upload') {
  const small = fs.readFileSync('C:/DSH/rev/idphoto/out/test-photo-1280.jpg');   // 120KB
  const big = fs.readFileSync('C:/DSH/rev/idphoto/out/test-photo.jpg');          // 620KB
  const rows = [];
  for (const [name, buf] of [['小图 120KB', small], ['大图 620KB', big]]) {
    const b = body('image/jpeg', buf);
    const plain = Buffer.byteLength(JSON.stringify(b));
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(b))).length;
    const p = await req('POST', '/v1/idphoto', b);
    const g = await req('POST', '/v1/idphoto', b, { gzip: true });
    rows.push({ 场景: name, 明文KB: (plain / 1024).toFixed(0), gzipKB: (gz / 1024).toFixed(0), '明文耗时ms': p.ms.toFixed(0), gzip耗时ms: g.ms.toFixed(0), 状态: `${p.status}/${g.status}` });
  }
  console.table(rows);
} else {
  const photo = arg3 || 'C:/DSH/rev/idphoto/out/test-photo.jpg';
  const size = arg4 || '1024x1536';
  const pollMs = Number(arg5 || 1000);
  const buf = fs.readFileSync(photo);
  const b = body('image/jpeg', buf, { mode: 'suit', suit: 'black-suit', bg: '438edb', cleanShave: true, size });

  const t0 = performance.now();
  const submit = await req('POST', '/v1/idphoto', b);
  if (submit.status !== 202) {
    console.error('submit 失败', submit.status, submit.raw?.slice(0, 200));
    process.exit(1);
  }
  const tSubmit = performance.now() - t0;
  const jobId = submit.json.job_id;

  let view = null;
  let tDone = 0;
  for (let i = 0; i < 400; i++) {
    await sleep(pollMs);
    const r = await req('GET', `/v1/jobs/${jobId}`);
    view = r.json;
    if (view && (view.status === 'succeeded' || view.status === 'failed')) { tDone = performance.now() - t0; break; }
  }
  if (!view || view.status !== 'succeeded') {
    console.error('生成失败', JSON.stringify(view)?.slice(0, 300));
    process.exit(1);
  }

  const genMs = view.elapsed_ms;
  const urls = { png: view.result.url, jpg: view.result.jpeg_url };
  const dl = {};
  for (const [k, u] of Object.entries(urls)) {
    if (!u) continue;
    const t = performance.now();
    const r = await new Promise((resolve) => {
      http.get(u, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', () => resolve(0));
    });
    dl[k] = { ms: performance.now() - t, code: r, kb: k === 'jpg' ? (view.result.jpeg_bytes / 1024).toFixed(0) : (view.result.bytes / 1024).toFixed(0) };
  }

  console.log(`照片 ${path.basename(photo)} ${(fs.statSync(photo).size / 1024).toFixed(0)}KB  body ${(submit.bytes / 1024).toFixed(0)}KB  size=${size}  poll=${pollMs}ms`);
  console.table([{
    '提交(含上传)ms': tSubmit.toFixed(0),
    '服务端生成ms': genMs,
    '轮询发现延迟ms': (tDone - tSubmit - genMs).toFixed(0),
    '总到图ms': tDone.toFixed(0),
    'jpeg下载ms': dl.jpg ? dl.jpg.ms.toFixed(0) : '-',
    'png下载ms': dl.png ? dl.png.ms.toFixed(0) : '-',
    'jpegKB': dl.jpg?.kb, 'pngKB': dl.png?.kb,
  }]);
}
