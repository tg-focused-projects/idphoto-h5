/**
 * 水印预览：同一张无水印原图派生一张带水印的预览
 * ------------------------------------------------------------
 * 只消耗 1 次生图额度（原图就是那次生成的结果），水印是本地 Pillow 画的。
 * 平铺半透明文字，斜 30°，覆盖整张，裁掉也去不掉。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const PY = process.env.PYTHON || 'python';

const CODE = `
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

src, dst, text, opacity, target_w = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), int(sys.argv[5])

im = Image.open(src).convert("RGB")
if target_w and im.width > target_w:
    im = im.resize((target_w, round(im.height * target_w / im.width)), Image.LANCZOS)
w, h = im.size

# 水印层：斜向平铺文字
layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
d = ImageDraw.Draw(layer)
size = max(14, int(w * 0.038))
font = None
for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "arial.ttf"):
    try:
        font = ImageFont.truetype(name, size)
        break
    except Exception:
        continue
if font is None:
    font = ImageFont.load_default()

alpha = int(255 * max(0.05, min(0.6, opacity)))
step_x = int(size * max(6.0, len(text) * 1.15))
step_y = int(size * 4.6)
for row, y in enumerate(range(-h, h * 2, step_y)):
    offset = (row % 2) * step_x // 2
    for x in range(-w, w * 2, step_x):
        d.text((x + offset, y), text, font=font, fill=(255, 255, 255, alpha))

layer = layer.rotate(30, expand=False)
layer = layer.filter(ImageFilter.GaussianBlur(0.4))

# 白字压在所有底色上都看得见，再加一层极淡的深色描边提升可读性
shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
ds = ImageDraw.Draw(shadow)
for row, y in enumerate(range(-h, h * 2, step_y)):
    offset = (row % 2) * step_x // 2
    for x in range(-w, w * 2, step_x):
        ds.text((x + offset + 1, y + 1), text, font=font, fill=(0, 0, 0, int(alpha * 0.45)))
shadow = shadow.rotate(30, expand=False).filter(ImageFilter.GaussianBlur(0.4))

out = im.convert("RGBA")
out.alpha_composite(shadow)
out.alpha_composite(layer)
out = out.convert("RGB")
out.save(dst, "JPEG", quality=86, optimize=True, dpi=(300, 300))
print(w, h, alpha)
`;

export function makePreview(pngPath, { text = '预览', opacity = 0.10, width = 1000, sizeRatio = 0.038 } = {}) {
  const out = pngPath.replace(/\.png$/i, '') + '.preview.jpg';
  return new Promise((resolve) => {
    execFile(PY, ['-c', CODE, pngPath, out, text, String(opacity), String(width)], { timeout: 90_000 }, (err, stdout) => {
      if (err || !fs.existsSync(out)) return resolve(null);
      const [w, h] = String(stdout).trim().split(/\s+/).map(Number);
      resolve({ name: out.split(/[\\/]/).pop(), bytes: fs.statSync(out).size, width: w || null, height: h || null });
    });
  });
}
