// KeyHub 品牌资产生成器（零依赖）
// 用法: node tools/gen-brand.mjs [--preview]   （--preview 只输出预览大图供目检; --crops 输出字形/像素检查图）
//
// 设计: 「键帽 Hub」—— 名字本身就是标志:
//   横标 logo-wide = Key(墨字) + Hub(藏在橙色键帽里的墨字), 键帽 = 我们驱动的对象;
//   方标 mark      = 墨色圆角方 tile, 上行 Key、下行橙色键帽 Hub(参考 app icon),
//                    自带底色, 浅底深底通用; 侧栏内联版(mark-inline)用 CSS 变量随主题换 tile/字色。
//   小尺寸(favicon ≤32px) 简化为「橙色键帽 + 粗体 H」剪影, 保证标签页可辨认。
// 颜色全部取自 css/app.css 令牌; 字形为手工构建的等线几何体(圆头笔画), 不依赖任何字体。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'brand');
const PREVIEW_ONLY = process.argv.includes('--preview');
const CROPS = process.argv.includes('--crops');

// ---------- 调色板（与 css/app.css :root 令牌一致） ----------
const C = {
  canvas: '#f7f7f4',     // 奶油画布(日间)
  ink: '#26251e',        // 墨色(日间文字)
  inkDark: '#e9e7de',    // 墨色(夜间文字, 亮)
  dark: '#1c1b18',       // 暖黑: 夜间画布 / 方标 tile / 键帽上的 Hub 字
  orange: '#f54e00',     // Cursor 橙(日间)
  orangeDark: '#ff5c14', // Cursor 橙(夜间)
};
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
const mix = (h1, h2, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(h1.slice(i, i + 2), 16) * (1 - t) + parseInt(h2.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');

// ---------- 几何原语 ----------
// 角度约定: a 为度, 0°=正上, 顺时针为正; 点 = (cx + r·sin a, cy − r·cos a)
const line = (x1, y1, x2, y2) => ({ t: 'l', x1, y1, x2, y2 });
const arc = (cx, cy, r, a0, a1) => ({ t: 'a', cx, cy, r, a0, a1 }); // a1 > a0, 顺时针
const rrect = (x, y, w, h, rr) => ({ t: 'rr', x, y, w, h, rr });
const pt = (a, cx, cy, r) => { const t = (a * Math.PI) / 180; return [cx + r * Math.sin(t), cy - r * Math.cos(t)]; };

// ---------- 字形（x-height=100, 基线 y=100, 大写顶 y=-32, y 下降部底 133; 圆头笔画） ----------
// 所有点/圆心/半径由笔宽 sw 推导: 端点圆头帽沿精确落在 0/100 字形框上, 任何字重都不出头。
// ink: 墨迹左右边界(光学排字用)。
function glyphsAt(sw) {
  const h = sw / 2;
  const R = 50 - h;        // 圆形字母路径半径(外缘恰为 0..100)
  const capT = -32 + h;    // 大写顶边的路径 y
  const base = 100 - h;    // 基线的路径 y
  return {
    // K: 竖干 + 在干上汇合的臂/腿(Futura 式)
    K: { ink: [0, 100], strokes: [
      line(h, capT, h, base),
      line(h, 36, 100 - h, capT),
      line(h, 36, 100 - h, base),
    ] },
    // e: 横杆两端埋进圆带里 + 开口环(118°→450°)
    e: { ink: [0, 100], strokes: [line(2 * h, 50, 100 - 2 * h, 50), arc(50, 50, R, 118, 450)] },
    // y: 左短臂落在基线; 右笔从右上直插下降部, 恰好经过左臂端点(共点交接)
    y: { ink: [0, 100], strokes: [
      line(h, h, 50, base),
      line(100 - h, h, 100 - h - (50 - h) * ((133 - 2 * h) / (100 - 2 * h)), 133 - h),
    ] },
    // H: 双干 + 帽高中线横杆
    H: { ink: [0, 100], strokes: [
      line(h, capT, h, base),
      line(100 - h, capT, 100 - h, base),
      line(h, 34, 100 - h, 34),
    ] },
    // u: 左短干 + 底部半圆碗 + 右干升到 x-height 顶
    // (角度约定 0°=正上: 90°=右, 180°=下, 270°=左 → 90→270 顺时针经过正下方)
    u: { ink: [0, 100], strokes: [
      line(h, h, h, 50),
      arc(50, 50, 50 - h, 90, 270),
      line(100 - h, 50, 100 - h, h),
    ] },
    // b: 长干(升部=大写高) + 全圆碗
    b: { ink: [0, 100], strokes: [line(h, capT, h, base), arc(50, 50, R, 0, 360)] },
  };
}

// 排字: 字距 = 墨迹边到边间隙
const PAIR_GAP = { 'K-e': 24, 'e-y': 22, 'H-u': 24, 'u-b': 24 };
function layout(word, sw = SW) {
  const G = glyphsAt(sw), out = [];
  let cursor = 0; // 当前字母墨迹左边界应处的位置
  for (let i = 0; i < word.length; i++) {
    const ch = word[i], g = G[ch];
    out.push({ ch, x: cursor - g.ink[0], strokes: g.strokes });
    if (i < word.length - 1) cursor += (g.ink[1] - g.ink[0]) + (PAIR_GAP[`${ch}-${word[i + 1]}`] ?? 24);
  }
  const last = G[word[word.length - 1]];
  return { glyphs: out, width: cursor + last.ink[1] - last.ink[0] };
}

// ---------- SVG 输出 ----------
const SW = 21; // 字标默认笔画宽(参考图为粗壮几何体)
const fmt = (n) => Math.round(n * 100) / 100;
function primToD(p, dx = 0) {
  if (p.t === 'l') return `M ${fmt(p.x1 + dx)} ${fmt(p.y1)} L ${fmt(p.x2 + dx)} ${fmt(p.y2)}`;
  if (p.t === 'a') {
    // SVG 弧命令起终点重合时整圆退化为零长度, 360° 必须拆成两个半圆
    if (p.a1 - p.a0 >= 360) {
      const mid = p.a0 + (p.a1 - p.a0) / 2;
      const half = (a, b) => {
        const [xb, yb] = pt(b, p.cx + dx, p.cy, p.r);
        return `A ${fmt(p.r)} ${fmt(p.r)} 0 0 1 ${fmt(xb)} ${fmt(yb)}`;
      };
      const [x0, y0] = pt(p.a0, p.cx + dx, p.cy, p.r);
      return `M ${fmt(x0)} ${fmt(y0)} ${half(p.a0, mid)} ${half(mid, p.a1)}`;
    }
    const [x0, y0] = pt(p.a0, p.cx + dx, p.cy, p.r), [x1, y1] = pt(p.a1, p.cx + dx, p.cy, p.r);
    const large = p.a1 - p.a0 > 180 ? 1 : 0;
    return `M ${fmt(x0)} ${fmt(y0)} A ${fmt(p.r)} ${fmt(p.r)} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)}`;
  }
  return ''; // rrect 单独输出
}
const svgDoc = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;

// 单词 → SVG(圆头描边路径); (x0,y0) = 字形坐标系原点(墨迹左缘, x-height 顶)的落点, k 为缩放
function textSvg(word, x0, y0, k, sw, color) {
  return layout(word, sw).glyphs.map((g) =>
    `<path d="${g.strokes.map((s) => primToD(s)).join(' ')}" transform="translate(${fmt(x0 + g.x * k)} ${fmt(y0)}) scale(${k})" fill="none" stroke="${color}" stroke-width="${fmt(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join('');
}
const rectSvg = (x, y, w, h, rr, fill) =>
  `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(rr)}" fill="${fill}"/>`;

// ---------- 光栅化（SDF + 2x2 超采样, 仅遍历包围盒） ----------
function sdSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}
function sdRR(px, py, s) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  const qx = Math.abs(px - cx) - (s.w / 2 - s.rr), qy = Math.abs(py - cy) - (s.h / 2 - s.rr);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.rr;
}
// 把原语拍平成线段(弧线按 3° 一段)
function flatten(p) {
  if (p.t === 'l') return [[p.x1, p.y1, p.x2, p.y2]];
  if (p.t === 'a') {
    const segs = Math.max(2, Math.ceil((p.a1 - p.a0) / 3));
    const out = [];
    for (let i = 0; i < segs; i++) {
      const A = pt(p.a0 + ((p.a1 - p.a0) * i) / segs, p.cx, p.cy, p.r);
      const B = pt(p.a0 + ((p.a1 - p.a0) * (i + 1)) / segs, p.cx, p.cy, p.r);
      out.push([A[0], A[1], B[0], B[1]]);
    }
    return out;
  }
  return [];
}
// 图层: { color:[r,g,b,a], shapes:[{p:原语|rrect, mode:'fill'|'stroke', w}] }
function rasterize(W, H, layers) {
  const img = Buffer.alloc(W * H * 4);
  for (const layer of layers) {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    const shapes = layer.shapes.map((sh) => {
      const segs = sh.p.t === 'rr' ? null : flatten(sh.p);
      const pad = (sh.mode === 'fill' ? 0 : sh.w / 2) + 2;
      if (sh.p.t === 'rr') {
        minX = Math.min(minX, sh.p.x - pad); minY = Math.min(minY, sh.p.y - pad);
        maxX = Math.max(maxX, sh.p.x + sh.p.w + pad); maxY = Math.max(maxY, sh.p.y + sh.p.h + pad);
      } else for (const s of segs) {
        // 描边要按 w/2 外扩(含圆头帽沿), 否则图层边缘的笔画会被裁掉半边
        const pw = (sh.mode === 'stroke' ? sh.w / 2 : 0) + 2;
        minX = Math.min(minX, s[0] - pw, s[2] - pw); minY = Math.min(minY, s[1] - pw, s[3] - pw);
        maxX = Math.max(maxX, s[0] + pw, s[2] + pw); maxY = Math.max(maxY, s[1] + pw, s[3] + pw);
      }
      return { p: sh.p, segs, mode: sh.mode, w: sh.w };
    });
    minX = Math.max(0, Math.floor(minX)); minY = Math.max(0, Math.floor(minY));
    maxX = Math.min(W - 1, Math.ceil(maxX)); maxY = Math.min(H - 1, Math.ceil(maxY));
    if (maxX < minX || maxY < minY) continue;
    const [cr, cg, cb, ca] = layer.color;
    const subs = [-0.25, 0.25];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      let alpha = 0;
      for (const oy of subs) for (const ox of subs) {
        const px = x + ox, py = y + oy;
        let d = 1e9;
        for (const sh of shapes) {
          if (sh.p.t === 'rr') {
            const sd = sdRR(px, py, sh.p);
            d = Math.min(d, sh.mode === 'fill' ? sd : Math.abs(sd) - sh.w / 2);
          } else for (const s of sh.segs) d = Math.min(d, sdSeg(px, py, s[0], s[1], s[2], s[3]) - sh.w / 2);
        }
        alpha += Math.min(Math.max(0.5 - d, 0), 1) / 4;
      }
      if (alpha <= 0) continue;
      const i = (y * W + x) * 4;
      const a = (alpha * ca) / 255;
      img[i] = Math.round(img[i] * (1 - a) + cr * a);
      img[i + 1] = Math.round(img[i + 1] * (1 - a) + cg * a);
      img[i + 2] = Math.round(img[i + 2] * (1 - a) + cb * a);
      img[i + 3] = Math.round(img[i + 3] * (1 - a) + 255 * a);
    }
  }
  return img;
}

// ---------- PNG / ICO 编码 ----------
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(W, H, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// ICO: 小尺寸用 BMP DIB(32bpp + 全零 AND 掩码), 256 用内嵌 PNG
function icoBMPEntry(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const buf = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  buf.writeUInt32LE(40, 0); buf.writeInt32LE(size, 4); buf.writeInt32LE(size * 2, 8);
  buf.writeUInt16LE(1, 12); buf.writeUInt16LE(32, 14);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // 自底向上
    for (let x = 0; x < size; x++) {
      const i = 40 + (y * size + x) * 4, j = src + x * 4;
      buf[i] = rgba[j + 2]; buf[i + 1] = rgba[j + 1]; buf[i + 2] = rgba[j]; buf[i + 3] = rgba[j + 3];
    }
  }
  return buf;
}
function encodeICO(entries) { // [{size, data(Buffer BMP|PNG), png:boolean}]
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let off = 6 + dir.length;
  entries.forEach((e, i) => {
    dir[i * 16] = e.size >= 256 ? 0 : e.size;
    dir[i * 16 + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, i * 16 + 4); dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(e.data.length, i * 16 + 8); dir.writeUInt32LE(off, i * 16 + 12);
    off += e.data.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.data)]);
}

// ---------- 图层整体缩放平移(设计空间 -> 像素空间) ----------
const scaleLayers = (layers, k, dx = 0, dy = 0) => layers.map((l) => ({
  color: l.color,
  shapes: l.shapes.map((sh) => {
    const p = sh.p;
    const q = p.t === 'rr' ? rrect(dx + p.x * k, dy + p.y * k, p.w * k, p.h * k, p.rr * k)
      : p.t === 'l' ? line(dx + p.x1 * k, dy + p.y1 * k, dx + p.x2 * k, dy + p.y2 * k)
        : arc(dx + p.cx * k, dy + p.cy * k, p.r * k, p.a0, p.a1);
    return { p: q, mode: sh.mode, w: sh.w * k };
  }),
}));

// ---------- 光栅用文字图层 ----------
function textLayers(word, { ox, oy, k, sw, color }) {
  const shapes = [];
  for (const g of layout(word, sw).glyphs) for (const s of g.strokes) {
    const m = s.t === 'l'
      ? line(ox + (g.x + s.x1) * k, oy + s.y1 * k, ox + (g.x + s.x2) * k, oy + s.y2 * k)
      : arc(ox + (g.x + s.cx) * k, oy + s.cy * k, s.r * k, s.a0, s.a1);
    shapes.push({ p: m, mode: 'stroke', w: sw * k });
  }
  return { layers: [{ color: rgb(color), shapes }], width: layout(word, sw).width * k };
}

// ---------- 横标 logo-wide（Key + 键帽 Hub） ----------
// 键帽内衬/圆角(字形单位): 上下内衬把大写高 132 裹成 ~202 高的键帽
const PAD_X = 36, PAD_T = 36, PAD_B = 34, CAP_RX = 40;
const GAP_KC = 50; // Key 墨迹右缘到键帽左缘(= 内衬 36 + 可见间隙 14)
const WIDE = (() => {
  const key = layout('Key'), hub = layout('Hub');
  const hubX = key.width + GAP_KC;
  return {
    key, hub, hubX,
    capX: hubX - PAD_X, capW: hub.width + 2 * PAD_X,
    top: -32 - PAD_T, bottom: 100 + PAD_B,
    width: hubX - PAD_X + hub.width + 2 * PAD_X,
  };
})();
const WIDE_H = WIDE.bottom - WIDE.top;
// (ox,oy) = K 墨迹左缘 / x-height 顶 的像素落点
function wideLayers({ ox, oy, k, key, cap, hub, sw = SW }) {
  const layers = [
    ...textLayers('Key', { ox, oy, k, sw, color: key }).layers,
    { color: rgb(cap), shapes: [{ p: rrect(ox + WIDE.capX * k, oy + WIDE.top * k, WIDE.capW * k, WIDE_H * k, CAP_RX * k), mode: 'fill' }] },
    ...textLayers('Hub', { ox: ox + WIDE.hubX * k, oy, k, sw, color: hub }).layers,
  ];
  return { layers, width: WIDE.width * k, height: WIDE_H * k };
}

// ---------- 方标 mark（128 设计空间: 墨 tile + Key / 键帽 Hub 竖排） ----------
const MK = (() => {
  const k1 = 0.227, k2 = 0.197, sw = SW;    // Key / Hub 的字形缩放(字重与横标一致)
  const m1 = 25, gap = 13, padY2 = 9, padX2 = 10, rx2 = 11;
  const capH1 = 132 * k1;                    // Key 大写高的像素值
  const keyW = layout('Key', sw).width * k1, hubW = layout('Hub', sw).width * k2;
  const capW = hubW + 2 * padX2, capY = m1 + capH1 + gap;
  return {
    sw, k1, k2,
    keyX: (128 - keyW) / 2, keyY0: m1 + 32 * k1,          // Key 字形原点
    capX: (128 - capW) / 2, capY, capW, capH: 132 * k2 + 2 * padY2, rx: rx2,
    hubX: (128 - hubW) / 2, hubY0: capY + padY2 + 32 * k2, // Hub 字形原点
  };
})();
function markLayers({ tile = C.dark, key = C.canvas, cap = C.orange, hub = C.dark } = {}) {
  return [
    { color: rgb(tile), shapes: [{ p: rrect(0, 0, 128, 128, 28), mode: 'fill' }] },
    ...textLayers('Key', { ox: MK.keyX, oy: MK.keyY0, k: MK.k1, sw: MK.sw, color: key }).layers,
    { color: rgb(cap), shapes: [{ p: rrect(MK.capX, MK.capY, MK.capW, MK.capH, MK.rx), mode: 'fill' }] },
    ...textLayers('Hub', { ox: MK.hubX, oy: MK.hubY0, k: MK.k2, sw: MK.sw, color: hub }).layers,
  ];
}
const renderMark = (size, opts = {}) => rasterize(size, size, scaleLayers(markLayers(opts), size / 128));

// ---------- 小尺寸简化（橙键帽 + 粗体 H, favicon ≤32px 用） ----------
const FAV = (() => {
  const k = 0.45, sw = 30, inset = 4, rx = 30;
  return { k, sw, inset, rx, x0: (128 - 100 * k) / 2, y0: (128 - 132 * k) / 2 + 32 * k };
})();
function favLayers({ cap = C.orange, glyph = C.dark } = {}) {
  const i = FAV.inset;
  return [
    { color: rgb(cap), shapes: [{ p: rrect(i, i, 128 - 2 * i, 128 - 2 * i, FAV.rx), mode: 'fill' }] },
    ...textLayers('H', { ox: FAV.x0, oy: FAV.y0, k: FAV.k, sw: FAV.sw, color: glyph }).layers,
  ];
}

// ---------- SVG 资产 ----------
function wideSvg(key, cap, hub) {
  const pad = 2;
  const W = Math.ceil(WIDE.width) + pad * 2, H = Math.ceil(WIDE_H) + pad * 2;
  const y0 = pad - WIDE.top; // 字形 y=-68(键帽顶) 落到 pad
  return svgDoc(W, H,
    textSvg('Key', pad, y0, 1, SW, key) +
    rectSvg(pad + WIDE.capX, pad, WIDE.capW, WIDE_H, CAP_RX, cap) +
    textSvg('Hub', pad + WIDE.hubX, y0, 1, SW, hub));
}
function markSvg(v) { // {tile,key,cap,hub}
  return svgDoc(128, 128,
    rectSvg(0, 0, 128, 128, 28, v.tile) +
    textSvg('Key', MK.keyX, MK.keyY0, MK.k1, MK.sw, v.key) +
    rectSvg(MK.capX, MK.capY, MK.capW, MK.capH, MK.rx, v.cap) +
    textSvg('Hub', MK.hubX, MK.hubY0, MK.k2, MK.sw, v.hub));
}
function favSvg(cap = C.orange, glyph = C.dark) {
  const i = FAV.inset;
  return svgDoc(128, 128,
    rectSvg(i, i, 128 - 2 * i, 128 - 2 * i, FAV.rx, cap) +
    textSvg('H', FAV.x0, FAV.y0, FAV.k, FAV.sw, glyph));
}
function svgFiles() {
  return {
    // 方标(自带墨色 tile, 浅深底通用)
    'mark.svg': markSvg({ tile: C.dark, key: C.canvas, cap: C.orange, hub: C.dark }),
    // 侧栏内联版: tile/Key/键帽 颜色走 CSS 变量, 随日/夜主题切换(粘贴进 HTML 用)
    'mark-inline.svg': markSvg({
      tile: 'var(--mark-tile,#26251e)', key: 'var(--mark-key,#f7f7f4)',
      cap: 'var(--primary,#f54e00)', hub: C.dark,
    }),
    // 横标(透明底): 浅底用墨字, 深底用亮字
    'logo-wide.svg': wideSvg(C.ink, C.orange, C.dark),
    'logo-wide-dark.svg': wideSvg(C.inkDark, C.orangeDark, C.dark),
    // favicon.svg(站点根): 小尺寸简化版
    'favicon.svg': favSvg(),
  };
}

// ---------- 位图资产 ----------
function pngAssets() {
  const files = {};
  // favicon.ico: 16/24/32 橙键帽+H; 48/256 完整方标
  const icoEntries = [16, 24, 32].map((s) => ({
    size: s, data: icoBMPEntry(s, rasterize(s, s, scaleLayers(favLayers(), s / 128))),
  }));
  icoEntries.push({ size: 48, data: icoBMPEntry(48, renderMark(48)) });
  icoEntries.push({ size: 256, data: encodePNG(256, 256, renderMark(256)), png: true });
  files['favicon.ico'] = encodeICO(icoEntries);

  // apple-touch-icon 180 / PWA 192·512: 完整方标(自带 tile, 满幅)
  files['apple-touch-icon.png'] = encodePNG(180, 180, renderMark(180));
  for (const S of [192, 512]) files[`icon-${S}.png`] = encodePNG(S, S, renderMark(S));

  // og 图 1200x630: 暖黑底居中横标(夜间色) + 底部一排小键帽点缀
  {
    const W = 1200, H = 630, k = 0.95;
    const layers = [{ color: rgb(C.dark), shapes: [{ p: rrect(0, 0, W, H, 0), mode: 'fill' }] }];
    // 字形 y=0 是原点, 键帽顶在 -68·k: 要让整标光学居中, oy = 目标中心 - 标高/2 - WIDE.top·k
    const lw = WIDE.width * k, x0 = (W - lw) / 2, y0 = H / 2 - 10 - (WIDE_H * k) / 2 - WIDE.top * k;
    layers.push(...wideLayers({ ox: x0, oy: y0, k, key: C.inkDark, cap: C.orangeDark, hub: C.dark }).layers);
    const rowY = H - 76, ks = 18, gap = 12, rowW = 5 * ks + 4 * gap;
    const soft = mix(C.inkDark, C.dark, 0.72);
    for (let i = 0; i < 5; i++) {
      layers.push({ color: rgb(i === 2 ? C.orangeDark : soft), shapes: [{ p: rrect((W - rowW) / 2 + i * (ks + gap), rowY, ks, ks, ks * 0.26), mode: 'stroke', w: 2 }] });
    }
    files['og.png'] = encodePNG(W, H, rasterize(W, H, layers));
  }
  return files;
}

// ---------- 预览大图(目检用) ----------
function preview() {
  const W = 1240, H = 1140;
  const layers = [{ color: rgb('#eeede7'), shapes: [{ p: rrect(0, 0, W, H, 0), mode: 'fill' }] }];
  const chip = (x, y, w, h, color) => layers.push({ color: rgb(color), shapes: [{ p: rrect(x, y, w, h, 0), mode: 'fill' }] });
  const place = (sceneLayers, x, y) => {
    for (const l of sceneLayers) for (const sh of l.shapes) {
      const m = (p) => p.t === 'rr' ? rrect(x + p.x, y + p.y, p.w, p.h, p.rr)
        : p.t === 'l' ? line(x + p.x1, y + p.y1, x + p.x2, y + p.y2)
          : arc(x + p.cx, y + p.cy, p.r, p.a0, p.a1);
      layers.push({ color: l.color, shapes: [{ p: m(sh.p), mode: sh.mode, w: sh.w }] });
    }
  };
  // 横标放置: wideLayers 以字形 y=0 为原点(键帽顶在 -68·k), targetY = 标的预期顶边
  const placeWide = (opts, x, targetY) => {
    const w = wideLayers(opts);
    place(wideLayers({ ...opts, oy: targetY - WIDE.top * opts.k }).layers, x, 0);
    return w;
  };
  // 行1: 方标(浅底/深底) + 横标(浅底/深底)
  chip(40, 40, 300, 300, C.canvas);
  place(scaleLayers(markLayers(), 236 / 128), 72, 72);
  chip(360, 40, 300, 300, C.dark);
  place(scaleLayers(markLayers(), 236 / 128), 392, 72);
  chip(680, 40, 520, 140, C.canvas);
  { const k = 440 / WIDE.width, h = WIDE_H * k;
    placeWide({ ox: 0, oy: 0, k, key: C.ink, cap: C.orange, hub: C.dark }, 680 + (520 - WIDE.width * k) / 2, 40 + (140 - h) / 2); }
  chip(680, 200, 520, 140, C.dark);
  { const k = 440 / WIDE.width, h = WIDE_H * k;
    placeWide({ ox: 0, oy: 0, k, key: C.inkDark, cap: C.orangeDark, hub: C.dark }, 680 + (520 - WIDE.width * k) / 2, 200 + (140 - h) / 2); }
  // 行2: favicon 实际尺寸模拟(亮/暗标签条)
  chip(40, 380, 700, 130, C.canvas); chip(760, 380, 440, 130, C.dark);
  for (const [baseX] of [[64], [784]]) {
    let fx = baseX;
    for (const s of [16, 24, 32, 48, 64]) {
      const scn = s < 48 ? favLayers() : markLayers();
      place(scaleLayers(scn, s / 128), fx, 445 - s / 2);
      fx += s + 30;
    }
  }
  // 行3: 大横标整行(检查字形)
  chip(40, 550, 1160, 300, C.canvas);
  { const k = 1.28, h = WIDE_H * k;
    placeWide({ ox: 0, oy: 0, k, key: C.ink, cap: C.orange, hub: C.dark }, 40 + (1160 - WIDE.width * k) / 2, 550 + (300 - h) / 2); }
  // 行4: 深底大横标
  chip(40, 890, 1160, 210, C.dark);
  { const k = 0.9, h = WIDE_H * k;
    placeWide({ ox: 0, oy: 0, k, key: C.inkDark, cap: C.orangeDark, hub: C.dark }, 40 + (1160 - WIDE.width * k) / 2, 890 + (210 - h) / 2); }
  return { name: 'preview-brand.png', W, H, rgba: rasterize(W, H, layers) };
}

// ---------- 字形裁剪预览(--crops): 大尺寸单字母 + favicon 实际像素放大 ----------
function crops() {
  const W = 1400, H = 2140;
  const layers = [{ color: rgb('#eeede7'), shapes: [{ p: rrect(0, 0, W, H, 0), mode: 'fill' }] }];
  const chip = (x, y, w, h, color) => layers.push({ color: rgb(color), shapes: [{ p: rrect(x, y, w, h, 0), mode: 'fill' }] });
  const place = (sceneLayers, x, y) => {
    for (const l of sceneLayers) for (const sh of l.shapes) {
      const m = (p) => p.t === 'rr' ? rrect(x + p.x, y + p.y, p.w, p.h, p.rr)
        : p.t === 'l' ? line(x + p.x1, y + p.y1, x + p.x2, y + p.y2)
          : arc(x + p.cx, y + p.cy, p.r, p.a0, p.a1);
      layers.push({ color: l.color, shapes: [{ p: m(sh.p), mode: sh.mode, w: sh.w }] });
    }
  };
  const k = 3.2; // x-height 320px
  // 字形卡两行各 3 张(卡宽 (100+30)·k=416): 字形垂直范围 -32..133(165 单位), 卡内居中
  let x = 60;
  for (const ch of 'KeyHub'.split('')) {
    const g = glyphsAt(SW)[ch];
    const w = (g.ink[1] - g.ink[0] + 30) * k;
    const row = 'Key'.includes(ch) ? 0 : 1;
    const cardY = 60 + row * 620, cardH = 580;
    chip(x, cardY, w, cardH, C.canvas);
    const oy = cardY + (cardH - 165 * k) / 2 + 32 * k;
    place(textLayers(ch, { ox: x + 15 - g.ink[0] * k, oy, k, sw: SW, color: ch === 'H' ? C.orange : C.ink }).layers, 0, 0);
    if (ch === 'y' || ch === 'b') x = 60; else x += w + 36;
  }

  // 大横标整行 k=1.55(1280 宽内完整可见)
  chip(60, 1320, 1280, 340, C.canvas);
  { const kk = 1.55;
    place(wideLayers({ ox: 0, oy: 1320 + (340 - WIDE_H * kk) / 2 - WIDE.top * kk, k: kk, key: C.ink, cap: C.orange, hub: C.dark }).layers, 60 + (1280 - WIDE.width * kk) / 2, 0); }

  // favicon 实际像素(16/24/32 键帽H + 48/64 方标) 最近邻放大 6x
  // 放大块边缘互相超采样出细缝 → 每块放大 0.6px 补缝
  const upscaled = (builder, size, px, py, zoom) => {
    const src = rasterize(size, size, scaleLayers(builder, size / 128));
    for (let y = 0; y < size; y++) for (let xx = 0; xx < size; xx++) {
      const i = (y * size + xx) * 4;
      if (src[i + 3] < 8) continue;
      layers.push({ color: [src[i], src[i + 1], src[i + 2], src[i + 3]], shapes: [{ p: rrect(px + xx * zoom, py + y * zoom, zoom + 0.6, zoom + 0.6, 0), mode: 'fill' }] });
    }
  };
  let fx = 60;
  for (const s of [16, 24, 32]) { upscaled(favLayers(), s, fx, 1720, 6); fx += s * 6 + 44; }
  for (const s of [48, 64]) { upscaled(markLayers(), s, fx, 1720, 6); fx += s * 6 + 44; }
  return { name: 'preview-crops.png', W, H, rgba: rasterize(W, H, layers) };
}

// ---------- 主流程 ----------
const svg = svgFiles();
if (CROPS) {
  const p = crops();
  fs.writeFileSync(path.join(ROOT, 'tools', 'preview-crops.png'), encodePNG(p.W, p.H, p.rgba));
  console.log('crops -> tools/preview-crops.png');
} else if (PREVIEW_ONLY) {
  const p = preview();
  fs.writeFileSync(path.join(ROOT, 'tools', 'preview-brand.png'), encodePNG(p.W, p.H, p.rgba));
  console.log('preview -> tools/preview-brand.png');
} else {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, data] of Object.entries(svg)) fs.writeFileSync(path.join(OUT, name), data);
  fs.writeFileSync(path.join(ROOT, 'favicon.svg'), svg['favicon.svg']);
  const png = pngAssets();
  fs.writeFileSync(path.join(ROOT, 'favicon.ico'), png['favicon.ico']);
  fs.writeFileSync(path.join(ROOT, 'apple-touch-icon.png'), png['apple-touch-icon.png']);
  for (const name of ['icon-192.png', 'icon-512.png', 'og.png']) fs.writeFileSync(path.join(OUT, name), png[name]);
  const p = preview();
  fs.writeFileSync(path.join(ROOT, 'tools', 'preview-brand.png'), encodePNG(p.W, p.H, p.rgba));
  console.log('brand assets -> assets/brand/ + favicon.* (preview: tools/preview-brand.png)');
}
