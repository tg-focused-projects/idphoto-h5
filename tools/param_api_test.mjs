/**
 * 鍙傛暟鍖栨帴鍙ｈ嚜娴嬶紙涓嶄緷璧栨祻瑙堝櫒锛? *   node tools/param_api_test.mjs <鐓х墖> <baseURL> <apiKey> [sync|async] [passes]
 *
 * 璧版柊鎺ュ彛锛歅OST /v1/idphoto锛堝紓姝ワ級鎴?/api/idphoto锛堝悓姝ワ級锛屽墠绔彧浼犲弬鏁帮紝
 * 鎻愮ず璇嶇敱鍚庣 lib/prompt.mjs 鎷笺€? */
import fs from 'node:fs';
import path from 'node:path';

const [, , photo, baseArg, key, mode = 'async', passesArg = '1'] = process.argv;
if (!photo || !baseArg || !key) {
  console.error('鐢ㄦ硶: node tools/param_api_test.mjs <鐓х墖> <baseURL> <apiKey> [sync|async] [1|2]');
  process.exit(2);
}
const base = baseArg.replace(/\/+$/, '');
const passes = Number(passesArg);
const params = {
  mode: 'suit',
  suit: 'black-suit',
  bg: '438edb',
  cleanShave: true,
  tidyHair: false,
  size: '1024x1536',
  passes,
};

const dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(photo).toString('base64');
const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const t0 = Date.now();

if (mode === 'sync') {
  console.log(`[sync] POST ${base}/api/idphoto  passes=${passes}`);
  const r = await fetch(`${base}/api/idphoto`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ image: dataUrl, params }),
  });
  const j = await r.json();
  console.log('HTTP', r.status);
  console.log('params_summary:', j.params_summary);
  console.log('prompt:', j.prompt);
  if (j.refine_prompt) console.log('refine_prompt:', j.refine_prompt);
  if (!j.ok) { console.error(JSON.stringify(j)); process.exit(1); }
  console.log(`result: ${j.url}  ${(j.bytes / 1024).toFixed(0)}KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (j.first_pass_url) console.log('first_pass:', j.first_pass_url);
} else {
  console.log(`[async] POST ${base}/v1/idphoto  passes=${passes}`);
  const r = await fetch(`${base}/v1/idphoto`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ image: dataUrl, params }),
  });
  const job = await r.json();
  console.log('HTTP', r.status, 'job', job.job_id);
  console.log('params_summary:', job.params_summary);
  console.log('prompt:', job.prompt);
  if (job.refine_prompt) console.log('refine_prompt:', job.refine_prompt);
  if (!job.ok) { console.error(JSON.stringify(job)); process.exit(1); }

  let view;
  for (let i = 0; i < 300; i++) {
    await new Promise((r2) => setTimeout(r2, 1000));
    view = await (await fetch(`${base}/v1/jobs/${job.job_id}`, { headers: { Authorization: `Bearer ${key}` } })).json();
    process.stdout.write(`\r  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${view.status}          `);
    if (view.status === 'succeeded' || view.status === 'failed') break;
  }
  console.log('');
  if (view.status !== 'succeeded') { console.error(JSON.stringify(view)); process.exit(1); }
  console.log(`result: ${view.result.url}  ${(view.result.bytes / 1024).toFixed(0)}KB  鎬昏€楁椂 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (view.result.jpeg_url) console.log(`jpeg:   ${view.result.jpeg_url}  ${(view.result.jpeg_bytes / 1024).toFixed(0)}KB`);
  if (view.result.first_pass_url) console.log(`绗竴杞? ${view.result.first_pass_url}`);
  if (view.result.refine_prompt) console.log(`绮句慨鎻愮ず璇? ${view.result.refine_prompt}`);
}

