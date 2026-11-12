/**
 * 生成 5 套正装的「服装预览图」（选衣卡片用）
 *   node tools/make_suit_previews.mjs
 *
 * 走 c2a CLI 的文生图（/v1/images/generations，无需参考图），每张扣 1 次额度。
 * 生成后由 python/Pillow 统一裁成 1:1、缩到 360px、存成 jpg（~20KB，前端卡片直接用）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CLI = 'C:\\DSH\\tools\\c2a-image.mjs';
const TMP = 'C:\\DSH\\rev\\idphoto\\out\\suits';
const DEST = path.resolve('public/img/suits');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(DEST, { recursive: true });

const BG = '浅灰色纯色背景，无渐变、无文字、无水印';
const COMMON = '服装电商产品图，正面平铺，服装居中占满画面，均匀柔光，细节清晰，无模特、无人物、无文字';

const SUITS = [
  {
    id: 'black-suit',
    prompt: `一件接近黑色的深色西装外套，内搭白色衬衫，系深蓝色领带，${COMMON}，${BG}`,
  },
  {
    id: 'navy-suit',
    prompt: `一件藏青色西装外套，内搭白色衬衫，系深色领带，${COMMON}，${BG}`,
  },
  {
    id: 'white-shirt',
    prompt: `一件挺括的白色长袖衬衫，领口平整，不系领带，${COMMON}，${BG}`,
  },
  {
    id: 'student',
    prompt: `一件浅色衬衫搭配简洁深色外套，学生装风格，不系领带，${COMMON}，${BG}`,
  },
  {
    id: 'dark-tee',
    prompt: `一件深色有领针织衫（带领 T 恤），简洁无图案，${COMMON}，${BG}`,
  },
];

const run = (args) => new Promise((resolve) => {
  execFile('node', args, { timeout: 420_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    resolve({ err, stdout: String(stdout || '').trim() });
  });
});

const py = `
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
w, h = im.size
s = min(w, h)
im = im.crop(((w - s)//2, (h - s)//2, (w + s)//2, (h + s)//2)).resize((360, 360), Image.LANCZOS)
im.save(dst, "JPEG", quality=88, optimize=True)
print(im.size)
`;

const runPy = (src, dst) => new Promise((resolve) => {
  execFile('python', ['-c', py, src, dst], { timeout: 60_000 }, (err, stdout) => resolve({ err, out: String(stdout || '').trim() }));
});

for (const s of SUITS) {
  const raw = path.join(TMP, `${s.id}.png`);
  const out = path.join(DEST, `${s.id}.jpg`);
  process.stdout.write(`\n[${s.id}] 生成中… `);
  const r = await run([CLI, s.prompt, '--size', '1024x1024', '--timeout', '420', '--out', raw]);
  let info = null;
  try { info = JSON.parse(r.stdout.split('\n').pop()); } catch {}
  if (!info || !info.ok) {
    console.log('失败:', r.stdout.slice(-300) || String(r.err));
    continue;
  }
  const conv = await runPy(info.file || raw, out);
  const kb = fs.existsSync(out) ? Math.round(fs.statSync(out).size / 1024) : 0;
  console.log(`ok  ${Math.round(info.bytes / 1024)}KB → ${path.basename(out)} ${kb}KB  ${(info.elapsed_ms / 1000).toFixed(0)}s  剩余额度 ${info.remaining_quota}`);
}
console.log('\n完成 →', DEST);
