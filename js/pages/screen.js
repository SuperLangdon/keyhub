// 屏幕页（K65 等带屏型号；model.screen 门控）
// 帧序列 + 播放预览 + 烧录到键盘。协议层见 device/film.js（feat520 通道，真机回归通过）。
//
// 图层模型（本页核心）：每帧三个相互独立、自下而上叠加的图层——
//   图片层（上传图片 / GIF 逐帧；GIF 导入时选缩放模式：填充/适应/拉伸，静态图固定适应） → 画板层（手绘笔迹，透明=露出下层）
//   → 文字层（多条文字，画布上拖动定位、面板内行内编辑）。
//   每层可单独隐藏（眼睛，烧录/预览不含隐藏层）与单独清空；互不覆盖。
// 撤销/重做 = 当前帧全图层快照（Ctrl+Z / Ctrl+Y）；切帧即弃。
// 布局：最左画布独占整卡（画板要画，落笔空间最大化，尺寸信息为画布角悬浮章）；
//   右侧控制卡 = 画板工具 + 图层三行 + 文字条目，其下是横向胶片栏（剪辑时间线式）、
//   烧录动作与断点续传（自动记录中断进度，一键收尾，无需手填参数）。
// 持久化 localStorage keyhub-screen-v2（旧 v1 的整帧 PNG 自动迁入画板层，原键保留）。
// 注意：固件只支持统一帧延时（烧录取第 1 帧的 ms）；画板透明处在编辑区以棋盘格呈现，
//   缩略图与烧录前合成到黑底——「橡皮擦除」与「画黑色」肉眼可辨。
// 有线门控：图片传输走有线接口的 feat520 数据通道（与官方驱动一致），2.4G 无线会话整页
//   遮罩（编辑也拦，防止做到一半才发现写不进键盘）；会话并入有线接口即自动揭开（syncGate）。
import { h, toast, confirmBox, modalA11y } from '../ui.js';
import { t } from '../i18n.js';
import { state, on } from '../store.js';
import { device } from '../device/index.js';
import * as F from '../device/film.js';
import { decodeGif } from '../gif.js';
import * as fontlib from '../fontlib.js';
import { iconEl } from '../ui-icons.js';

const LS_KEY = 'keyhub-screen-v2';
const LS_KEY_V1 = 'keyhub-screen-v1'; // 旧版（整帧单画布），只读迁移

let activePlayTimer = 0; // 预览定时器链（模块级：切页后由 cleanupScreenPage 掐断）
let activeKeyHandler = null; // 快捷键监听（同上，切页时摘除）
let activePersistFlush = null; // 防抖持久化的立即落盘函数（同上，切页时冲刷）
let activeGateUnsub = null; // 'device' 事件订阅（同上，切页时退订）

// 调色板：屏幕为 RGB565，烧录时自动量化，这里选常见高辨识色
const PALETTE = [
  '#ffffff', '#c8c8c8', '#787878', '#383838',
  '#ff2d2d', '#ff5a00', '#ffd400', '#22d64a',
  '#00c8ff', '#2f5cff', '#c13bff', '#ff5fa8',
];

// 工具名走 t()：函数化惰性求值，切语言后重进页面即换文案（模块级常量会固化首次语言）
const tools = () => [
  { id: 'pen', name: t('app.screen.pen'), icon: 'pencil' },
  { id: 'erase', name: t('app.screen.eraser'), icon: 'eraser' },
  { id: 'fill', name: t('app.screen.fill'), icon: 'pip' },
  { id: 'line', name: t('app.screen.line'), icon: 'minus' },
  { id: 'rect', name: t('app.screen.rect'), icon: 'square' },
  { id: 'ellipse', name: t('app.screen.ellipse'), icon: 'circle' },
  { id: 'pipette', name: t('app.screen.pipette'), icon: 'pipette' },
];
const SHAPE_TOOLS = ['line', 'rect', 'ellipse'];
const TOOL_KEYS = { b: 'pen', e: 'erase', g: 'fill', l: 'line', r: 'rect', o: 'ellipse', i: 'pipette' };
// 像素画块大小：取 135/240 的公约数，块状网格铺满不留边
const BLOCKS = [1, 3, 5, 15];

// ---------- 存档（v2 图层结构；v1 迁移：整帧 PNG → 画板层） ----------
function loadSaved(slug) {
  for (const key of [LS_KEY, LS_KEY_V1]) {
    let data;
    try { data = JSON.parse(localStorage.getItem(key))?.[slug]; } catch { data = null; }
    if (!data?.frames?.length) continue;
    return data.frames.map((f) => key === LS_KEY
      ? { ms: f.ms, img: f.img ?? null, paint: f.paint ?? null, texts: f.texts ?? [], vis: f.vis ?? {} }
      : { ms: f.ms, img: null, paint: f.png ?? null, texts: [], vis: {} }); // v1：全部内容视作画板
  }
  return [];
}
function saveStore(slug, data) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    all[slug] = data;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch (e) { toast(t('app.screen.saveFailed'), true); }
}

export function renderScreenPage(root, ctx) {
  const { model } = state;
  const scr = model.screen ?? { w: 135, h: 240, maxFrames: 80 };

  let cur = 0;              // 当前帧下标
  let tool = 'pen';
  let color = '#ff5a00';
  let block = 1;            // 像素画块大小（1=逐像素）
  let playing = false;
  let burning = false;
  let abortBurn = false;
  let burnStart = 0;        // 烧录起点时间戳（倒计时按整体平均帧耗时外推）
  let gated = false;        // 无线门控生效中（编辑/烧录全拦，见布局区的遮罩）

  const blankCanvas = () => {
    const c = document.createElement('canvas');
    c.width = scr.w; c.height = scr.h;
    return c;
  };
  const cloneCanvas = (c) => { if (!c) return null; const n = blankCanvas(); n.getContext('2d').drawImage(c, 0, 0); return n; };
  const cloneTexts = (texts) => texts.map((t) => ({ ...t }));

  // ---------- 帧数据（内存真源）：imgC 图片层 / paintC 画板层 / texts 文字层 ----------
  // 图层 PNG 从 dataURL 异步解码。解码完成前 persist() 必须跳过——否则会把空白画布
  // 写回存档，覆盖用户已编辑的帧。
  const pendingLoads = [];
  let framesReady = true;
  function dataToCanvas(png) {
    const c = blankCanvas();
    if (!png) return c;
    const img = new Image();
    let loaded = false;
    img.onload = () => { c.getContext('2d').drawImage(img, 0, 0); loaded = true; refreshReady(); render(); };
    img.onerror = () => { loaded = true; refreshReady(); }; // 损坏图按空层处理
    img.src = png;
    pendingLoads.push(() => loaded);
    return c;
  }
  const refreshReady = () => { framesReady = pendingLoads.every((f) => f()); syncBurnBtn(); };
  // 写入按钮随解码状态启停（burnBtn 在下方定义，首次 refreshReady 晚于定义，此处引用安全）
  let syncBurnBtn = () => {};

  const saved = loadSaved(model.slug);
  if (!saved.length) saved.push({ ms: 500, img: null, paint: null, texts: [], vis: {} });
  const frames = saved.map((f) => ({
    ms: f.ms ?? 500,
    imgC: f.img ? dataToCanvas(f.img) : null,
    paintC: dataToCanvas(f.paint),
    texts: cloneTexts(f.texts),
    vis: { img: true, paint: true, text: true, ...f.vis },
  }));
  refreshReady();

  // 防抖持久化：连发操作（逐帧加帧、连续绘制、批量改延时）合并为一次全量编码，
  // 否则 80 帧 × 每次点击全量 toDataURL 会把主线程拖死。
  // 图片层用 WebP：导入的照片/GIF 帧按 PNG 存约 85KB/帧，80 帧近 7MB 会顶爆 localStorage
  // 配额（keyhub-screen-v2 与其它键共享 ~10MB）；WebP q0.9 约 14KB/帧。img 层只在导入时
  // 整体替换、无逐次编辑，有损不累积；烧录本就量化 RGB565，观感无损。画板层是用户笔画、
  // 每次编辑都重存，保持 PNG 防有损世代衰减。不支持 WebP 编码的浏览器 toDataURL 自动回退 PNG。
  let persistTimer = 0;
  const persistNow = () => {
    persistTimer = 0;
    if (!framesReady) return; // 帧未全部解码完成：跳过，防止空层覆盖存档
    saveStore(model.slug, {
      frames: frames.map((f) => ({
        ms: f.ms,
        img: f.imgC ? f.imgC.toDataURL('image/webp', 0.9) : null,
        paint: f.paintC.toDataURL('image/png'),
        texts: f.texts,
        vis: f.vis,
      })),
    });
  };
  const persist = () => {
    if (!framesReady) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 150);
  };
  activePersistFlush = () => { clearTimeout(persistTimer); persistNow(); };

  // ---------- 撤销 / 重做（当前帧全图层快照，切帧即弃） ----------
  const undoStack = [], redoStack = [];
  const snapFrame = () => {
    const f = frames[cur];
    return {
      img: f.imgC ? f.imgC.getContext('2d').getImageData(0, 0, scr.w, scr.h) : null,
      paint: f.paintC.getContext('2d').getImageData(0, 0, scr.w, scr.h),
      texts: cloneTexts(f.texts),
    };
  };
  const pushSnap = (s) => {
    undoStack.push(s);
    if (undoStack.length > 25) undoStack.shift();
    redoStack.length = 0;
    syncHistory();
  };
  const pushUndo = () => pushSnap(snapFrame());
  const restore = (s) => {
    const f = frames[cur];
    if (s.img) {
      if (!f.imgC) f.imgC = blankCanvas();
      f.imgC.getContext('2d').putImageData(s.img, 0, 0);
    } else f.imgC = null;
    f.paintC.getContext('2d').putImageData(s.paint, 0, 0);
    f.texts = cloneTexts(s.texts);
    render(); renderLayers(); persist();
  };
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapFrame());
    restore(undoStack.pop());
    syncHistory();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapFrame());
    restore(redoStack.pop());
    syncHistory();
  }
  const clearHistory = () => { undoStack.length = 0; redoStack.length = 0; syncHistory(); };

  // ---------- 合成 ----------
  // 画布上文字按「中心点」坐标绘制（textAlign center / baseline middle），便于拖动定位
  const fontCss = (fam) => /^(sans-serif|serif|monospace)$/.test(fam) ? fam : `"${fam}"`;
  function drawTextsTo(c, texts) {
    for (const t of texts) {
      c.fillStyle = t.color;
      c.font = `bold ${t.size}px ${fontCss(t.font)}`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(t.s, t.x, t.y);
    }
  }
  // rasterFrame：可见图层合成到黑底（缩略图 / 烧录 / 取色的真实观感）
  const rasterBuf = blankCanvas();
  const rbCtx = rasterBuf.getContext('2d');
  function rasterFrame(i, withText = true) {
    const f = frames[i];
    rbCtx.fillStyle = '#000'; rbCtx.fillRect(0, 0, scr.w, scr.h);
    if (f.vis.img && f.imgC) rbCtx.drawImage(f.imgC, 0, 0);
    if (f.vis.paint) rbCtx.drawImage(f.paintC, 0, 0);
    if (withText && f.vis.text) drawTextsTo(rbCtx, f.texts);
    return rasterBuf;
  }
  // flatNoText：图片+画板（不含文字/黑底，保留 alpha）——填充工具的边界判定源
  const flatBuf = blankCanvas();
  const fbCtx = flatBuf.getContext('2d');
  function flatNoText(i) {
    const f = frames[i];
    fbCtx.clearRect(0, 0, scr.w, scr.h);
    if (f.vis.img && f.imgC) fbCtx.drawImage(f.imgC, 0, 0);
    if (f.vis.paint) fbCtx.drawImage(f.paintC, 0, 0);
    return flatBuf;
  }
  const paintHasInk = (f) => f.paintC.getContext('2d')
    .getImageData(0, 0, scr.w, scr.h).data.some((v, i) => i % 4 === 3 && v > 0);

  // ---------- 编辑区 ----------
  const SCALE = 2;
  const cv = h('canvas', { class: 'scr-canvas', width: scr.w * SCALE, height: scr.h * SCALE });
  const cvCtx = cv.getContext('2d');
  const measureCtx = blankCanvas().getContext('2d'); // 文字命中测试用
  let painting = false;
  let dragText = -1;        // 正在拖动的文字下标（-1 = 无）
  let dragOff = { x: 0, y: 0 };
  let last = { x: 0, y: 0 };   // 上一个绘制单元（cell = block 块）
  let anchor = { x: 0, y: 0 }; // 形状起点

  // 棋盘格 pattern（全透明处呈现，两档暗灰）
  const checkPat = (() => {
    const p = document.createElement('canvas');
    p.width = 16; p.height = 16;
    const pc = p.getContext('2d');
    pc.fillStyle = '#0d0d0d'; pc.fillRect(0, 0, 16, 16);
    pc.fillStyle = '#1a1a1a'; pc.fillRect(0, 0, 8, 8); pc.fillRect(8, 8, 8, 8);
    return cvCtx.createPattern(p, 'repeat');
  })();

  let dimEl = null; // 帧计数文案（renderFrame 内更新）
  let msInp = null; // 当前帧延时输入（帧序列栏头集中编辑，renderFrame 内随 cur 同步）
  const syncHud = () => {
    if (dimEl) dimEl.textContent = t('app.screen.frameHud', { w: scr.w, h: scr.h, cur: cur + 1, total: frames.length });
    // 用户正在输入时不回写（播放轮播会连续改 cur）
    if (msInp && document.activeElement !== msInp) msInp.value = frames[cur].ms;
  };
  function renderFrame() {
    const f = frames[cur];
    cvCtx.imageSmoothingEnabled = false;
    cvCtx.fillStyle = playing ? '#000' : checkPat; // 播放时按真实观感（黑底）
    cvCtx.fillRect(0, 0, cv.width, cv.height);
    if (f.vis.img && f.imgC) cvCtx.drawImage(f.imgC, 0, 0, cv.width, cv.height);
    if (f.vis.paint) cvCtx.drawImage(f.paintC, 0, 0, cv.width, cv.height);
    if (f.vis.text && f.texts.length) {
      cvCtx.save(); cvCtx.scale(SCALE, SCALE);
      drawTextsTo(cvCtx, f.texts);
      cvCtx.restore();
    }
    if (playing) { // 播放时不叠网格
      syncHud();
      return;
    }
    // 网格：像素画模式按块显示，逐像素模式沿用 15px 参考线
    const step = block > 1 ? block : 15;
    cvCtx.strokeStyle = block > 1 ? 'rgba(128,128,128,0.28)' : 'rgba(128,128,128,0.12)';
    cvCtx.lineWidth = 1;
    for (let x = 0; x <= scr.w; x += step) { cvCtx.beginPath(); cvCtx.moveTo(x * SCALE + .5, 0); cvCtx.lineTo(x * SCALE + .5, cv.height); cvCtx.stroke(); }
    for (let y = 0; y <= scr.h; y += step) { cvCtx.beginPath(); cvCtx.moveTo(0, y * SCALE + .5); cvCtx.lineTo(cv.width, y * SCALE + .5); cvCtx.stroke(); }
    syncHud();
  }
  function renderThumbs() {
    [...strip.children].forEach((el, i) => {
      const th = el.querySelector('canvas');
      if (th) { const tc = th.getContext('2d'); tc.drawImage(rasterFrame(i), 0, 0, th.width, th.height); }
      el.classList.toggle('on', i === cur);
    });
  }
  function render() { renderFrame(); renderThumbs(); }

  // ---------- 画板绘制原语（cell 空间，block=1 即逐像素；只作用于画板层） ----------
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
  // 形状落到目标 ctx（commit 到画板层 / 预览到编辑画布）
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

  // 填充：在「图片+画板」合成像素上判定连通边界（文字层不参与），结果写入画板层
  function floodFill(cx, cy) {
    const gw = Math.ceil(scr.w / block), gh = Math.ceil(scr.h / block);
    if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) return;
    const d = flatNoText(cur).getContext('2d').getImageData(0, 0, scr.w, scr.h).data;
    const at = (px, py) => (py * scr.w + px) * 4;
    const ti = at(cx * block, cy * block);
    const target = [d[ti], d[ti + 1], d[ti + 2], d[ti + 3]];
    const fill = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), 255];
    if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === fill[3]) return;
    const same = (px, py) => {
      const i = at(px, py);
      return d[i] === target[0] && d[i + 1] === target[1] && d[i + 2] === target[2] && d[i + 3] === target[3];
    };
    const pc = frames[cur].paintC.getContext('2d');
    pc.fillStyle = color;
    const stack = [[cx, cy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      if (!same(x * block, y * block)) continue;
      pc.fillRect(x * block, y * block, block, block);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  function cvPos(e) {
    const r = cv.getBoundingClientRect();
    // 先取最近像素（round(-0.5) 抵消浮点误差，光标落在像素中心时不偏移），再吸附到块
    const px = Math.round((e.clientX - r.left) / (r.width / scr.w) - 0.5);
    const py = Math.round((e.clientY - r.top) / (r.height / scr.h) - 0.5);
    return { px, py };
  }
  const cellOf = (e) => { const { px, py } = cvPos(e); return { x: toCell(px), y: toCell(py) }; };

  // 文字命中（自上而下，取最上层；仅文字层可见时可拖）
  function textAt(px, py) {
    const f = frames[cur];
    if (!f.vis.text) return -1;
    for (let k = f.texts.length - 1; k >= 0; k--) {
      const t = f.texts[k];
      measureCtx.font = `bold ${t.size}px ${fontCss(t.font)}`;
      const w = measureCtx.measureText(t.s).width || 4;
      if (px >= t.x - w / 2 - 3 && px <= t.x + w / 2 + 3 && py >= t.y - t.size / 2 - 3 && py <= t.y + t.size / 2 + 3) return k;
    }
    return -1;
  }

  cv.addEventListener('pointerdown', (e) => {
    if (playing || burning) return;
    const { px, py } = cvPos(e);
    if (tool === 'pipette') { // 取合成色，取完回上一支笔
      const x = Math.max(0, Math.min(scr.w - 1, Math.round(px)));
      const y = Math.max(0, Math.min(scr.h - 1, Math.round(py)));
      const d = rasterFrame(cur).getContext('2d').getImageData(x, y, 1, 1).data;
      setColor(d[3] < 128 ? '#000000' : `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
      pickTool(lastTool);
      return;
    }
    const k = textAt(px, py);
    if (k >= 0) { // 拖动文字定位
      pushUndo();
      dragText = k;
      dragOff = { x: px - frames[cur].texts[k].x, y: py - frames[cur].texts[k].y };
      try { cv.setPointerCapture(e.pointerId); } catch { /* 合成事件/指针已释放：忽略 */ }
      return;
    }
    const f = frames[cur];
    if (!f.vis.paint) { f.vis.paint = true; renderLayers(); } // 往隐藏的画板层落笔：自动恢复可见
    painting = true;
    try { cv.setPointerCapture(e.pointerId); } catch { /* 同上 */ }
    const cell = cellOf(e);
    last = cell; anchor = cell;
    if (tool === 'fill') { pushUndo(); floodFill(cell.x, cell.y); render(); persist(); painting = false; return; }
    pushUndo();
    if (SHAPE_TOOLS.includes(tool)) return; // 形状在移动中预览、抬起时提交
    if (tool === 'pen' || tool === 'erase') paintCell(f.paintC.getContext('2d'), cell.x, cell.y);
    renderFrame();
  });
  cv.addEventListener('pointermove', (e) => {
    if (dragText >= 0) {
      const { px, py } = cvPos(e);
      const t = frames[cur].texts[dragText];
      t.x = Math.max(0, Math.min(scr.w, px - dragOff.x));
      t.y = Math.max(0, Math.min(scr.h, py - dragOff.y));
      renderFrame();
      return;
    }
    if (!painting) { // 悬停光标提示：文字可拖动
      const { px, py } = cvPos(e);
      cv.style.cursor = (!playing && tool !== 'pipette' && textAt(px, py) >= 0) ? 'move' : 'crosshair';
      return;
    }
    const cell = cellOf(e);
    if (SHAPE_TOOLS.includes(tool)) {
      last = cell;
      renderFrame();
      drawShape(cvCtx, SCALE); // 预览叠加
      return;
    }
    if (cell.x === last.x && cell.y === last.y) return;
    const c = frames[cur].paintC.getContext('2d');
    eachLine(last.x, last.y, cell.x, cell.y, (x, y) => paintCell(c, x, y));
    last = cell;
    renderFrame();
  });
  const endPointer = () => {
    if (dragText >= 0) { dragText = -1; persist(); return; }
    if (!painting) return;
    painting = false;
    if (SHAPE_TOOLS.includes(tool)) drawShape(frames[cur].paintC.getContext('2d'), 1); // 提交
    render(); persist();
  };
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);

  // ---------- 画板工具栏 ----------
  let lastTool = 'pen'; // 取色后返回的工具
  const toolBox = h('div', { class: 'scr-tools' });
  const syncTools = () => [...toolBox.children].forEach((b) => b.classList.toggle('on', b.dataset.t === tool));
  function pickTool(id) {
    if (id !== 'pipette') lastTool = id;
    tool = id;
    syncTools();
  }
  for (const toolInfo of tools()) {
    const b = h('button', { class: 'scr-tool' + (toolInfo.id === tool ? ' on' : ''), title: toolInfo.name, 'data-t': toolInfo.id }, iconEl(toolInfo.icon, 15));
    b.addEventListener('click', () => pickTool(toolInfo.id));
    toolBox.appendChild(b);
  }
  const undoBtn = h('button', { class: 'scr-tool', title: t('app.screen.undo'), onclick: undo, disabled: true }, iconEl('undo-2', 15));
  const redoBtn = h('button', { class: 'scr-tool', title: t('app.screen.redo'), onclick: redo, disabled: true }, iconEl('redo-2', 15));
  function syncHistory() {
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
  }

  // 调色板 + 自定义色（画板用色；文字颜色在图层面板逐条设置）
  const swatchBox = h('div', { class: 'scr-swatches' });
  const colorInp = h('input', { type: 'color', value: color, class: 'color-well', title: t('app.screen.customColor') });
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
  const blockSel = h('select', { class: 'scr-sel', title: t('app.screen.pixelBlock'), 'aria-label': t('app.screen.pixelBlockAria') },
    ...BLOCKS.map((b) => h('option', { value: b, selected: b === 1 }, b === 1 ? t('app.screen.perPixel') : `${b}×${b}`)));
  blockSel.addEventListener('change', () => { block = +blockSel.value; renderFrame(); });

  // ---------- 字体（文字层逐条选择；列表为全部页面共享） ----------
  // 基础字体名同样惰性取词（切语言后重进页面生效）
  const baseFonts = () => [
    { family: 'sans-serif', label: t('app.screen.fontSans') },
    { family: 'serif', label: t('app.screen.fontSerif') },
    { family: 'monospace', label: t('app.screen.fontMono') },
  ];
  let customFonts = []; // [{family,label}]（IndexedDB 恢复 + 会话内加载）
  let lastFont = 'sans-serif'; // 新增文字的默认字体（跟随最近一次选择）
  let fontPickTarget = null;   // 正在为哪条文字加载字体文件
  function buildFontSel(cur) {
    const sel = h('select', { class: 'scr-tsel', title: t('app.screen.font'), 'aria-label': t('app.screen.font') },
      ...baseFonts().map((f) => h('option', { value: f.family }, f.label)),
      ...customFonts.map((f) => h('option', { value: f.family }, f.label)),
      h('option', { value: '__load__' }, t('app.screen.loadFont')));
    sel.value = cur;
    return sel;
  }
  const fontFileInp = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2', style: 'display:none' });
  fontFileInp.addEventListener('change', async () => {
    const file = fontFileInp.files[0];
    fontFileInp.value = '';
    if (!file) { fontPickTarget = null; renderLayers(); return; } // 取消：重建下拉以恢复原选中项
    try {
      const buf = await file.arrayBuffer();
      const { family, label } = await fontlib.saveFont(fontlib.fontLabel(file.name), buf);
      if (!customFonts.some((f) => f.family === family)) customFonts.push({ family, label });
      if (fontPickTarget != null) frames[cur].texts[fontPickTarget].font = family; // 应用到发起加载的那条文字
      lastFont = family;
      renderLayers(); render(); persist();
      // 不 toast：字体下拉即刻出现并选中该项即反馈
    } catch (err) {
      renderLayers();
      toast(t('app.screen.fontLoadFail', { msg: err.message }), true);
    } finally { fontPickTarget = null; }
  });
  async function removeFont(fam) {
    try { await fontlib.deleteFont(fam); } catch { /* 删除失败仅影响下次启动的恢复 */ }
    customFonts = customFonts.filter((f) => f.family !== fam);
    for (const f of frames) f.texts.forEach((t) => { if (t.font === fam) t.font = 'sans-serif'; }); // 引用回退
    if (lastFont === fam) lastFont = 'sans-serif';
    renderLayers(); render(); persist();
  }
  fontlib.restoreFonts().then((list) => {
    if (!list.length) return;
    customFonts = list;
    renderLayers();
  });

  // ---------- 图层面板（当前帧的三个图层：图片 / 画板 / 文字） ----------
  const eyeBtn = (key, label) => {
    const b = h('button', { class: 'scr-eye', onclick: () => {
      const f = frames[cur];
      f.vis[key] = !f.vis[key];
      render(); renderLayers(); persist();
    } });
    b._sync = () => {
      const on = frames[cur].vis[key];
      b.replaceChildren(iconEl(on ? 'eye' : 'eyeOff', 14));
      b.title = on ? t('app.screen.hideLayer', { layer: label }) : t('app.screen.showLayer', { layer: label });
      b.classList.toggle('off', !on);
    };
    return b;
  };
  const imgEye = eyeBtn('img', t('app.screen.layerImgLc'));
  const paintEye = eyeBtn('paint', t('app.screen.layerPaintLc'));
  const textEye = eyeBtn('text', t('app.screen.layerTextLc'));

  // 图层状态与动作（状态让每层有无内容一目了然；动作只作用于对应图层）
  const imgStatus = h('span', { class: 'dim' });
  const paintStatus = h('span', { class: 'dim' });
  const textStatus = h('span', { class: 'dim' });
  const imgImportBtn = h('button', { class: 'scr-mini', onclick: () => imgInp.click() }, iconEl('upload', 12), t('app.screen.importImg'));
  const imgRemoveBtn = h('button', { class: 'scr-mini ghost', title: t('app.screen.removeImgLayer'), onclick: () => {
    pushUndo();
    frames[cur].imgC = null;
    render(); renderLayers(); persist();
  } }, iconEl('x', 11), t('app.common.remove'));
  const paintClearBtn = h('button', { class: 'scr-mini ghost', title: t('app.screen.clearPaintLayer'), onclick: () => {
    pushUndo();
    frames[cur].paintC.getContext('2d').clearRect(0, 0, scr.w, scr.h);
    render(); renderLayers(); persist();
  } }, iconEl('trash-2', 11), t('app.common.clear'));
  const textAddBtn = h('button', { class: 'scr-mini', onclick: addText }, iconEl('plus', 12), t('app.common.add'));

  function addText() {
    const f = frames[cur];
    pushUndo();
    f.texts.push({ s: t('app.screen.layerText'), font: lastFont, size: 24, color, x: scr.w / 2, y: scr.h / 2 });
    f.vis.text = true;
    renderLayers(); renderFrame(); persist();
    const inputs = [...textListBox.querySelectorAll('.scr-tin')];
    inputs[inputs.length - 1]?.focus();
    inputs[inputs.length - 1]?.select();
  }
  function syncTextsToAll() {
    const f = frames[cur];
    for (const g of frames) if (g !== f) { g.texts = cloneTexts(f.texts); g.vis.text = true; }
    persist();
    renderThumbs(); // 其余帧的缩略图随之更新，替代 toast
  }

  // 文字条目行：内容 / 字体 / 字号 / 颜色行内编辑，Enter 提交，画布上拖动定位
  // 「先快照后提交」：focus 记录改动前状态，change（失焦/回车）时若有变化才入撤销栈
  function bindLive(inp, t, key, parse) {
    let snap = null, orig = '';
    inp.addEventListener('focus', () => { snap = snapFrame(); orig = inp.value; });
    inp.addEventListener('input', () => {
      const v = parse(inp.value);
      if (v != null) { t[key] = v; renderFrame(); }
    });
    inp.addEventListener('change', () => {
      if (snap && inp.value !== orig) { pushSnap(snap); persist(); }
      snap = null;
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
  }
  const textListBox = h('div', { class: 'scr-texts' });
  function renderTextItems() {
    const f = frames[cur];
    textListBox.replaceChildren();
    f.texts.forEach((t, k) => {
      const content = h('input', { class: 'scr-tin', value: t.s, maxlength: 40, autocomplete: 'off', spellcheck: 'false' });
      bindLive(content, t, 's', (v) => v);
      const fsel = buildFontSel(t.font);
      fsel.addEventListener('change', () => {
        if (fsel.value === '__load__') { fontPickTarget = k; fontFileInp.click(); return; }
        pushUndo();
        t.font = fsel.value; lastFont = fsel.value;
        renderFrame(); persist();
      });
      const sz = h('input', { type: 'number', class: 'scr-tsz', min: 6, max: 160, value: t.size, inputmode: 'numeric', autocomplete: 'off', title: t('app.screen.fontSize') });
      bindLive(sz, t, 'size', (v) => Math.max(6, Math.min(160, +v || t.size)));
      const col = h('input', { type: 'color', value: t.color, class: 'scr-tcol color-well', title: t('app.screen.textColor') });
      bindLive(col, t, 'color', (v) => v);
      const del = h('button', { class: 'scr-mini ghost', title: t('app.screen.delText'), onclick: () => {
        pushUndo();
        f.texts.splice(k, 1);
        renderLayers(); render(); persist();
      } }, iconEl('x', 12));
      const row = h('div', { class: 'scr-text-item' }, content, fsel,
        t.font.startsWith('khf-') ? h('button', { class: 'scr-mini ghost', title: t('app.screen.delFont'), onclick: () => removeFont(t.font) }, iconEl('trash-2', 11)) : null,
        sz, col, del);
      textListBox.appendChild(row);
    });
    if (f.texts.length) {
      textListBox.appendChild(h('div', { class: 'scr-text-foot dim', text: t('app.screen.dragText') }));
      if (frames.length > 1) {
        textListBox.appendChild(h('div', {},
          h('button', { class: 'scr-mini ghost', onclick: syncTextsToAll }, iconEl('copy', 11), t('app.screen.syncText'))));
      }
    }
  }
  function renderLayers() {
    const f = frames[cur];
    imgEye._sync(); paintEye._sync(); textEye._sync();
    imgStatus.textContent = f.imgC ? t('app.screen.imported') : t('app.screen.notImported');
    imgImportBtn.title = f.imgC
      ? t('app.screen.replaceImg')
      : t('app.screen.uploadImg');
    imgRemoveBtn.disabled = !f.imgC;
    const ink = paintHasInk(f);
    paintStatus.textContent = ink ? t('app.screen.hasStrokes') : t('app.screen.blank');
    paintClearBtn.disabled = !ink;
    textStatus.textContent = f.texts.length ? t('app.screen.textCount', { n: f.texts.length }) : t('app.common.none');
    textListBox.classList.toggle('hidden', !f.texts.length);
    renderTextItems();
  }

  // ---------- 图片 / GIF 导入（只作用于图片层） ----------
  const imgInp = h('input', { type: 'file', accept: 'image/*,.gif', style: 'display:none' });
  // 导入缩放三模式：fit 适应（信箱完整显示，原行为）/ fill 填充（满屏居中裁边）/ stretch 拉伸（无视比例）
  const drawMapped = (c, src, sw, sh, mode) => {
    if (mode === 'stretch') { c.drawImage(src, 0, 0, scr.w, scr.h); return; }
    const r = mode === 'fill' ? Math.max(scr.w / sw, scr.h / sh) : Math.min(scr.w / sw, scr.h / sh);
    const w = sw * r, hh = sh * r;
    c.drawImage(src, (scr.w - w) / 2, (scr.h - hh) / 2, w, hh);
  };
  // GIF 导入模式选择：三张卡用首帧实拍三种缩放的真实效果，选中才亮「导入」；
  // 已有内容时把替换警告并入本弹层（省一次确认框），取消/Esc/点遮罩都不导入。
  function pickGifMode(sample, n, hasContent) {
    return new Promise((resolve) => {
      let sel = 'fit';
      const mask = h('div', { class: 'modal-mask' });
      let unA11y = () => {};
      const close = (v) => { unA11y(); mask.remove(); resolve(v); };
      unA11y = modalA11y(mask, () => close(null));
      const MODES = [
        { id: 'fill', name: t('app.screen.gifFill'), hint: t('app.screen.gifFillHint') },
        { id: 'fit', name: t('app.screen.gifFit'), hint: t('app.screen.gifFitHint') },
        { id: 'stretch', name: t('app.screen.gifStretch'), hint: t('app.screen.gifStretchHint') },
      ];
      const cards = MODES.map((m) => {
        const c = h('canvas', { width: scr.w, height: scr.h });
        drawMapped(c.getContext('2d'), sample, sample.width, sample.height, m.id);
        const card = h('button', { class: 'scr-gm' + (m.id === sel ? ' on' : ''), onclick: () => {
          sel = m.id;
          cards.forEach((x) => x.classList.toggle('on', x === card));
        } }, c, h('b', { text: m.name }), h('span', { text: m.hint }));
        return card;
      });
      const box = h('div', { class: 'modal scr-gmodal' },
        h('h4', { text: t('app.screen.gifImportTitle', { n }) }),
        hasContent ? h('p', { class: 'wiz-note', text: t('app.screen.gifReplaceNote', { gif: n, cur: frames.length }) }) : null,
        h('div', { class: 'scr-gms' }, ...cards),
        h('div', { class: 'm-foot' },
          h('button', { class: 'btn', onclick: () => close(null) }, t('app.common.cancel')),
          h('button', { class: 'btn primary', onclick: () => close(sel) }, t('app.common.import')),
        ),
      );
      mask.addEventListener('click', (e) => { if (e.target === mask) close(null); });
      mask.append(box);
      document.body.appendChild(mask);
    });
  }
  imgInp.addEventListener('change', async () => {
    const file = imgInp.files[0];
    imgInp.value = '';
    if (!file) return;
    const isGif = /\.gif$/i.test(file.name) || file.type === 'image/gif';
    if (isGif) {
      let r;
      try { r = decodeGif(await file.arrayBuffer()); }
      catch (err) { toast(t('app.screen.gifDecodeFail', { msg: err.message }), true); return; }
      if (r.frames.length === 1) { importStatic(r.frames[0].canvas); return; } // 单帧 GIF 按静态图片处理
      const hasContent = frames.length > 1 || frames.some((f) => f.imgC || paintHasInk(f) || f.texts.length);
      const mode = await pickGifMode(r.frames[0].canvas, r.frames.length, hasContent); // 选模式即确认，含替换警告
      if (!mode) return;
      // 超过固件帧上限时均匀抽帧（保住循环首尾）；固件只支持统一帧延时（取众数）。
      // 两条转换提示合并为一条——toast 单例，连弹会互相覆盖
      let picks = r.frames;
      let sampled = false;
      if (picks.length > scr.maxFrames) {
        const sampledArr = [];
        for (let i = 0; i < scr.maxFrames; i++) sampledArr.push(picks[Math.floor(i * picks.length / scr.maxFrames)]);
        picks = sampledArr;
        sampled = true;
      }
      const cnt = {};
      r.frames.forEach((f) => { cnt[f.delay] = (cnt[f.delay] || 0) + 1; });
      const delay = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
      const notes = [];
      if (sampled) notes.push(t('app.screen.sampledNote', { max: scr.maxFrames }));
      if (Object.keys(cnt).length > 1)
        notes.push(t('app.screen.unifiedNote', { ms: delay }));
      pendingLoads.length = 0; // 整体替换：旧帧的异步解码守卫一并作废
      framesReady = true;
      frames.length = 0;
      picks.forEach((p) => {
        const c = blankCanvas();
        drawMapped(c.getContext('2d'), p.canvas, p.canvas.width, p.canvas.height, mode);
        frames.push({ ms: delay, imgC: c, paintC: blankCanvas(), texts: [], vis: { img: true, paint: true, text: true } });
      });
      cur = 0;
      clearHistory();
      rebuildStrip(); renderLayers(); persist();
      // 不 toast 导入成功：胶片栏即刻填满新帧即反馈；采样/延时统一等转换提示合并为上面收集的一条
      if (notes.length) toast('GIF ' + notes.join(t('app.screen.noteSep')), true);
      return;
    }
    const img = new Image();
    img.onload = () => importStatic(img);
    img.onerror = () => toast(t('app.screen.imgDecodeFail'), true);
    img.src = URL.createObjectURL(file);
  });
  // 静态图片 → 当前帧的图片层（画板与文字保留，可撤销；固定适应缩放）
  function importStatic(src) {
    pushUndo();
    const c = blankCanvas();
    drawMapped(c.getContext('2d'), src, src.width, src.height, 'fit');
    const f = frames[cur];
    f.imgC = c; f.vis.img = true;
    render(); renderLayers(); persist();
    // 不 toast：画布与图层状态行即刻显示图片即反馈
  }

  // ---------- 帧序列（底部通栏胶片栏：横向滚动，不与编辑区争纵向空间） ----------
  const strip = h('div', { class: 'scr-strip' });
  const cntEl = h('span', { class: 'scr-cnt' });
  const frameTitle = (i) => t('app.screen.frameTitle', { i: i + 1, ms: Math.round(frames[i].ms) });
  // 当前帧延时集中在栏头编辑（旧版每张卡片一个输入框：80 帧 = 80 个输入框，卡片又高又重）
  msInp = h('input', { type: 'number', class: 'scr-fms', min: 50, max: 60000, step: 50, value: frames[cur].ms,
    inputmode: 'numeric', autocomplete: 'off', title: t('app.screen.msTip'),
    'aria-label': t('app.screen.msAria') });
  msInp.addEventListener('change', () => {
    frames[cur].ms = Math.max(50, Math.min(60000, +msInp.value || 500));
    const el = strip.children[cur]; // 就地更新卡片上的 ms 文案（重建会丢横向滚动位置）
    if (el) {
      const msEl = el.querySelector('.scr-frame-ms');
      if (msEl) msEl.textContent = `${Math.round(frames[cur].ms)}`;
      el.title = frameTitle(cur);
    }
    persist(); renderThumbs();
  });
  const frameBtn = (icon, title, fn) => h('button', { class: 'scr-tool', title, onclick: fn }, iconEl(icon, 14));
  function selectFrame(i) {
    cur = i; clearHistory(); render(); renderLayers();
  }
  function rebuildStrip() {
    cntEl.textContent = `${frames.length}/${scr.maxFrames}`;
    // 达上限禁复制、仅一帧禁删除：空态由按钮本身传达，不再 toast 拦截
    // （copyBtn/delBtn 在下方定义，rebuildStrip 首次调用晚于定义）
    copyBtn.disabled = frames.length >= scr.maxFrames;
    delBtn.disabled = frames.length <= 1;
    strip.replaceChildren(...frames.map((f, i) => h('div', {
      class: 'scr-frame' + (i === cur ? ' on' : ''),
      title: frameTitle(i),
      onclick: () => selectFrame(i),
    },
      h('span', { class: 'scr-frame-no', text: String(i + 1) }),
      h('canvas', { width: scr.w, height: scr.h }),
      h('span', { class: 'scr-frame-ms', text: `${Math.round(f.ms)}` }),
    )));
    if (frames.length < scr.maxFrames) {
      strip.appendChild(h('button', { class: 'scr-add',
        title: t('app.screen.newFrame'), onclick: () => addFrame() }, iconEl('plus', 16)));
    }
    render();
  }
  // 纵向滚轮转横向滚动（胶片栏只横不纵）
  strip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  const copyBtn = frameBtn('copy', t('app.screen.dupFrame'), () => addFrame());
  const delBtn = frameBtn('trash-2', t('app.screen.delFrame'), () => delFrame(cur));
  const framesBar = h('div', { class: 'scr-frames' },
    h('div', { class: 'scr-frames-head' },
      h('h3', { title: t('app.screen.framesTip', { max: scr.maxFrames }) }, t('app.screen.frames')),
      cntEl,
      h('span', { class: 'scr-tsep' }),
      h('span', { class: 'dim', text: t('app.screen.delayLabel') }),
      msInp,
      h('span', { class: 'dim', text: 'ms' }),
      copyBtn,
      delBtn,
      frameBtn('rotateCcw', t('app.screen.clearAllFrames'), () => clearFrames()),
    ),
    strip,
  );
  function addFrame() {
    const src = frames[cur];
    frames.splice(cur + 1, 0, {
      ms: src.ms, imgC: cloneCanvas(src.imgC), paintC: cloneCanvas(src.paintC),
      texts: cloneTexts(src.texts), vis: { ...src.vis },
    }); // 复制当前帧内容，便于渐进步骤动画
    cur++;
    clearHistory();
    rebuildStrip(); renderLayers(); persist();
  }
  function delFrame(i) {
    frames.splice(i, 1);
    cur = Math.min(cur, frames.length - 1);
    clearHistory();
    rebuildStrip(); renderLayers(); persist();
  }
  async function clearFrames() {
    const hasContent = frames.length > 1 || frames.some((f) => f.imgC || paintHasInk(f) || f.texts.length);
    if (hasContent && !(await confirmBox(
      t('app.screen.clearFramesTitle'),
      t('app.screen.clearConfirm', { n: frames.length })))) return;
    pendingLoads.length = 0; // 整体替换：旧帧的异步解码守卫一并作废
    framesReady = true;
    frames.length = 0;
    frames.push({ ms: 500, imgC: null, paintC: blankCanvas(), texts: [], vis: { img: true, paint: true, text: true } });
    cur = 0;
    clearHistory();
    rebuildStrip(); renderLayers(); persist();
  }

  // ---------- 预览 ----------
  const playBtn = h('button', { class: 'btn', onclick: togglePlay }, iconEl('play', 14), t('app.common.preview'));
  function togglePlay() {
    playing = !playing;
    playBtn.classList.toggle('primary', playing);
    if (playing) {
      playBtn.replaceChildren(iconEl('square', 14), t('app.common.stop'));
      const step = () => {
        if (!playing) return;
        cur = (cur + 1) % frames.length;
        renderFrame();
        activePlayTimer = setTimeout(step, Math.max(50, frames[cur].ms));
      };
      step();
    } else {
      if (activePlayTimer) { clearTimeout(activePlayTimer); activePlayTimer = 0; }
      playBtn.replaceChildren(iconEl('play', 14), t('app.common.preview'));
      render();
    }
  }

  // ---------- 烧录 ----------
  // 进度条 = 百分比 + 倒计时 + 细条；ETA 按整体平均帧耗时外推（每帧开销恒定，整体均值比逐帧更稳）
  const progTxt = h('span', { class: 'scr-prog-txt', text: '0%' });
  const progBar = h('div', { class: 'scr-prog-bar' });
  const prog = h('div', { class: 'scr-prog hidden' }, progTxt, h('div', { class: 'scr-prog-track' }, progBar));
  const fmtEta = (ms) => {
    const s = Math.max(1, Math.ceil(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const burnBtn = h('button', { class: 'btn primary', onclick: burn, disabled: !framesReady }, iconEl('send', 14), t('app.keys.writeKeyboard'));
  const abortBtn = h('button', { class: 'btn hidden', onclick: () => { abortBurn = true; } }, t('app.common.cancel'));
  // 帧图层还在 PNG 解码时禁用写入（空态由按钮本身传达，不再 toast 拦截）；烧录中不参与启停
  syncBurnBtn = () => { if (!burning) burnBtn.disabled = !framesReady; };
  const packFrames = () => frames.map((_, i) => F.rgb565Pack(rasterFrame(i).getContext('2d').getImageData(0, 0, scr.w, scr.h)));
  async function burn() {
    if (burning) return;
    if (playing) togglePlay();
    if (device.mode !== 'hid') {
      toast(t('app.screen.demoNoWrite'), true);
      return;
    }
    // 会话里没有任何有线接口（主接口可能是 2.4G 接收器）才拒——有线+接收器并存时
    // 烧录照常，bestForScreen 会路由到声明 feat520 的有线接口
    if (!device.hasWiredIface()) {
      toast(t('app.screen.needWired'), true);
      return;
    }
    if (new Set(frames.map((f) => Math.round(f.ms))).size > 1) {
      toast(t('app.screen.unifiedDelay'), false);
    }
    // 覆盖式写入键盘屏幕（秒级传输），保留一步确认
    if (!(await confirmBox(
      t('app.screen.burnTitle'),
      t('app.screen.burnConfirm', { n: frames.length })))) return;
    burning = true; abortBurn = false;
    sentCount = 0;
    burnStart = performance.now();
    hideResume(); // 新一轮写入开始：清掉旧的中断提示
    if (!framesReady) { burning = false; return; } // 防御：按钮禁用后正常不可达
    burnBtn.disabled = true; abortBtn.classList.remove('hidden');
    prog.classList.remove('hidden');
    const setProg = (done, total) => {
      const pct = Math.round(done * 100 / total);
      progBar.style.width = `${pct}%`;
      // 首帧含 SetGIFParam 握手会高估耗时，从第 2 帧起才按整体均值外推倒计时
      let eta = '';
      if (done >= 2 && done < total) {
        eta = ' · ' + t('app.screen.eta', { eta: fmtEta((performance.now() - burnStart) / done * (total - done)) });
      }
      progTxt.textContent = `${pct}%${eta}`;
    };
    setProg(0, 1);
    try {
      const res = await device.burnScreen(packFrames(), {
        delays: frames.map((f) => f.ms),
        onProgress: (done, total) => { sentCount = done; setProg(done, total); }, // done = 已发帧数
        shouldAbort: () => abortBurn,
      });
      if (res.error === 'no-iface') toast(t('app.screen.noIface'), true);
      else if (res.error === 'no-ack') toast(t('app.screen.noAck'), true);
      else if (res.sim) toast(t('app.screen.simDone'));
      else if (res.sent) { hideResume(); toast(t('app.screen.sent', { frames: res.frames, chunks: res.chunks })); }
      else {
        // 中断/取消且已有部分帧发出：留一键续传入口（见下方断点续传条）
        if (sentCount > 0 && sentCount < frames.length) showResume(sentCount);
        toast(t('app.screen.burnIncomplete'), true);
      }
    } finally {
      burning = false;
      burnBtn.disabled = false;
      abortBtn.classList.add('hidden');
      setTimeout(() => prog.classList.add('hidden'), 800);
    }
  }

  // ---------- 断点续传（自动记录中断进度，一键让键盘播放已收到的帧） ----------
  // 中断进度来自烧录 onProgress 的实时帧计数，用户无需手填任何参数；
  // 收尾命令 = SetGIFParam(cmd 0x0D, 帧数=已发数, 延时=首帧值)，反汇编实证的恢复手段。
  let sentCount = 0;        // 本次烧录已发帧数（onProgress 实时更新）
  let interrupted = null;   // { frames, delay }：烧录中断后待收尾的进度
  const resumeBar = h('div', { class: 'scr-resume hidden' });
  function showResume(n) {
    interrupted = { frames: n, delay: Math.round(frames[0].ms) };
    resumeBar.replaceChildren(
      iconEl('triangleAlert', 14),
      h('span', { class: 'scr-resume-txt', text: t('app.screen.stoppedAt', { done: n, total: frames.length }) }),
      h('button', { class: 'scr-mini', onclick: finishResume }, iconEl('play', 11), t('app.screen.playSent', { n })),
      h('button', { class: 'scr-mini ghost', title: t('app.screen.dismiss'), onclick: hideResume }, iconEl('x', 12)),
    );
    resumeBar.classList.remove('hidden');
  }
  function hideResume() {
    interrupted = null;
    resumeBar.classList.add('hidden');
  }
  async function finishResume() {
    const n = interrupted?.frames;
    if (n == null) return;
    const r = await device.setGifParam(0, n, interrupted.delay);
    hideResume();
    if (device.mode !== 'hid') return; // 烧录中断后设备已断开：续传条已隐藏，静默收场
    if (r === 1) toast(t('app.screen.loopRecv', { n }));
    else toast(t('app.screen.finishNoAck'), true);
  }

  // ---------- 快捷键（Ctrl+Z/Y 撤销重做；单键切换画板工具） ----------
  activeKeyHandler = (e) => {
    if (playing || burning || gated) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_KEYS[k]) pickTool(TOOL_KEYS[k]);
  };
  window.addEventListener('keydown', activeKeyHandler);

  // ---------- 布局 ----------
  // 画布（9:16 竖屏）进驻键盘舞台左侧（.scr-mode，cleanup 时还原）：舞台高度与其它页一致，
  // 画布卡居左、设备预览居右；面板与舞台镜像：左列帧序列胶片栏 + 烧录动作（吃余宽，时间线尽量长），
  // 右列工具+图层卡（定宽）；断点续传条（仅中断后出现）贴在动作列底部。
  const layerRow = (eye, icon, name, status, ...acts) => h('div', { class: 'scr-layer' },
    eye,
    h('span', { class: 'scr-layer-ic' }, iconEl(icon, 14)),
    h('span', { class: 'scr-layer-main' }, h('span', { class: 'scr-layer-name', text: name }), status),
    ...acts,
  );
  const stage = document.querySelector('.kb-stage');
  stage?.classList.add('scr-mode');
  // 无线门控遮罩（页面区一张完整提示卡，画布区一张简短版盖住落笔）：
  const edGate = h('div', { class: 'scr-gate-ed hidden' },
    iconEl('plug', 22),
    h('span', { text: t('app.screen.wiredNeeded') }),
  );
  stage?.prepend(h('div', { class: 'scr-editor' },
    h('div', { class: 'scr-cvwrap' },
      cv,
      dimEl = h('span', { class: 'scr-dim', text: `${scr.w}×${scr.h}` }),
    ),
    edGate,
  ));
  const page = h('div', { class: 'page-inner scr-page' },
    h('div', { class: 'scr-side' },
      framesBar,
      h('div', { class: 'scr-actions' }, playBtn, burnBtn, abortBtn, prog),
      resumeBar,
    ),
    h('div', { class: 'scr-panel' },
      h('div', { class: 'scr-toolbar' },
        toolBox,
        h('span', { class: 'scr-tsep' }),
        undoBtn, redoBtn,
      ),
      h('div', { class: 'scr-toolbar' },
        blockSel,
        h('span', { class: 'scr-tsep' }),
        h('div', { class: 'scr-colors' }, swatchBox, colorInp),
      ),
      h('div', { class: 'scr-sep' },
        h('span', { class: 'scr-rowlbl', title: t('app.screen.layersTip') },
          iconEl('layers', 12), t('app.screen.layers')),
      ),
      layerRow(imgEye, 'image', t('app.screen.layerImg'), imgStatus, imgImportBtn, imgRemoveBtn),
      layerRow(paintEye, 'paintbrush', t('app.screen.layerPaint'), paintStatus, paintClearBtn),
      layerRow(textEye, 'type', t('app.screen.layerText'), textStatus, textAddBtn),
      textListBox,
    ),
  );
  for (const inp of [imgInp, fontFileInp]) {
    inp.style.display = 'none';
    page.appendChild(inp);
  }
  // 无线门控：2.4G 会话无 feat520 数据通道，屏幕功能（编辑+烧录）整体不可用。
  // 真机但无有线接口才遮——演示模式不遮（本来就是体验用）；插线并入有线接口后
  //（connect.js mergeNewIfaces → emit 'device'）遮罩自动揭开，无需重进页面。
  const pgGate = h('div', { class: 'scr-gate hidden' },
    iconEl('plug', 30),
    h('b', { text: t('app.screen.wiredOnly') }),
    h('span', { class: 'dim', text: t('app.screen.wiredOnlyNote') }),
  );
  page.appendChild(pgGate);
  const syncGate = () => {
    gated = device.mode === 'hid' && !device.hasWiredIface();
    pgGate.classList.toggle('hidden', !gated);
    edGate.classList.toggle('hidden', !gated);
  };
  activeGateUnsub = on('device', syncGate);
  syncGate();
  root.appendChild(page);
  rebuildStrip();
  renderLayers();
}

export function cleanupScreenPage() {
  // 预览定时器是跨渲染存活的模块级链——切页时必须掐断，否则空转渲染已脱离 DOM 的画布
  if (activePlayTimer) { clearTimeout(activePlayTimer); activePlayTimer = 0; }
  if (activeKeyHandler) { window.removeEventListener('keydown', activeKeyHandler); activeKeyHandler = null; }
  activeGateUnsub?.(); // 'device' 订阅随之退订（遮罩节点已随页面移除）
  activeGateUnsub = null;
  activePersistFlush?.(); // 防抖中的未落盘编辑立即冲刷，防丢
  activePersistFlush = null;
  // 舞台还原：摘 .scr-mode、移除进驻的画布卡（键盘预览卡恢复独占舞台）
  const stage = document.querySelector('.kb-stage');
  stage?.classList.remove('scr-mode');
  stage?.querySelector(':scope > .scr-editor')?.remove();
}
export { cleanupScreenPage as cleanup };
