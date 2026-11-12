/**
 * PNG → JPEG 压缩（给公网 API 用）
 * ------------------------------------------------------------
 * 为什么需要：ngrok 免费通道实测只有 ~34 KB/s，
 * 一张 1024×1536 的 PNG 是 1.6~2.2 MB，下载要 60s；转成 q88 的 JPEG 约 200~400 KB，10s 内能拉完。
 *
 * 依赖：本机 python + Pillow（这个项目本来就跑在有 Python 的机器上）。
 * 没有 Python/Pillow 时不报错，只是不产出 jpeg。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';

const PY = process.env.PYTHON || 'python';

export function toJpeg(pngPath, { quality = 88 } = {}) {
  const out = pngPath.replace(/\.png$/i, '') + '.jpg';
  const code = [
    'import sys',
    'from PIL import Image',
    'src, dst, q = sys.argv[1], sys.argv[2], int(sys.argv[3])',
    'im = Image.open(src).convert("RGB")',
    'im.save(dst, "JPEG", quality=q, optimize=True, dpi=(300, 300))',
    'print(im.size[0], im.size[1])',
  ].join('\n');

  return new Promise((resolve) => {
    execFile(PY, ['-c', code, pngPath, out, String(quality)], { timeout: 60_000 }, (err, stdout) => {
      if (err || !fs.existsSync(out)) return resolve(null);
      const [w, h] = String(stdout).trim().split(/\s+/).map(Number);
      resolve({ path: out, name: out.split(/[\\/]/).pop(), bytes: fs.statSync(out).size, width: w || null, height: h || null });
    });
  });
}
