/**
 * 公网 API 客户端示例（Node 20+，零依赖）
 * ============================================================
 *   node tools/public_api_client.mjs <照片> <公网baseURL> <apiKey> [prompt]
 *
 * 默认走**参数化接口**（推荐）：前端只传选项，提示词由后端拼。
 *   POST {base}/v1/idphoto  { image, params:{ mode, suit, bg, cleanShave, tidyHair, size, passes } }
 *   GET  {base}/v1/jobs/{id}
 *   GET  {base}/files/{name}
 *
 * 传了第 4 个参数（prompt）则改走原始提示词接口 POST {base}/v1/jobs。
 * 为什么异步：单张 40~90s，公网长连接容易被中间设备掐掉。
 */

import fs from 'node:fs';
import path from 'node:path';

const [, , photoArg, baseArg, keyArg, promptArg] = process.argv;
if (!photoArg || !baseArg || !keyArg) {
  console.error('用法: node tools/public_api_client.mjs <照片> <公网baseURL> <apiKey> [prompt]');
  process.exit(2);
}

const base = baseArg.replace(/\/+$/, '');
const dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(photoArg).toString('base64');
console.log(`照片 ${path.basename(photoArg)}  payload ${(dataUrl.length / 1024 / 1024).toFixed(2)}MB`);

const auth = { Authorization: `Bearer ${keyArg}`, 'Content-Type': 'application/json' };
const t0 = Date.now();

// 1) 提交：有 prompt 走原始接口，没有就走参数化接口
const useRaw = !!promptArg;
const submitBody = useRaw
  ? { image: dataUrl, prompt: promptArg, size: '1024x1536' }
  : { image: dataUrl, params: { mode: 'suit', suit: 'black-suit', bg: '438edb', cleanShave: true, tidyHair: false, size: '1024x1536', passes: 1 } };

const submit = await fetch(`${base}${useRaw ? '/v1/jobs' : '/v1/idphoto'}`, {
  method: 'POST', headers: auth, body: JSON.stringify(submitBody),
});
const job = await submit.json();
console.log(`submit ${submit.status}  ${useRaw ? '(原始 prompt)' : '(参数化)'}`);
if (job.params_summary) console.log('  params:', job.params_summary);
if (job.prompt) console.log('  prompt:', job.prompt);
if (!job.ok) { console.error(JSON.stringify(job)); process.exit(1); }

// 2) 轮询
let view = null;
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const r = await fetch(`${base}/v1/jobs/${job.job_id}`, { headers: { Authorization: `Bearer ${keyArg}` } });
  view = await r.json();
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  process.stdout.write(`\r  [${s}s] ${view.status}          `);
  if (view.status === 'succeeded' || view.status === 'failed') break;
}
console.log('');

if (view?.status !== 'succeeded') {
  console.error('失败:', JSON.stringify(view));
  process.exit(1);
}

// 3) 取图：优先拿 jpeg（公网带宽差 10 倍），没有就退回 png
const pick = view.result.jpeg_url || view.result.url;
const img = await fetch(pick);
const buf = Buffer.from(await img.arrayBuffer());
const ext = pick.endsWith('.jpg') ? '.jpg' : '.png';
const out = path.join(process.cwd(), 'out', `public-api-${Date.now()}${ext}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);

console.log(`结果 png: ${view.result.url}  (${(view.result.bytes / 1024).toFixed(0)}KB)`);
if (view.result.jpeg_url) {
  console.log(`结果 jpg: ${view.result.jpeg_url}  (${(view.result.jpeg_bytes / 1024).toFixed(0)}KB)`);
}
console.log(`落盘 ${out}  ${buf.length}B  总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
