// 屏幕页（K65 等带屏型号；model.screen 门控）
// 帧编辑器 + 帧序列 + 播放预览 + 烧录到键盘。
// 协议层见 device/film.js（feat520 通道，反汇编实证 + 2026-10-18 真机回归通过）。
// 注意：固件只支持统一帧延时（取第 1 帧的 ms）。
// 帧数据持久化在 localStorage（按型号），存 PNG dataURL（压缩，避免 5MB 配额）。
// 画板模型：透明像素 = 熄屏（设备上显示黑）。编辑区以棋盘格呈现透明，
//   缩略图与烧录前合成到黑底——这样「橡皮擦除」和「画黑色」肉眼可辨。
// 附：像素画（块状网格绘制）、GIF 逐帧导入（js/gif.js）、加文字自定义字体（js/fontlib.js）。
import { h, toast, confirmBox } from '../ui.js';
import { L } from '../i18n.js';
import { state } from '../store.js';
import { device } from '../device/index.js';
import * as F from '../device/film.js';
import { decodeGif } from '../gif.js';
import * as fontlib from '../fontlib.js';
import { iconEl } from '../ui-icons.js';

const LS_KEY = 'keyhub-screen-v1'; // slug -> { frames: [{png, ms}] }

let activePlayTimer = 0; // 预览定时器链（模块级：切页后由 cleanupScreenPage 掐断）
let activeKeyHandler = null; // 快捷键监听（同上，切页时摘除）

// 调色板：屏幕为 RGB565，烧录时自动量化，这里选常见高辨识色
const PALETTE = [
  '#ffffff', '#c8c8c8', '#787878', '#383838',
  '#ff2d2d', '#ff5a00', '#ffd400', '#22d64a',
  '#00c8ff', '#2f5cff', '#c13bff', '#ff5fa8',
];

const TOOLS = [
  { id: 'pen', name: L('画笔', 'Pen'), icon: 'pencil' },
  { id: 'erase', name: L('橡皮', 'Eraser'), icon: 'eraser' },
  { id: 'fill', name: L('填充', 'Fill'), icon: 'pip' },
  { id: 'line', name: L('直线', 'Line'), icon: 'minus' },
  { id: 'rect', name: L('矩形', 'Rect'), icon: 'square' },
  { id: 'ellipse', name: L('椭圆', 'Ellipse'), icon: 'circle' },
  { id: 'pipette', name: L('取色', 'Pick color'), icon: 'pipette' },
];
const SHAPE_TOOLS = ['line', 'rect', 'ellipse'];
// 像素画块大小：取 135/240 的公约数，块状网格铺满不留边
const BLOCKS = [1, 3, 5, 15];

function loadStore(slug) {
  try { return JSON.parse(localStorage.getItem(LS_KEY))?.[slug] ?? { frames: [] }; }
  catch { return { frames: [] }; }
}
function saveStore(slug, data) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    all[slug] = data;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch (e) { toast(L('帧数据保存失败（本地存储已满？）', 'Failed to save frames (storage full?)'), true); }
}

export function renderScreenPage(root, ctx) {
  const { model } = state;
  const scr = model.screen ?? { w: 135, h: 240, maxFrames: 80 };
  const store = loadStore(model.slug);
  if (!store.frames.length) store.frames.push({ png: null, ms: 500 });

  let cur = 0;              // 当前帧下标
  let tool = 'pen';
  let color = '#ff5a00';
  let block = 1;            // 像素画块大小（1=逐像素）
  let playing = false;
  let burning = false;
  let abortBurn = false;

  // ---------- 帧画布（每帧一张离屏 canvas，尺寸=屏幕原生，含 alpha） ----------
  // 帧 PNG 从 dataURL 异步解码。解码完成前 persist() 必须跳过——否则会把空白画布
  // 写回存档，覆盖用户已画的帧（新开页面就涂鸦/切帧时可能触发）。
  const pendingLoads = [];
  let framesReady = true;
  const canvases = store.frames.map((f) => pngToCanvas(f.png));
  let dimEl = null; // 帧计数文案（render 内更新）
  function pngToCanvas(png) {
    const c = document.createElement('canvas');
    c.width = scr.w; c.height = scr.h;
    if (!png) return c;
    const img = new Image();
    let loaded = false;
    img.onload = () => { c.getContext('2d').drawImage(img, 0, 0); loaded = true; refreshReady(); render(); };
    img.onerror = () => { loaded = true; refreshReady(); }; // 损坏图按空帧处理
    img.src = png;
    pendingLoads.push(() => loaded);
    return c;
  }
  const refreshReady = () => { framesReady = pendingLoads.every((f) => f()); };
  const framePng = (i) => canvases[i].toDataURL('image/png');

  const persist = () => {
    if (!framesReady) return; // 帧未全部解码完成：跳过，防止空帧覆盖存档
    store.frames.forEach((f, i) => { f.png = framePng(i); });
    saveStore(model.slug, store);
  };

  // 整体替换帧序列（GIF 导入）：旧帧的异步解码守卫一并作废；fill(c,i) 负责在第 i 张新画布上作画
  const replaceFrames = (frames, fill) => {
    pendingLoads.length = 0;
    framesReady = true;
    store.frames = frames;
    canvases.length = 0;
    frames.forEach((f, i) => {
      const c = blankCanvas();
      fill?.(c, i);
      canvases.push(c);
    });
    cur = 0;
  };
  const blankCanvas = () => {
    const c = document.createElement('canvas');
    c.width = scr.w; c.height = scr.h;
    return c;
  };

  // ---------- 撤销 / 重做（当前帧，快照式，切帧即弃） ----------
  const undoStack = [], redoStack = [];
  const snap = () => canvases[cur].getContext('2d').getImageData(0, 0, scr.w, scr.h);
  const pushUndo = () => {
    undoStack.push(snap());
    if (undoStack.length > 25) undoStack.shift();
    redoStack.length = 0;
    syncHistory();
  };
  const restore = (img) => { canvases[cur].getContext('2d').putImageData(img, 0, 0); render(); persist(); };
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snap());
    restore(undoStack.pop());
    syncHistory();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snap());
    restore(redoStack.pop());
    syncHistory();
  }
  const clearHistory = () => { undoStack.length = 0; redoStack.length = 0; syncHistory(); };

  // ---------- 编辑区 ----------
  const SCALE = 2;
  const cv = h('canvas', { class: 'scr-canvas', width: scr.w * SCALE, height: scr.h * SCALE });
  const cvCtx = cv.getContext('2d');
  let painting = false;
  let last = { x: 0, y: 0 };   // 上一个绘制单元（cell = block 块）
  let anchor = { x: 0, y: 0 }; // 形状起点

  // 棋盘格 pattern（熄屏/透明呈现，两档暗灰）
  const checkPat = (() => {
    const p = document.createElement('canvas');
    p.width = 16; p.height = 16;
    const pc = p.getContext('2d');
    pc.fillStyle = '#0d0d0d'; pc.fillRect(0, 0, 16, 16);
    pc.fillStyle = '#1a1a1a'; pc.fillRect(0, 0, 8, 8); pc.fillRect(8, 8, 8, 8);
    return cvCtx.createPattern(p, 'repeat');
  })();
  // 帧合成到黑底（缩略图/烧录用真实观感）
  const blackBuf = blankCanvas();
  const bbCtx = blackBuf.getContext('2d');
  const frameOnBlack = (i) => {
    bbCtx.fillStyle = '#000'; bbCtx.fillRect(0, 0, scr.w, scr.h);
    bbCtx.drawImage(canvases[i], 0, 0);
    return blackBuf;
  };

  function renderFrame() {
    cvCtx.imageSmoothingEnabled = false;
    cvCtx.fillStyle = playing ? '#000' : checkPat; // 播放时按真实观感（黑底）
    cvCtx.fillRect(0, 0, cv.width, cv.height);
    cvCtx.drawImage(canvases[cur], 0, 0, cv.width, cv.height);
    // 网格：像素画模式按块显示，逐像素模式沿用 15px 参考线
    const step = block > 1 ? block : 15;
    cvCtx.strokeStyle = block > 1 ? 'rgba(128,128,128,0.28)' : 'rgba(128,128,128,0.12)';
    cvCtx.lineWidth = 1;
    for (let x = 0; x <= scr.w; x += step) { cvCtx.beginPath(); cvCtx.moveTo(x * SCALE + .5, 0); cvCtx.lineTo(x * SCALE + .5, cv.height); cvCtx.stroke(); }
    for (let y = 0; y <= scr.h; y += step) { cvCtx.beginPath(); cvCtx.moveTo(0, y * SCALE + .5); cvCtx.lineTo(cv.width, y * SCALE + .5); cvCtx.stroke(); }
    if (dimEl) dimEl.textContent = `${scr.w}×${scr.h} · ${L('第', 'frame')} ${cur + 1}/${store.frames.length}`;
  }
  function renderThumbs() {
    [...strip.children].forEach((el, i) => {
      const th = el.querySelector('canvas');
      if (th) { const tc = th.getContext('2d'); tc.clearRect(0, 0, th.width, th.height); tc.drawImage(frameOnBlack(i), 0, 0, th.width, th.height); }
      el.classList.toggle('on', i === cur);
    });
  }
  function render() { renderFrame(); renderThumbs(); }

  // ---------- 单元（cell）绘制原语：block=1 即逐像素 ----------
  const toCell = (px) => Math.floor(px / block);
  const paintCell = (c, cx, cy) => {
    const px = cx * block, py = cy * block;
    if (px < 0 || py < 0 || px + block > scr.w || py + block > scr.h) return;
    if (tool === 'erase') c.clearRect(px, py, block, block);
    else { c.fillStyle = color; c.fillRect(px, py, block, block); }
  };
  // Bresenham（cell 空间，跨指针移动不断线）
  function eachLine(x0, y0, x1, y1, cb) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      cb(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  // 矩形描边（cell 空间）
  function eachRect(x0, y0, x1, y1, cb) {
    const ax0 = Math.min(x0, x1), ay0 = Math.min(y0, y1), ax1 = Math.max(x0, x1), ay1 = Math.max(y0, y1);
    for (let x = ax0; x <= ax1; x++) { cb(x, ay0); cb(x, ay1); }
    for (let y = ay0 + 1; y < ay1; y++) { cb(ax0, y); cb(ax1, y); }
  }
  // 椭圆描边（中点法，cell 空间；退化为线段/点）
  function eachEllipse(x0, y0, x1, y1, cb) {
    const ax0 = Math.min(x0, x1), ay0 = Math.min(y0, y1), ax1 = Math.max(x0, x1), ay1 = Math.max(y0, y1);
    const a = (ax1 - ax0) / 2, b = (ay1 - ay0) / 2; // 半轴
    const cx = (ax0 + ax1) / 2, cy = (ay0 + ay1) / 2;
    if (a < 0.5 && b < 0.5) { cb(x0, y0); return; }
    if (a < 0.5 || b < 0.5) { eachLine(ax0, ay0, ax1, ay1, cb); return; }
    const plot = (dx, dy) => {
      cb(Math.round(cx + dx), Math.round(cy + dy));
      cb(Math.round(cx - dx), Math.round(cy + dy));
      cb(Math.round(cx + dx), Math.round(cy - dy));
      cb(Math.round(cx - dx), Math.round(cy - dy));
    };
    let x = 0, y = Math.round(b);
    const a2 = a * a, b2 = b * b;
    let d1 = b2 - a2 * b + a2 / 4;
    while (b2 * x < a2 * y) {
      plot(x, y);
      if (d1 < 0) d1 += b2 * (2 * x + 3);
      else { d1 += b2 * (2 * x + 3) + a2 * (2 - 2 * y); y--; }
      x++;
    }
    let d2 = b2 * (x + 0.5) * (x + 0.5) + a2 * (y - 1) * (y - 1) - a2 * b2;
    while (y >= 0) {
      plot(x, y);
      if (d2 > 0) d2 += a2 * (3 - 2 * y);
      else { d2 += a2 * (3 - 2 * y) + b2 * (2 * x + 2); x++; }
      y--;
    }
  }
  // 形状落到目标 ctx（commit 到帧画布 / 预览到编辑画布）
  function drawShape(target, scale) {
    const trace = tool === 'line' ? eachLine : tool === 'rect' ? eachRect : eachEllipse;
    const paint = (x, y) => {
      const px = x * block, py = y * block;
      if (px < 0 || py < 0 || px + block > scr.w || py + block > scr.h) return;
      target.globalAlpha = target === cvCtx ? 0.8 : 1;
      target.fillStyle = color;
      target.fillRect(px * scale, py * scale, block * scale, block * scale);
      target.globalAlpha = 1;
    };
    trace(anchor.x, anchor.y, last.x, last.y, paint);
  }

  // 填充（cell 空间：以单元左上角像素为代表色，整单元回填）
  function floodFill(c, cx, cy) {
    const gw = Math.ceil(scr.w / block), gh = Math.ceil(scr.h / block);
    if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) return;
    const img = c.getImageData(0, 0, scr.w, scr.h);
    const d = img.data;
    const at = (px, py) => (py * scr.w + px) * 4;
    const ti = at(cx * block, cy * block);
    const target = [d[ti], d[ti + 1], d[ti + 2], d[ti + 3]];
    const fill = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), 255];
    if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === fill[3]) return;
    const same = (px, py) => {
      const i = at(px, py);
      return d[i] === target[0] && d[i + 1] === target[1] && d[i + 2] === target[2] && d[i + 3] === target[3];
    };
    const stack = [[cx, cy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      if (!same(x * block, y * block)) continue;
      for (let sy = 0; sy < block; sy++)
        for (let sx = 0; sx < block; sx++) {
          const i = at(x * block + sx, y * block + sy);
          d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = 255;
        }
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    c.putImageData(img, 0, 0);
  }

  function cvPos(e) {
    const r = cv.getBoundingClientRect();
    // 先取最近像素（round(-0.5) 抵消浮点误差，光标落在像素中心时不偏移），再吸附到块
    const px = Math.round((e.clientX - r.left) / (r.width / scr.w) - 0.5);
    const py = Math.round((e.clientY - r.top) / (r.height / scr.h) - 0.5);
    return { px, py };
  }
  const cellOf = (e) => { const { px, py } = cvPos(e); return { x: toCell(px), y: toCell(py) }; };

  cv.addEventListener('pointerdown', (e) => {
    if (playing || burning) return;
    const c = canvases[cur].getContext('2d');
    if (tool === 'pipette') { // 取色后回到上一支笔
      const { px, py } = cvPos(e);
      const x = Math.max(0, Math.min(scr.w - 1, Math.round(px)));
      const y = Math.max(0, Math.min(scr.h - 1, Math.round(py)));
      const d = c.getImageData(x, y, 1, 1).data;
      setColor(d[3] < 128 ? '#000000' : `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
      pickTool(lastTool);
      return;
    }
    painting = true;
    try { cv.setPointerCapture(e.pointerId); } catch { /* 合成事件/指针已释放：忽略 */ }
    const cell = cellOf(e);
    last = cell; anchor = cell;
    if (tool === 'fill') { pushUndo(); floodFill(c, cell.x, cell.y); render(); persist(); painting = false; return; }
    pushUndo();
    if (SHAPE_TOOLS.includes(tool)) return; // 形状在移动中预览、抬起时提交
    if (tool === 'pen' || tool === 'erase') paintCell(c, cell.x, cell.y);
    renderFrame();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!painting) return;
    const cell = cellOf(e);
    if (SHAPE_TOOLS.includes(tool)) {
      last = cell;
      renderFrame();
      drawShape(cvCtx, SCALE); // 预览叠加
      return;
    }
    if (cell.x === last.x && cell.y === last.y) return;
    const c = canvases[cur].getContext('2d');
    eachLine(last.x, last.y, cell.x, cell.y, (x, y) => paintCell(c, x, y));
    last = cell;
    renderFrame();
  });
  cv.addEventListener('pointerup', () => {
    if (!painting) return;
    painting = false;
    if (SHAPE_TOOLS.includes(tool)) drawShape(canvases[cur].getContext('2d'), 1); // 提交
    render(); persist();
  });

  // ---------- 工具栏 ----------
  let lastTool = 'pen'; // 取色后返回的工具
  const toolBox = h('div', { class: 'scr-tools' });
  const syncTools = () => [...toolBox.children].forEach((b) => b.classList.toggle('on', b.dataset.t === tool));
  function pickTool(id) {
    if (id !== 'pipette') lastTool = id;
    tool = id;
    syncTools();
  }
  for (const t of TOOLS) {
    const b = h('button', { class: 'scr-tool' + (t.id === tool ? ' on' : ''), title: t.name, 'data-t': t.id }, iconEl(t.icon, 15));
    b.addEventListener('click', () => pickTool(t.id));
    toolBox.appendChild(b);
  }
  const undoBtn = h('button', { class: 'scr-tool', title: L('撤销（Ctrl+Z）', 'Undo (Ctrl+Z)'), onclick: undo, disabled: true }, iconEl('undo2', 15));
  const redoBtn = h('button', { class: 'scr-tool', title: L('重做（Ctrl+Y）', 'Redo (Ctrl+Y)'), onclick: redo, disabled: true }, iconEl('redo2', 15));
  function syncHistory() {
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
  }
  const clearBtn = h('button', { class: 'scr-tool', title: L('清空当前帧（熄屏）', 'Clear frame (screen off)'), onclick: () => {
    pushUndo();
    canvases[cur].getContext('2d').clearRect(0, 0, scr.w, scr.h);
    render(); persist();
  } }, iconEl('trash2', 15));

  // 调色板 + 自定义色
  const swatchBox = h('div', { class: 'scr-swatches' });
  const colorInp = h('input', { type: 'color', value: color, class: 'color-well', title: L('自定义颜色', 'Custom color') });
  function setColor(v) {
    color = v;
    colorInp.value = v;
    [...swatchBox.children].forEach((s) => s.classList.toggle('on', s.dataset.c === v));
  }
  for (const c of PALETTE) {
    const s = h('button', { class: 'scr-swatch' + (c === color ? ' on' : ''), title: c, 'data-c': c, style: `background:${c}` });
    s.addEventListener('click', () => setColor(c));
    swatchBox.appendChild(s);
  }
  colorInp.addEventListener('input', () => setColor(colorInp.value));

  // 像素画块大小
  const blockSel = h('select', { class: 'scr-sel', title: L('像素画：块大小（块状网格绘制）', 'Pixel art: block size'), 'aria-label': L('像素画块大小', 'Pixel block size') },
    ...BLOCKS.map((b) => h('option', { value: b, selected: b === 1 }, b === 1 ? L('逐像素', '1px') : `${b}×${b}`)));
  blockSel.addEventListener('change', () => { block = +blockSel.value; renderFrame(); });

  // ---------- 文字（含自定义字体） ----------
  const BASE_FONTS = [
    { family: 'sans-serif', label: L('默认黑体', 'Default sans') },
    { family: 'serif', label: L('衬线', 'Serif') },
    { family: 'monospace', label: L('等宽', 'Monospace') },
  ];
  let customFonts = []; // [{family,label}]（IndexedDB 恢复 + 会话内加载）
  let curFont = 'sans-serif';
  const fontSel = h('select', { class: 'scr-sel', title: L('字体', 'Font'), 'aria-label': L('字体', 'Font') });
  const fontDel = h('button', { class: 'scr-op', title: L('删除该自定义字体', 'Remove this custom font'), style: 'display:none' }, iconEl('x', 12));
  const fontCss = (fam) => /^(sans-serif|serif|monospace)$/.test(fam) ? fam : `"${fam}"`;
  function renderFontSel() {
    fontSel.replaceChildren(
      ...BASE_FONTS.map((f) => h('option', { value: f.family }, f.label)),
      ...customFonts.map((f) => h('option', { value: f.family }, f.label)),
      h('option', { value: '__load__' }, L('加载字体文件…', 'Load font file…')),
    );
    fontSel.value = curFont;
    fontDel.style.display = curFont.startsWith('khf-') ? '' : 'none';
  }
  fontSel.addEventListener('change', () => {
    if (fontSel.value === '__load__') { fontFileInp.click(); return; } // 取消时在 onchange 里回退
    curFont = fontSel.value;
    renderFontSel();
  });
  fontDel.addEventListener('click', async () => {
    const fam = curFont;
    try { await fontlib.deleteFont(fam); } catch { /* 删除失败仅影响下次启动的恢复 */ }
    customFonts = customFonts.filter((f) => f.family !== fam);
    curFont = 'sans-serif';
    renderFontSel();
    toast(L('已删除自定义字体', 'Custom font removed'));
  });
  const fontFileInp = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2', style: 'display:none' });
  fontFileInp.addEventListener('change', async () => {
    const file = fontFileInp.files[0];
    fontFileInp.value = '';
    fontSel.value = curFont; // 未选文件则回退
    if (!file) { renderFontSel(); return; }
    try {
      const buf = await file.arrayBuffer();
      const { family, label } = await fontlib.saveFont(fontlib.fontLabel(file.name), buf);
      if (!customFonts.some((f) => f.family === family)) customFonts.push({ family, label });
      curFont = family;
      renderFontSel();
      toast(L(`字体「${label}」已加载`, `Font "${label}" loaded`));
    } catch (err) {
      renderFontSel();
      toast(L(`字体加载失败：${err.message}`, `Font load failed: ${err.message}`), true);
    }
  });
  fontlib.restoreFonts().then((list) => {
    if (!list.length) return;
    customFonts = list;
    renderFontSel();
  });
  const txtInp = h('input', { type: 'text', class: 'scr-txt', placeholder: L('输入文字…', 'Text…'), maxlength: 40,
    autocomplete: 'off', spellcheck: 'false' });
  const szInp = h('input', { type: 'number', class: 'scr-sz', min: 6, max: 160, value: 32, title: L('字号 px', 'Font size px'),
    inputmode: 'numeric', autocomplete: 'off' });
  const txtAdd = h('button', { class: 'btn' }, iconEl('type', 14), L('加文字', 'Add text'));
  const drawText = () => {
    const s = txtInp.value.trim();
    if (!s) return;
    pushUndo();
    const c = canvases[cur].getContext('2d');
    const size = Math.max(6, Math.min(160, +szInp.value || 32));
    c.fillStyle = color;
    c.font = `bold ${size}px ${fontCss(curFont)}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(s, scr.w / 2, scr.h / 2);
    txtInp.value = '';
    render(); persist();
  };
  txtAdd.addEventListener('click', drawText);
  txtInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') drawText(); });

  // ---------- 图片 / GIF 导入 ----------
  const imgInp = h('input', { type: 'file', accept: 'image/*,.gif', style: 'display:none' });
  // 整屏信箱缩放（透明底）
  const drawFit = (c, src, sw, sh) => {
    const r = Math.min(scr.w / sw, scr.h / sh);
    const w = sw * r, hh = sh * r;
    c.drawImage(src, (scr.w - w) / 2, (scr.h - hh) / 2, w, hh);
  };
  imgInp.addEventListener('change', async () => {
    const file = imgInp.files[0];
    imgInp.value = '';
    if (!file) return;
    const isGif = /\.gif$/i.test(file.name) || file.type === 'image/gif';
    if (isGif) {
      try {
        const r = decodeGif(await file.arrayBuffer());
        const hasContent = store.frames.length > 1 || store.frames.some((f) => f.png);
        if (hasContent && !(await confirmBox(
          L('导入 GIF', 'Import GIF'),
          L(`将用 GIF 的 ${r.frames.length} 帧替换当前全部 ${store.frames.length} 帧（覆盖画板内容）。确认继续？`,
            `Replace all ${store.frames.length} frame(s) with ${r.frames.length} GIF frame(s)? Continue?`)))) return;
        // 超过固件帧上限时均匀抽帧，保住循环首尾
        let picks = r.frames;
        if (picks.length > scr.maxFrames) {
          const sampled = [];
          for (let i = 0; i < scr.maxFrames; i++) sampled.push(picks[Math.floor(i * picks.length / scr.maxFrames)]);
          picks = sampled;
          toast(L(`GIF 帧数超上限，已均匀采样为 ${scr.maxFrames} 帧`, `GIF exceeds the ${scr.maxFrames}-frame limit — evenly sampled`), true);
        }
        // 固件只支持统一帧延时：取众数
        const cnt = {};
        r.frames.forEach((f) => { cnt[f.delay] = (cnt[f.delay] || 0) + 1; });
        const delay = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
        if (Object.keys(cnt).length > 1)
          toast(L(`GIF 各帧延时不同，已统一为众数 ${delay}ms（固件仅支持统一延时）`,
            `GIF frame delays vary — unified to the mode ${delay}ms (firmware supports one global delay)`), true);
        replaceFrames(
          picks.map((f) => ({ png: null, ms: delay })),
          (c, i) => drawFit(c.getContext("2d"), picks[i].canvas, picks[i].canvas.width, picks[i].canvas.height),
        );
        clearHistory();
        rebuildStrip(); persist();
        toast(L(`已导入 ${store.frames.length} 帧（原图 ${r.width}×${r.height}）——可直接写入键盘`,
          `Imported ${store.frames.length} frames (source ${r.width}×${r.height}) — ready to burn`));
      } catch (err) {
        toast(L(`GIF 解码失败：${err.message}`, `GIF decode failed: ${err.message}`), true);
      }
      return;
    }
    // 静态图片：导入当前帧
    const img = new Image();
    img.onload = () => {
      pushUndo();
      const c = canvases[cur].getContext('2d');
      c.clearRect(0, 0, scr.w, scr.h);
      drawFit(c, img, img.width, img.height);
      render(); persist();
      toast(L('已导入当前帧', 'Imported into current frame'));
    };
    img.src = URL.createObjectURL(file);
  });
  const imgBtn = h('button', { class: 'btn' }, iconEl('upload', 14), L('导入图片 / GIF', 'Import image / GIF'));
  imgBtn.addEventListener('click', () => imgInp.click());

  // ---------- 帧序列 ----------
  const strip = h('div', { class: 'scr-strip' });
  const cntEl = h('span', { class: 'scr-cnt' });
  function rebuildStrip() {
    cntEl.textContent = `${store.frames.length}/${scr.maxFrames}`;
    strip.innerHTML = '';
    store.frames.forEach((f, i) => {
      const th = h('canvas', { width: scr.w, height: scr.h });
      const msInp = h('input', { type: 'number', class: 'scr-ms', min: 50, max: 60000, step: 50, value: f.ms,
        inputmode: 'numeric', autocomplete: 'off', title: L('播放间隔（毫秒）', 'Frame duration (ms)') });
      msInp.addEventListener('change', () => { f.ms = Math.max(50, Math.min(60000, +msInp.value || 500)); persist(); });
      const el = h('div', { class: 'scr-frame' + (i === cur ? ' on' : '') },
        th,
        // 64px 卡片放不下一行：ms 占一行，复制/删除一行
        h('div', { class: 'scr-frame-ops' },
          msInp,
          h('div', { class: 'scr-op-row' },
            h('button', { class: 'scr-op', title: L('复制帧', 'Duplicate'), onclick: () => dupFrame(i) }, iconEl('copy', 12)),
            h('button', { class: 'scr-op', title: L('删除帧', 'Delete'), onclick: () => delFrame(i) }, iconEl('x', 12)),
          ),
        ),
      );
      el.addEventListener('click', (e) => {
        if (e.target.closest('button,input')) return;
        cur = i; clearHistory(); render();
      });
      strip.appendChild(el);
    });
    const add = h('button', { class: 'scr-add' + (store.frames.length >= scr.maxFrames ? ' hidden' : ''), onclick: () => addFrame() },
      iconEl('plus', 14), L('新帧', 'Frame'));
    strip.appendChild(add);
    render();
  }
  function addFrame() {
    if (store.frames.length >= scr.maxFrames) { toast(L(`最多 ${scr.maxFrames} 帧`, `Max ${scr.maxFrames} frames`), true); return; }
    const c = blankCanvas();
    c.getContext('2d').drawImage(canvases[cur], 0, 0); // 复制当前帧内容，便于渐进步骤动画
    canvases.splice(cur + 1, 0, c);
    store.frames.splice(cur + 1, 0, { png: null, ms: store.frames[cur]?.ms ?? 500 });
    cur++;
    clearHistory();
    rebuildStrip(); persist();
  }
  function dupFrame(i) { cur = i; addFrame(); }
  function delFrame(i) {
    if (store.frames.length <= 1) { toast(L('至少保留一帧', 'Keep at least one frame'), true); return; }
    canvases.splice(i, 1);
    store.frames.splice(i, 1);
    cur = Math.min(cur, store.frames.length - 1);
    clearHistory();
    rebuildStrip(); persist();
  }

  // ---------- 预览 ----------
  const playBtn = h('button', { class: 'btn', onclick: togglePlay }, iconEl('play', 14), L('预览', 'Preview'));
  function togglePlay() {
    playing = !playing;
    playBtn.classList.toggle('primary', playing);
    if (playing) {
      playBtn.replaceChildren(iconEl('square', 14), L('停止', 'Stop'));
      const step = () => {
        if (!playing) return;
        cur = (cur + 1) % store.frames.length;
        renderFrame();
        activePlayTimer = setTimeout(step, Math.max(50, store.frames[cur].ms));
      };
      step();
    } else {
      if (activePlayTimer) { clearTimeout(activePlayTimer); activePlayTimer = 0; }
      playBtn.replaceChildren(iconEl('play', 14), L('预览', 'Preview'));
      render();
    }
  }

  // ---------- 烧录 ----------
  const prog = h('div', { class: 'scr-prog hidden' }, h('div', { class: 'scr-prog-bar' }));
  const burnBtn = h('button', { class: 'btn primary', onclick: burn }, iconEl('send', 14), L('写入键盘', 'Write to keyboard'));
  const abortBtn = h('button', { class: 'btn hidden', onclick: () => { abortBurn = true; } }, L('取消', 'Cancel'));
  function packFrames() {
    return store.frames.map((_, i) => F.rgb565Pack(frameOnBlack(i).getContext('2d').getImageData(0, 0, scr.w, scr.h)));
  }
  async function burn() {
    if (burning) return;
    if (playing) togglePlay();
    if (device.mode !== 'hid') {
      toast(L('演示模式不写入真机——连接键盘后再试', 'Demo mode writes nothing — connect a keyboard first'), true);
      return;
    }
    if (device.channelOf(device.dev) === 'wireless') {
      toast(L('无线连接不支持传输图片，请接入 USB 数据线（与官方驱动一致）', 'Image transfer needs USB wired (same as the official driver)'), true);
      return;
    }
    if (new Set(store.frames.map((f) => Math.round(f.ms))).size > 1) {
      toast(L('固件只支持统一帧延时，将按第 1 帧的间隔烧录（详见 HID 日志）', 'Firmware supports one global frame delay; the 1st frame\'s interval will be used (see HID log)'), false);
    }
    // 覆盖式写入键盘屏幕（秒级传输），保留一步确认
    if (!(await confirmBox(
      L('写入键盘屏幕', 'Write to keyboard screen'),
      L(`将把 ${store.frames.length} 帧循环动画烧录到键盘屏幕（覆盖现有内容，随时可重烧）。确认继续？`,
        `Burn ${store.frames.length} looping frames to the keyboard screen (overwrites current content; re-burn anytime). Continue?`)))) return;
    burning = true; abortBurn = false;
    if (!framesReady) { toast(L('帧数据还在解码，请稍候重试', 'Frames are still decoding — try again shortly'), true); burning = false; return; }
    burnBtn.disabled = true; abortBtn.classList.remove('hidden');
    prog.classList.remove('hidden');
    const setProg = (done, total) => { prog.firstElementChild.style.width = `${Math.round(done * 100 / total)}%`; };
    setProg(0, 1);
    try {
      const res = await device.burnScreen(packFrames(), {
        delays: store.frames.map((f) => f.ms),
        onProgress: setProg,
        shouldAbort: () => abortBurn,
      });
      if (res.error === 'no-iface') toast(L('未找到可用的屏幕接口——请重新连接并授权弹窗里的所有设备行', 'No screen interface found — reconnect and grant every device row'), true);
      else if (res.error === 'no-ack') toast(L('键盘未应答开始命令（SetGIFParam）——请重插后重试，详见 HID 日志', 'Keyboard did not ack the start command (SetGIFParam) — replug and retry; see the HID log'), true);
      else if (res.sim) toast(L('演示完成（未写入真机）', 'Preview finished (nothing written)'));
      else if (res.sent) toast(L(`已发送 ${res.frames} 帧（${res.chunks} 片）——请观察键盘屏幕确认`, `Sent ${res.frames} frames (${res.chunks} chunks) — check the keyboard screen`));
      else toast(L('烧录未完成，详见 HID 日志', 'Burn incomplete — see the HID log'), true);
    } finally {
      burning = false;
      burnBtn.disabled = false;
      abortBtn.classList.add('hidden');
      setTimeout(() => prog.classList.add('hidden'), 800);
    }
  }

  // ---------- 调试（SetGIFParam cmd 0x0D，反汇编实证的烧录开始/收尾命令） ----------
  const dbgCount = h('input', { type: 'number', class: 'scr-dbg-inp', min: 1, max: scr.maxFrames, value: 1,
    inputmode: 'numeric', autocomplete: 'off', title: L('帧数', 'frames') });
  const dbgDelay = h('input', { type: 'number', class: 'scr-dbg-inp', min: 0, max: 65535, value: 500,
    inputmode: 'numeric', autocomplete: 'off', title: L('延时 ms', 'delay ms') });
  const dbgBtn = h('button', { class: 'btn', onclick: async () => {
    await device.setGifParam(0, Math.max(1, +dbgCount.value | 0), Math.max(0, +dbgDelay.value | 0));
    if (device.mode !== 'hid') toast(L('演示模式不发送', 'Demo mode sends nothing'));
  } }, L('发送收尾命令', 'Send finish cmd'));

  // ---------- 快捷键 ----------
  activeKeyHandler = (e) => {
    if (playing || burning) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  };
  window.addEventListener('keydown', activeKeyHandler);

  // ---------- 布局 ----------
  // 竖屏画布（9:16）需要纵向空间：本页把面板调高（.scr-tall，cleanup 时移除）。
  // 编辑卡只包住画布与绘制工具（贴住竖屏比例，不再横向铺满），其余控件与帧序列放右侧工作列。
  root.classList.add('scr-tall');
  const page = h('div', { class: 'page-inner scr-page' },
    h('div', { class: 'scr-editor' },
      h('div', { class: 'scr-head' },
        h('h3', {}, L('屏幕画面', 'Screen canvas')),
        dimEl = h('span', { class: 'scr-dim', text: `${scr.w}×${scr.h}` }),
      ),
      h('div', { class: 'scr-toolbar' },
        toolBox,
        h('span', { class: 'scr-tsep' }),
        undoBtn, redoBtn, clearBtn,
        h('span', { class: 'scr-tsep' }),
        blockSel,
        h('div', { class: 'scr-colors' }, swatchBox, colorInp),
      ),
      h('div', { class: 'scr-cvwrap' }, cv),
    ),
    h('div', { class: 'scr-side' },
      h('div', { class: 'scr-ops' },
        txtInp, txtAdd,
        h('div', { class: 'scr-ops-row' }, fontSel, szInp, fontDel),
        imgBtn,
      ),
      h('div', { class: 'scr-frames' },
        h('div', { class: 'scr-frames-head' },
          h('h3', { title: L(`键盘循环播放这些帧；每帧可设播放间隔，上限 ${scr.maxFrames} 帧。`,
            `The keyboard loops these frames; set a duration per frame, up to ${scr.maxFrames}.`) }, L('帧序列', 'Frames')),
          cntEl,
        ),
        strip,
      ),
      h('div', { class: 'scr-warn', text: L('烧录协议由官方驱动反汇编实证并经真机回归（feat520 通道：SetGIFParam 开始/收尾 + 512B 像素分包）；固件只支持统一帧延时，取第 1 帧的间隔。异常时拔线重启键盘即可恢复。',
        'The burn protocol is evidence-based from the official driver and hardware-verified (feat520 pipe: SetGIFParam start/finish + 512B pixel chunks); the firmware supports one global frame delay (the 1st frame\'s interval). Replug the keyboard to recover from faults.') }),
      h('div', { class: 'scr-actions' }, playBtn, burnBtn, abortBtn, prog),
      h('div', { class: 'scr-dbg' },
        h('span', { class: 'scr-dbg-lbl', text: L('调试', 'Debug') }),
        dbgCount, dbgDelay, dbgBtn,
        h('span', { class: 'scr-dbg-note', text: L('SetGIFParam(cmd 0x0D)：烧录收尾命令——烧录中断在「已发 N 帧」时可用它补发收尾（帧数=已发数、延时=原值），或配合 HID 调试台对照官方驱动抓包。',
          'SetGIFParam (cmd 0x0D): the burn finish command — if a burn stops after N frames, resend finish with frames=N and the original delay; also for comparing against the official driver via the HID console.') }),
      ),
    ),
  );
  for (const inp of [imgInp, fontFileInp]) {
    inp.style.display = 'none';
    page.appendChild(inp);
  }
  root.appendChild(page);
  renderFontSel();
  rebuildStrip();
}

export function cleanupScreenPage() {
  // 预览定时器是跨渲染存活的模块级链——切页时必须掐断，否则空转渲染已脱离 DOM 的画布
  if (activePlayTimer) { clearTimeout(activePlayTimer); activePlayTimer = 0; }
  if (activeKeyHandler) { window.removeEventListener('keydown', activeKeyHandler); activeKeyHandler = null; }
  document.getElementById('page')?.classList.remove('scr-tall');
}
export { cleanupScreenPage as cleanup };
