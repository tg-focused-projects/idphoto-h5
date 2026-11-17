/**
 * 从「纯色背景成片」派生透明人像 + alpha 蒙版
 * ------------------------------------------------------------
 * 上游 gpt-image-2 不支持透明背景，但我们的提示词强制「纯色背景、无渐变」，
 * 所以可以按背景色做抠像：取边框像素的中位数当背景色，逐像素算色差，
 * 在 [lo, hi] 区间做 alpha 渐变，再腐蚀 1px + 柔化 1px 去掉边缘残色。
 *
 * 质量预期：肩线、衣领这类硬边很干净；发丝边缘会有一点原底色残留
 *（复杂发型建议前端再叠 1px 内缩，或直接用 matte 自己抠）。
 *
 * 依赖本机 python + Pillow（跟 lib/jpeg.mjs 一样）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const PY = process.env.PYTHON || 'python';

const CODE = `
import sys
from collections import Counter
from PIL import Image, ImageFilter

src, cutout_path, matte_path, lo, hi = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5])

im = Image.open(src).convert("RGB")
w, h = im.size
px = im.load()

# 背景色：取四条边（各缩进 2%）的众数，抗压缩噪声
edges = []
step = max(1, min(w, h) // 200)
for x in range(int(w * 0.02), int(w * 0.98), step):
    edges.append(px[x, int(h * 0.02)])
    edges.append(px[x, int(h * 0.98) - 1])
for y in range(int(h * 0.02), int(h * 0.98), step):
    edges.append(px[int(w * 0.02), y])
    edges.append(px[int(w * 0.98) - 1, y])
bg = Counter(edges).most_common(1)[0][0]

# alpha：色差 -> 0..255
matte = Image.new("L", (w, h), 0)
mp = matte.load()
r0, g0, b0 = bg
span = max(1.0, hi - lo)
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        d = ((r - r0) ** 2 + (g - g0) ** 2 + (b - b0) ** 2) ** 0.5
        if d <= lo:
            a = 0
        elif d >= hi:
            a = 255
        else:
            a = int((d - lo) / span * 255)
        mp[x, y] = a

# 收 1px 去掉边缘残色，再柔化 1px 避免锯齿
matte = matte.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
matte.save(matte_path)

cut = im.convert("RGBA")
cut.putalpha(matte)
cut.save(cutout_path)

# 统计：透明像素占比，便于判断抠图是否合理
alpha = matte.load()
transparent = sum(1 for y in range(0, h, 4) for x in range(0, w, 4) if alpha[x, y] < 24)
sampled = len(range(0, h, 4)) * len(range(0, w, 4))
print("%d %d %s %.3f %d %d %d" % (w, h, "%02x%02x%02x" % bg, 1.0 - transparent / sampled, lo, hi, 0))
`;

export function makeCutout(pngPath, opts = {}) {
  const lo = Number(opts.lo ?? 22);
  const hi = Number(opts.hi ?? 60);
  const base = pngPath.replace(/\.png$/i, '');
  const cutoutPath = base + '.cutout.png';
  const mattePath = base + '.matte.png';
  return new Promise((resolve) => {
    execFile(PY, ['-c', CODE, pngPath, cutoutPath, mattePath, String(lo), String(hi)], { timeout: 120_000 }, (err, stdout) => {
      if (err || !fs.existsSync(cutoutPath)) return resolve(null);
      const parts = String(stdout).trim().split(/\s+/);
      resolve({
        cutout: { name: cutoutPath.split(/[\\/]/).pop(), bytes: fs.statSync(cutoutPath).size },
        matte: { name: mattePath.split(/[\\/]/).pop(), bytes: fs.statSync(mattePath).size },
        width: Number(parts[0]) || null,
        height: Number(parts[1]) || null,
        bg: parts[2] || null,
        subjectRatio: Number(parts[3]) || null,
      });
    });
  });
}
