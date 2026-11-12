/**
 * 公网 API 客户端示例（Node 20+，零依赖）
 * ============================================================
 *   node tools/public_api_client.mjs <照片> <公网baseURL> <apiKey> [prompt]
 *
 * 走的是「提交任务 → 轮询 → 取图」这套异步形状（照 ComfyUI 的 /prompt → /history → /view）：
 *
 *   POST {base}/v1/jobs           → 202 {job_id, poll_url}
 *   GET  {base}/v1/jobs/{id}      → {status: pending|running|succeeded|failed, result:{url}}
 *   GET  {base}/files/{name}      → 图片字节
 *
 * 为什么不用同步接口：单张 40~90s，公网长连接（尤其经代理/移动网络）容易被中间设备掐掉。
 */

import fs from 'node:fs';
import path from 'node:path';

const [, , photoArg, baseArg, keyArg, promptArg] = process.argv;
if (!photoArg || !baseArg || !keyArg) {
  console.error('用法: node tools/public_api_client.mjs <照片> <公网baseURL> <apiKey> [prompt]');
  process.exit(2);
}

const base = baseArg.replace(/\/+$/, '');
const prompt = promptArg || [
  '同一张照片的证件照处理',
  '服装换成深色西装外套，内搭白色衬衫并系深色领带',
  '背景替换为纯蓝色，无渐变、无阴影、无纹理',
  '正面免冠，双肩平齐，面部居中，头顶留白自然，光线均匀',
  '五官比例与本人一致，保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛',
].join('；');

const mime = /\.png$/i.test(photoArg) ? 'image/png' : 'image/jpeg';
const dataUrl = `data:${mime};base64,` + fs.readFileSync(photoArg).toString('base64');
console.log(`照片 ${path.basename(photoArg)}  payload ${(dataUrl.length / 1024 / 1024).toFixed(2)}MB`);

const auth = { Authorization: `Bearer ${keyArg}`, 'Content-Type': 'application/json' };

// 1) 提交
const t0 = Date.now();
const submit = await fetch(`${base}/v1/jobs`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ image: dataUrl, prompt, size: '1024x1536' }),
});
const job = await submit.json();
console.log('submit', submit.status, JSON.stringify(job).slice(0, 300));
if (!job.ok) process.exit(1);

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
