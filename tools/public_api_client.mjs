/**
 * 鍏綉 API 瀹㈡埛绔ず渚嬶紙Node 20+锛岄浂渚濊禆锛? * ============================================================
 *   node tools/public_api_client.mjs <鐓х墖> <鍏綉baseURL> <apiKey> [prompt]
 *
 * 榛樿璧?*鍙傛暟鍖栨帴鍙?*锛堟帹鑽愶級锛氬墠绔彧浼犻€夐」锛屾彁绀鸿瘝鐢卞悗绔嫾銆? *   POST {base}/v1/idphoto  { image, params:{ mode, suit, bg, cleanShave, tidyHair, size, passes } }
 *   GET  {base}/v1/jobs/{id}
 *   GET  {base}/files/{name}
 *
 * 浼犱簡绗?4 涓弬鏁帮紙prompt锛夊垯鏀硅蛋鍘熷鎻愮ず璇嶆帴鍙?POST {base}/v1/jobs銆? * 涓轰粈涔堝紓姝ワ細鍗曞紶 40~90s锛屽叕缃戦暱杩炴帴瀹规槗琚腑闂磋澶囨帎鎺夈€? */

import fs from 'node:fs';
import path from 'node:path';

const [, , photoArg, baseArg, keyArg, promptArg] = process.argv;
if (!photoArg || !baseArg || !keyArg) {
  console.error('鐢ㄦ硶: node tools/public_api_client.mjs <鐓х墖> <鍏綉baseURL> <apiKey> [prompt]');
  process.exit(2);
}

const base = baseArg.replace(/\/+$/, '');
const dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(photoArg).toString('base64');
console.log(`鐓х墖 ${path.basename(photoArg)}  payload ${(dataUrl.length / 1024 / 1024).toFixed(2)}MB`);

const auth = { Authorization: `Bearer ${keyArg}`, 'Content-Type': 'application/json' };
const t0 = Date.now();

// 1) 鎻愪氦锛氭湁 prompt 璧板師濮嬫帴鍙ｏ紝娌℃湁灏辫蛋鍙傛暟鍖栨帴鍙?const useRaw = !!promptArg;
const submitBody = useRaw
  ? { image: dataUrl, prompt: promptArg, size: '1024x1536' }
  : { image: dataUrl, params: { mode: 'suit', suit: 'black-suit', bg: '438edb', cleanShave: true, tidyHair: false, size: '1024x1536', passes: 1 } };

const submit = await fetch(`${base}${useRaw ? '/v1/jobs' : '/v1/idphoto'}`, {
  method: 'POST', headers: auth, body: JSON.stringify(submitBody),
});
const job = await submit.json();
console.log(`submit ${submit.status}  ${useRaw ? '(鍘熷 prompt)' : '(鍙傛暟鍖?'}`);
if (job.params_summary) console.log('  params:', job.params_summary);
if (job.prompt) console.log('  prompt:', job.prompt);
if (!job.ok) { console.error(JSON.stringify(job)); process.exit(1); }

// 2) 杞
let view = null;
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await fetch(`${base}/v1/jobs/${job.job_id}`, { headers: { Authorization: `Bearer ${keyArg}` } });
  view = await r.json();
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  process.stdout.write(`\r  [${s}s] ${view.status}          `);
  if (view.status === 'succeeded' || view.status === 'failed') break;
}
console.log('');

if (view?.status !== 'succeeded') {
  console.error('澶辫触:', JSON.stringify(view));
  process.exit(1);
}

// 3) 鍙栧浘锛氫紭鍏堟嬁 jpeg锛堝叕缃戝甫瀹藉樊 10 鍊嶏級锛屾病鏈夊氨閫€鍥?png
const pick = view.result.jpeg_url || view.result.url;
const img = await fetch(pick);
const buf = Buffer.from(await img.arrayBuffer());
const ext = pick.endsWith('.jpg') ? '.jpg' : '.png';
const out = path.join(process.cwd(), 'out', `public-api-${Date.now()}${ext}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);

console.log(`缁撴灉 png: ${view.result.url}  (${(view.result.bytes / 1024).toFixed(0)}KB)`);
if (view.result.jpeg_url) {
  console.log(`缁撴灉 jpg: ${view.result.jpeg_url}  (${(view.result.jpeg_bytes / 1024).toFixed(0)}KB)`);
}
console.log(`钀界洏 ${out}  ${buf.length}B  鎬昏€楁椂 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

