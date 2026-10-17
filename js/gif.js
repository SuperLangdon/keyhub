// 零依赖 GIF87a/89a 解码器 —— 供屏幕页「导入 GIF」逐帧解包。
// 覆盖：LZW 解压、局部/全局色表、隔行还原、透明色索引、帧间 disposal 合成（0/1 保留、2 清背景、3 回退前帧）。
// parseGif 为纯逻辑（无 DOM，输出每帧 RGBA 缓冲，node:test 可回归）；
// decodeGif 包装成逐帧 canvas 供页面直接 drawImage。
// 帧延时换算自 1/100s 单位；<=10ms 按浏览器惯例取 100ms。损坏流抛错由调用方提示。

// ---------- LZW（LSB-first 位流，字典按 GIF 规则增量生长，4096 封顶） ----------
function lzwDecode(minCodeSize, data, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict = [];
  let next = eoi + 1;
  const resetDict = () => {
    dict = new Array(clear);
    for (let i = 0; i < clear; i++) dict[i] = [i];
    codeSize = minCodeSize + 1;
    next = eoi + 1;
  };
  resetDict();

  let bitPos = 0;
  const readCode = () => {
    if ((bitPos >> 3) >= data.length) return eoi; // 流截断：按提前结束处理
    let v = 0;
    for (let i = 0; i < codeSize; i++) {
      const b = (bitPos + i) >> 3;
      v |= ((data[b] >> ((bitPos + i) & 7)) & 1) << i;
    }
    bitPos += codeSize;
    return v;
  };

  let op = 0;
  let prev = null;
  for (;;) {
    const code = readCode();
    if (code === eoi) break;
    if (code === clear) { resetDict(); prev = null; continue; }
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) entry = prev.concat([prev[0]]); // KwKwK
    else throw new Error('GIF LZW 码流损坏');
    for (let i = 0; i < entry.length && op < pixelCount; i++) out[op++] = entry[i];
    if (prev && next < 4096) dict[next++] = prev.concat([entry[0]]);
    if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    prev = entry;
    if (op >= pixelCount) break;
  }
  return out;
}

// ---------- 子块串读取（len 字节 + 终止 0） ----------
function readSubBlocks(d, p) {
  const chunks = [];
  let len = 0;
  while (p < d.length && d[p] !== 0) {
    const n = d[p];
    chunks.push(d.subarray(p + 1, Math.min(p + 1 + n, d.length)));
    len += Math.min(n, d.length - p - 1);
    p += 1 + n;
  }
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { data: out, next: p + 1 };
}

function readColorTable(d, p, packed) {
  const n = 3 * (1 << ((packed & 7) + 1));
  return { table: d.subarray(p, Math.min(p + n, d.length)), next: p + n };
}

// 隔行存储 → 顺序行号
function deinterlace(indices, w, h) {
  const out = new Uint8Array(indices.length);
  const starts = [0, 4, 2, 1], steps = [8, 8, 4, 2];
  let src = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let y = starts[pass]; y < h; y += steps[pass]) {
      out.set(indices.subarray(src, src + w), y * w);
      src += w;
    }
  }
  return out;
}

// ---------- 纯解析：返回逐帧 RGBA 缓冲（无 DOM 依赖） ----------
export function parseGif(buffer) {
  const d = new Uint8Array(buffer);
  if (d.length < 13 || d[0] !== 0x47 || d[1] !== 0x49 || d[2] !== 0x46) throw new Error('不是有效的 GIF 文件');
  const rd16 = (o) => d[o] | (d[o + 1] << 8);
  const w = rd16(6), h = rd16(8);
  if (!w || !h || w > 4096 || h > 4096) throw new Error('GIF 尺寸异常');
  const total = w * h;

  let p = 13;
  let gct = null;
  if (d[10] & 0x80) { const t = readColorTable(d, p, d[10]); gct = t.table; p = t.next; }

  const frames = [];
  let gce = null;      // 当前 Graphic Control Extension
  // 帧合成缓冲（RGBA，初始全透明）与 disposal-3 回退快照
  let full = new Uint8ClampedArray(total * 4);
  let prevSnapshot = null;

  while (p < d.length) {
    const block = d[p++];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) { // extension
      const label = d[p++];
      if (label === 0xf9 && d[p] === 4) { // graphic control
        const packed = d[p + 1];
        gce = {
          transparent: (packed & 1) ? d[p + 4] : -1,
          disposal: (packed >> 2) & 7,
          delay: rd16(p + 2) * 10, // 1/100s → ms
        };
      }
      while (p < d.length && d[p] !== 0) p += d[p] + 1; // 逐子块跳过
      p++;
    } else if (block === 0x2c) { // image descriptor
      const left = rd16(p), top = rd16(p + 2), iw = rd16(p + 4), ih = rd16(p + 6);
      const packed = d[p + 8];
      p += 9;
      let table = gct;
      if (packed & 0x80) { const t = readColorTable(d, p, packed); table = t.table; p = t.next; }
      const minCodeSize = d[p++];
      const { data, next } = readSubBlocks(d, p);
      p = next;
      if (!table) throw new Error('GIF 缺少色表');

      let indices = lzwDecode(minCodeSize, data, iw * ih);
      if (packed & 0x40) indices = deinterlace(indices, iw, ih);

      // disposal 3 需要回退到本帧绘制前的画面
      if (gce?.disposal === 3) prevSnapshot = full.slice();

      const isTransparent = (i) => gce && i === gce.transparent;
      for (let y = 0; y < ih; y++) {
        const fy = top + y;
        if (fy >= h) break;
        for (let x = 0; x < iw; x++) {
          const fx = left + x;
          if (fx >= w) break;
          const idx = indices[y * iw + x];
          if (isTransparent(idx)) continue;
          const o = (fy * w + fx) * 4;
          full[o] = table[idx * 3];
          full[o + 1] = table[idx * 3 + 1];
          full[o + 2] = table[idx * 3 + 2];
          full[o + 3] = 255;
        }
      }

      frames.push({
        data: new Uint8ClampedArray(full),
        delay: !gce?.delay || gce.delay <= 10 ? 100 : gce.delay,
      });

      // disposal：2 = 清除本帧矩形为透明；3 = 回退到绘制前
      if (gce?.disposal === 2) {
        for (let y = top; y < Math.min(top + ih, h); y++)
          full.fill(0, (y * w + left) * 4, (y * w + Math.min(left + iw, w)) * 4);
      } else if (gce?.disposal === 3 && prevSnapshot) {
        full = prevSnapshot;
        prevSnapshot = null;
      }
      gce = null; // GCE 只作用于紧随的一帧
    } else {
      break; // 未知块：停止解析，保留已解出的帧
    }
  }
  if (!frames.length) throw new Error('GIF 中没有图像帧');
  return { width: w, height: h, frames };
}

// ---------- DOM 包装：每帧转 canvas（页面用） ----------
export function decodeGif(buffer) {
  const r = parseGif(buffer);
  const frames = r.frames.map((f) => {
    const cv = document.createElement('canvas');
    cv.width = r.width; cv.height = r.height;
    cv.getContext('2d').putImageData(new ImageData(f.data, r.width, r.height), 0, 0);
    return { canvas: cv, delay: f.delay };
  });
  return { width: r.width, height: r.height, frames };
}
