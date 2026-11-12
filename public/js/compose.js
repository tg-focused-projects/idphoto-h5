/**
 * 成品处理：构图裁剪 → 尺寸像素 → JPEG(300dpi) → 冲印排版
 * 构图规则沿用证件照通行标准（也是原小程序 make_idphoto 的做法）：
 *   头高 ≈ 62% 画面高，头顶留白 ≈ 9%，人脸水平居中。
 */

export function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/** 上传前压一版：长边 1280，JPEG 0.92（单张 300~600KB，够模型用，省往返时间） */
export function downscaleForUpload(img, maxSide = 1280) {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}

/**
 * 找头和脸：以左上角像素为背景色，主体 = 与背景色距离 > 60 的像素
 * 返回全分辨率坐标 { hairTop, chin, cx, headH }
 */
export function analyzeFraming(img, { threshold = 60 } = {}) {
  const W = 240;
  const H = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * W));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;

  const bg = [d[0], d[1], d[2]];
  const rowCount = new Uint16Array(H);
  const mask = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const dr = d[i] - bg[0], dg = d[i + 1] - bg[1], db = d[i + 2] - bg[2];
      if (dr * dr + dg * dg + db * db > threshold * threshold) {
        mask[y * W + x] = 1;
        rowCount[y]++;
      }
    }
  }

  const minCount = Math.max(3, Math.round(W * 0.04));
  let hairTop = 0;
  for (let y = 0; y < H; y++) {
    if (rowCount[y] > minCount) { hairTop = y; break; }
  }

  // 眼鼻一行人脸水平中心
  const y0 = Math.min(H - 1, hairTop + Math.round(H * 0.32));
  const y1 = Math.min(H, hairTop + Math.round(H * 0.45));
  const colCount = new Uint16Array(W);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) if (mask[y * W + x]) colCount[x]++;
  }
  const bandH = Math.max(1, y1 - y0);
  let minX = -1, maxX = -1;
  for (let x = 0; x < W; x++) {
    if (colCount[x] > Math.max(2, bandH * 0.15)) { if (minX < 0) minX = x; maxX = x; }
  }
  const cxSmall = minX >= 0 ? (minX + maxX) / 2 : W / 2;

  const k = img.naturalWidth / W;
  const hairTopF = hairTop * k;
  const chinF = (hairTop + 0.55 * H) * k;
  return { hairTop: hairTopF, chin: chinF, cx: cxSmall * k, headH: chinF - hairTopF };
}

/**
 * 按规格裁一张（返回 canvas，尺寸就是规格像素）
 * @param {HTMLImageElement} img  原图或 AI 结果
 * @param {[number,number]} specPx [W,H]
 */
export function cropToSpec(img, specPx, { useFace = true } = {}) {
  const [outW, outH] = specPx;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  let box;

  if (useFace) {
    const { hairTop, headH, cx } = analyzeFraming(img);
    let cropH = headH / 0.62;
    let cropW = cropH * (outW / outH);
    if (cropH > ih) { cropH = ih; cropW = cropH * (outW / outH); }
    if (cropW > iw) { cropW = iw; cropH = cropW * (outH / outW); }
    let top = hairTop - 0.09 * cropH;
    let left = cx - cropW / 2;
    top = Math.max(0, Math.min(ih - cropH, top));
    left = Math.max(0, Math.min(iw - cropW, left));
    box = [left, top, cropW, cropH];
  } else {
    // 直接居中裁
    const targetRatio = outW / outH;
    let cropW = iw, cropH = iw / targetRatio;
    if (cropH > ih) { cropH = ih; cropW = ih * targetRatio; }
    box = [(iw - cropW) / 2, (ih - cropH) * 0.42, cropW, cropH];
  }

  const c = document.createElement('canvas');
  c.width = outW; c.height = outH;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, box[0], box[1], box[2], box[3], 0, 0, outW, outH);
  return c;
}

/** JPEG 里写 300dpi（浏览器 canvas 不写 DPI，报名系统会按 72dpi 算尺寸） */
export function patchJpegDpi(buf, dpi = 300) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return buf;
  let p = 2;
  while (p + 4 < u8.length) {
    if (u8[p] !== 0xff) { p++; continue; }
    const marker = u8[p + 1];
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (marker === 0xe0) {
      // APP0 JFIF: 4=len 6..10='JFIF\0' 11-12 ver 13 units 14-15 X 16-17 Y
      if (String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]) === 'JFIF') {
        u8[p + 11] = 1;                       // units = dots per inch
        u8[p + 12] = (dpi >> 8) & 0xff; u8[p + 13] = dpi & 0xff;
        u8[p + 14] = (dpi >> 8) & 0xff; u8[p + 15] = dpi & 0xff;
      }
      return u8.buffer;
    }
    if (marker === 0xda) break;               // 到了扫描数据，不再找
    p += 2 + len;
  }
  return buf;
}

export function canvasToJpeg(canvas, { dpi = 300, quality = 0.95 } = {}) {
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      const buf = await blob.arrayBuffer();
      const patched = patchJpegDpi(buf, dpi);
      resolve(new Blob([patched], { type: 'image/jpeg' }));
    }, 'image/jpeg', quality);
  });
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 冲印排版：6 寸相纸（152×102mm @300dpi ≈ 1800×1200）
 * 用 1 寸照片铺 4×2，带裁切参考线
 */
export function buildSheet(img, specPx, { paper = [1800, 1200], cols = 5, rows = 3 } = {}) {
  const [pw, ph] = paper;
  const [sw, sh] = specPx;
  const c = document.createElement('canvas');
  c.width = pw; c.height = ph;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, pw, ph);

  const gap = 12;
  const padX = (pw - cols * sw - (cols - 1) * gap) / 2;
  const padY = (ph - rows * sh - (rows - 1) * gap) / 2;

  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = Math.round(padX + col * (sw + gap));
      const y = Math.round(padY + r * (sh + gap));
      ctx.drawImage(img, x, y, sw, sh);
      ctx.strokeStyle = 'rgba(0,0,0,.14)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 0.5, y - 0.5, sw + 1, sh + 1);
    }
  }
  return c;
}
