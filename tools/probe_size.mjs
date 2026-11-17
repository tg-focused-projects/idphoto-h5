/**
 * 直接打 c2a（绕过本项目 server 的 size 白名单），看上游到底接受什么尺寸、出图多少像素、耗时多少
 *   node tools/probe_size.mjs <size>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const size = process.argv[2] || '295x413';
const key = fs.readFileSync(path.join(os.homedir(), '.dsh', 'chatgpt2api-native', 'admin-key'), 'utf8').trim();
const photo = 'C:/DSH/rev/idphoto/out/test-photo-1280.jpg';
const b64 = fs.readFileSync(photo).toString('base64');

const prompt = [
  '同一张照片的证件照处理',
  '服装换成深色西装外套，内搭白色衬衫并系深色领带',
  '背景替换为纯蓝色，无渐变、无阴影、无纹理',
  '正面免冠，双肩平齐，面部居中，头顶留白自然，光线均匀',
  '五官比例与本人一致，保留真实皮肤质感，不做美颜、不瘦脸、不放大眼睛',
].join('；');

const t0 = Date.now();
const r = await fetch('http://127.0.0.1:38650/v1/images/edits', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-image-2',
    prompt,
    n: 1,
    response_format: 'b64_json',
    size,
    images: [{ b64_json: b64, mime_type: 'image/jpeg', filename: 'reference-1.jpg' }],
  }),
  signal: AbortSignal.timeout(420000),
});

const text = await r.text();
const ms = Date.now() - t0;
let j = null;
try { j = JSON.parse(text); } catch {}

console.log(`size=${size}  HTTP ${r.status}  ${(ms / 1000).toFixed(1)}s`);
if (!r.ok) {
  const detail = j?.detail?.error || j?.detail?.message || j?.error || text.slice(0, 300);
  console.log('  错误:', String(detail).slice(0, 300));
  process.exit(0);
}

const first = j?.data?.[0];
const b = first?.b64_json ? Buffer.from(first.b64_json, 'base64') : null;
if (!b) { console.log('  没有图片', text.slice(0, 200)); process.exit(0); }
const out = path.join('C:/DSH/rev/idphoto/out', `size-probe-${size}.png`);
fs.writeFileSync(out, b);
const { execFileSync } = await import('node:child_process');
const dim = execFileSync('python', ['-c', `from PIL import Image;im=Image.open(r"${out}");print(im.size)`], { encoding: 'utf8' }).trim();
console.log('  出图:', dim, ' bytes', b.length, ' ->', out);
