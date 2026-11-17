/**
 * 生成女士款预览图（选衣卡片用）
 *   node tools/make_women_previews.mjs
 *
 * 只出 2 张：women-suit / women-shirt，避免重复生成已有的 5 张。
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

const ITEMS = [
  {
    id: 'women-suit',
    prompt: `一件女式深色西装外套，收腰剪裁，版型修身，内搭白色衬衫，不系领带，${COMMON}，${BG}`,
  },
  {
    id: 'women-shirt',
    prompt: `一件女式白色衬衫，收腰剪裁，领口平整，不系领带，${COMMON}，${BG}`,
  },
];

const run = (args) => new Promise((resolve) => {
  execFile('node', args, { timeout: 420_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    resolve(String(stdout || '').trim());
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
  execFile('python', ['-c', py, src, dst], { timeout: 60_000 }, () => resolve());
});

for (const it of ITEMS) {
  const raw = path.join(TMP, `${it.id}.png`);
  const out = path.join(DEST, `${it.id}.jpg`);
  process.stdout.write(`\n[${it.id}] 生成中… `);
  const stdout = await run([CLI, it.prompt, '--size', '1024x1024', '--timeout', '420', '--out', raw]);
  let info = null;
  try { info = JSON.parse(stdout.split('\n').pop()); } catch {}
  if (!info || !info.ok) {
    console.log('失败:', stdout.slice(-300));
    continue;
  }
  await runPy(info.file || raw, out);
  const kb = fs.existsSync(out) ? Math.round(fs.statSync(out).size / 1024) : 0;
  console.log(`ok  ${path.basename(out)} ${kb}KB  剩余额度 ${info.remaining_quota}`);
}
console.log('\n完成 →', DEST);
