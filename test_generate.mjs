/**
 * 端到端自测：POST /api/generate（与前端同一路径），把结果落到 outputs/
 *   node test_generate.mjs [参考图] [底色hex] [模式]
 */
import fs from 'node:fs';
import path from 'node:path';

const ref = process.argv[2] || 'C:/DSH/rev/idphoto/out/demo_portrait.png';
const bg = process.argv[3] || '438edb';
const mode = process.argv[4] || 'suit';

const BG = { '438edb': '蓝色', 'ffffff': '白色', 'ff0000': '红色', '20537e': '深蓝色', 'cce9fc': '浅蓝色', 'a5aabd': '灰蓝色' };

const parts = [
  '同一张照片的证件照处理',
  mode === 'suit' ? '服装换成深色西装外套，内搭白色衬衫并系深色领带' : '保持人物的服装与姿势完全不变',
  `背景替换为纯${BG[bg] || '纯色'}，无渐变、无阴影、无纹理`,
  '正面免冠，双肩平齐，面部居中，头顶留白自然，光线均匀',
  '五官比例与本人一致，保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛',
];
const prompt = parts.join('；');

const mime = ref.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
const dataUrl = `data:${mime};base64,` + fs.readFileSync(ref).toString('base64');

console.log('参考图:', path.basename(ref), (dataUrl.length / 1024 / 1024).toFixed(2), 'MB payload');
console.log('提示词:', prompt);

const t0 = Date.now();
const r = await fetch('http://127.0.0.1:8088/api/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ image: dataUrl, prompt, size: '1024x1536' }),
});
const j = await r.json();
console.log('HTTP', r.status, JSON.stringify(j).slice(0, 500));
if (j.ok) {
  const src = path.join('C:/DSH/rev/idphoto/h5', j.url.replace(/^\//, ''));
  const dst = path.join('C:/DSH/rev/idphoto/out', `h5-result-${mode}-${bg}.png`);
  fs.copyFileSync(src, dst);
  console.log('落盘:', dst, fs.statSync(dst).size, 'bytes', '总耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
