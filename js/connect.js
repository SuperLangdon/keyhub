// 主页连接中心：键盘灯波动画（无设备空态）+ 设备卡片列表 + 「添加新设备」向导
// 型号识别：所有型号共用 VID/PID，但固件支持 GetPSD 查询（report ID 0x05，逆向自原驱动
// OemDrv.exe 的 GetPassword）——连上后读 6 字节 PSD 与 index.json 各型号 psd 匹配；
// 识别失败（无响应 / PSD 未知）时回退为用户手动选型号。
// 添加的设备记录（slug + 通道）与各型号配置均保存在 localStorage，点卡片进入设置。
import { h, toast } from './ui.js';
import { iconEl } from './ui-icons.js';
import { L } from './i18n.js';
import { state, save } from './store.js';
import { device, hidReady, onDevLog, getLogs, clearLogs } from './device/index.js';

function vidPid(dev) {
  return `${dev.vendorId.toString(16).padStart(4, '0')}:${dev.productId.toString(16).padStart(4, '0')}`;
}
function devLabel(dev) {
  return `${dev.productName || 'Keyboard'} (${vidPid(dev)})`;
}

// ---------- 型号索引 ----------
let idxPromise = null;
function modelIndex() {
  if (!idxPromise) {
    idxPromise = fetch('assets/models/index.json').then((r) => r.json())
      .catch((e) => { idxPromise = null; throw e; }); // 失败不缓存：下次调用重试
  }
  return idxPromise;
}

// PSD（6 字节）↔ 型号匹配：与 index.json 各型号 psd（十六进制，来自 KB.ini 的 Psd=）逐字节全等
function matchModelByPsd(psd, idx) {
  if (!psd || psd.length !== 6) return null;
  return idx.find((m) => Array.isArray(m.psd) && m.psd.length === 6 && m.psd.every((b, i) => b === psd[i])) ?? null;
}

// 设备名识别（备用）：USB 产品字符串 ↔ index.json 的 name（KB.ini Name=）/ short 比对。
// 全等 > 包含（取最长命中，如 "Hi75 RGB Keyboard" 优先于 "Hi75"）；命中歧义返回 null
// （Hi98 与 Hi98 3-Mode 同名 "Hi98 Keyboard"，需手动二选一）。
function matchModelByName(productName, idx) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const p = norm(productName);
  if (!p) return null;
  const scored = [];
  for (const m of idx) {
    const n = norm(m.name), sh = norm(m.short);
    let score = 0;
    if (n && p === n) score = 1000;
    else if (n && (p.includes(n) || n.includes(p))) score = n.length;
    else if (sh && p.includes(sh)) score = sh.length;
    if (score > 0) scored.push({ m, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return scored[0].m;
}

// 3632 应答块滑窗匹配（有线识别兜底）：在 blob 中查找与任一型号 psd 全等的连续 6 字节。
// PSD 在应答中的偏移未经抓包确定；滑窗 + 型号表双重校验（9 型号 PSD 互不相同）足够安全。
// 命中多个不同型号 → null（防止误配）。
function matchModelByBlob(blob, idx) {
  if (!blob || blob.length < 6) return null;
  const hits = new Set();
  for (let off = 0; off + 6 <= blob.length; off++) {
    for (const m of idx) {
      if (!Array.isArray(m.psd) || m.psd.length !== 6) continue;
      let ok = true;
      for (let i = 0; i < 6; i++) if (blob[off + i] !== m.psd[i]) { ok = false; break; }
      if (ok) hits.add(m.slug);
    }
  }
  if (hits.size !== 1) return null;
  return idx.find((m) => m.slug === [...hits][0]);
}

// ---------- 设备记录（localStorage 持久化） ----------
// channel 只存实际通道 'wired' | 'wireless'（选择「自动」连接后按 VID/PID 识别）
function chanName(ch) {
  return { wired: L('有线', 'Wired'), wireless: L('2.4G 无线', '2.4G wireless'), any: L('自动', 'Auto') }[ch] ?? ch;
}
function addDeviceRecord(meta, channel) {
  const ch = channel === 'wireless' ? 'wireless' : 'wired'; // 旧记录兼容：unknown/any 一律按有线显示
  const id = `${meta.slug}|${ch}`;
  const exists = state.devices.some((d) => d.id === id);
  if (!exists) state.devices.push({ id, slug: meta.slug, channel: ch });
  save();
  return !exists;
}

// 演示设备记录：与普通设备同列表，仅标 demo（无通道），点卡片进模拟器
export function addDemoRecord(meta) {
  const id = `${meta.slug}|demo`;
  if (!state.devices.some((d) => d.id === id)) state.devices.push({ id, slug: meta.slug, demo: true });
  save();
}
function removeDevice(id) {
  state.devices = state.devices.filter((d) => d.id !== id);
  save();
}

// ---------- 键盘动画：75% 配列示意，蓝色灯波从左向右扫掠（对应原驱动「请连接设备」页） ----------
const ROWS = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
  [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5],
  [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.25, 1],
  [2.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.25, 1.5],
  [1.25, 1.25, 1.25, 6.25, 1.25, 1.25, 1.25, 1],
];
const UNITS = 15, ROWS_N = ROWS.length;

class KbAnim {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.keys = [];
    ROWS.forEach((row, ry) => {
      let x = 0;
      for (const w of row) {
        this.keys.push({ x, y: ry, w, seed: Math.random() * Math.PI * 2, shim: Math.random() });
        x += w;
      }
    });
    this.refreshPalette();
    new MutationObserver(() => this.refreshPalette())
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (canvas.parentElement) new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  refreshPalette() {
    const cs = getComputedStyle(document.documentElement);
    const pick = (n, fb) => cs.getPropertyValue(n).trim() || fb;
    this.dark = document.documentElement.dataset.theme === 'dark';
    this.caseLine = pick('--hairline-strong', '#cfcdc4');
    this.keyLine = pick('--hairline', '#e6e5e0');
    // 设备灯光本体是蓝色 LED（与原驱动连接页一致），不随主题强调色走
    this.blueRGB = this.dark ? '95,141,255' : '59,108,240';
  }

  resize() {
    const host = this.cv.parentElement;
    const w = Math.max(host.clientWidth, 240);
    const hgt = Math.round(w * ((ROWS_N + 1.6) / (UNITS + 0.75))); // 上下留足浮动与指示灯空间
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(hgt * dpr);
    this.cv.style.height = hgt + 'px';
    this.w = w; this.h = hgt; this.dpr = dpr;
    if (this.reduce) this.draw(performance.now());
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    if (this.cv.offsetParent === null) return; // 空态动画不可见（已有设备卡片）时不画
    this.draw(now);
  }

  draw(now) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const u = this.w / (UNITS + 0.75);          // 键距（css px）
    const gap = Math.max(2, u * 0.09);
    const bx = u * 0.375, by = u * 0.55;        // 外壳左右 / 上下沿
    const caseW = UNITS * u + bx * 2, caseH = ROWS_N * u + by * 2;
    const cx0 = (this.w - caseW) / 2;
    const cy0 = (this.h - caseH) / 2 + (this.reduce ? 0 : Math.sin(now / 1700) * 3.5);

    // 外壳
    ctx.beginPath();
    ctx.roundRect(cx0, cy0, caseW, caseH, u * 0.3);
    ctx.fillStyle = this.dark ? 'rgba(233,231,222,0.03)' : 'rgba(38,37,30,0.025)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.caseLine;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 灯波：主波从左向右扫 + 少量散键随机呼吸
    const waveX = cx0 - 160 + ((now / 1000) * 92) % (caseW + 320);
    const sigma = u * 1.55;

    for (const k of this.keys) {
      const kx = cx0 + bx + k.x * u;
      const ky = cy0 + by + k.y * u;
      const kw = k.w * u - gap, kh = u - gap;
      const mid = kx + kw / 2;
      const dg = Math.exp(-((mid - waveX) ** 2) / (2 * sigma * sigma));
      const sh = k.shim < 0.3 ? Math.max(0, Math.sin(now / 680 + k.seed)) ** 16 : 0;
      const g = Math.min(1, dg + sh * 0.9);

      ctx.beginPath();
      ctx.roundRect(kx, ky, kw, kh, Math.min(4, u * 0.12));
      ctx.fillStyle = this.dark ? 'rgba(233,231,222,0.045)' : 'rgba(38,37,30,0.03)';
      ctx.fill();
      if (g > 0.03) {
        ctx.shadowColor = `rgb(${this.blueRGB})`;
        ctx.shadowBlur = 20 * g;
        ctx.fillStyle = `rgba(${this.blueRGB},${(0.14 + 0.6 * g).toFixed(3)})`;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.strokeStyle = this.keyLine;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 两颗指示灯（左上 / 右下，对应原驱动渲染图的蓝色指示块），交替呼吸
    const iw = u * 1.9, ih = u * 0.2;
    for (const [px, py, ph] of [
      [cx0 + bx, cy0 + (by - ih) / 2, 0],
      [cx0 + caseW - bx - iw, cy0 + caseH - by + (by - ih) / 2, Math.PI],
    ]) {
      const pulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(now / 850 + ph));
      ctx.beginPath();
      ctx.roundRect(px, py, iw, ih, ih / 2);
      ctx.shadowColor = `rgb(${this.blueRGB})`;
      ctx.shadowBlur = 14 * pulse;
      ctx.fillStyle = `rgba(${this.blueRGB},${(0.25 + 0.65 * pulse).toFixed(3)})`;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

// ---------- Hero 渲染 ----------
let onEnterApp = null;
let anim = null;
let els = null;

export function initConnectHero(onEnter) {
  onEnterApp = onEnter;
  const host = document.getElementById('conn-hero');
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  els = {
    visual: h('div', { class: 'conn-visual' }, canvas),
    cards: h('div', { class: 'device-grid' }),
    actions: h('div', { class: 'conn-actions' }),
    title: h('h2', { class: 'conn-title' }),
    hint: h('p', { class: 'conn-hint' }),
  };
  // 先入 DOM，KbAnim 才有父容器可观测尺寸。
  // 空态阅读流：动画 → 标题 → 提示 → CTA；有设备时提示移到 CTA 下方作脚注（见 render）
  host.append(els.visual, els.cards, els.title, els.hint, els.actions);
  anim = new KbAnim(canvas);
  render();
  return { refresh: render };
}

function setActions(...btns) {
  els.actions.replaceChildren(...btns.filter(Boolean));
}

function render() {
  const devices = state.devices;
  const has = devices.length > 0;
  els.visual.classList.toggle('hidden', has);
  els.cards.classList.toggle('hidden', !has);
  // 空态：动画 → 标题 → 提示 → CTA（按钮不再贴着动画）；有设备：卡片 → CTA → 提示脚注
  els.actions.style.marginTop = has ? '44px' : '32px';
  if (has) {
    els.title.classList.add('hidden');
    els.actions.after(els.hint);
  } else {
    els.title.classList.remove('hidden');
    els.actions.before(els.hint);
  }
  setActions(h('button', { class: 'conn-cta', onclick: addDevice, disabled: !!addBusy },
    addBusy ? h('span', { class: 'conn-spin' }) : iconEl('plus', 16),
    addBusy ?? L('添加新设备', 'Add new device')));

  if (has) {
    Promise.all(devices.map(deviceCard)).then((cards) => {
      if (cards.length === state.devices.length) els.cards.replaceChildren(...cards);
    });
    els.hint.textContent = L('点击设备卡片进入设置，「添加新设备」可添加多个设备。蓝牙模式无法被识别，请使用 2.4G 接收器或连接线。',
      'Click a device card to configure it; "Add new device" adds more. Bluetooth is not supported — use the 2.4G dongle or a cable.');
  } else {
    els.cards.replaceChildren();
    els.title.textContent = L('请连接设备', 'Connect your device');
    els.hint.textContent = L('点击「添加新设备」，连接键盘后自动识别型号（也可手动选择；有线 / 2.4G 接收器）。蓝牙模式无法被识别，请使用 2.4G 接收器或连接线。',
      'Click "Add new device" — the model is detected automatically once connected (manual pick also works; wired / 2.4G dongle). Bluetooth is not supported — use the 2.4G dongle or a cable.');
  }
}

// ---------- 设备卡片 ----------
// 电量缓存：键盘 2.4G 闲置会快睡，频繁查询只会超时，按分钟级节流
const batteryCache = { at: 0, val: null };

async function deviceCard(rec) {
  const idx = await modelIndex();
  const meta = idx.find((m) => m.slug === rec.slug);
  const short = meta?.short ?? rec.slug;
  const wireless = rec.channel === 'wireless';
  const battSlot = h('span', { class: 'dc-batt hidden' });
  const card = h('div', { class: 'device-card', title: L('点击进入设置', 'Click to open settings') },
    h('div', { class: 'dc-img' }, h('img', { src: `assets/models/${rec.slug}/keyimg.png`, alt: short })),
    h('div', { class: 'dc-body' },
      h('div', { class: 'dc-top' },
        h('div', { class: 'dc-title' },
          h('b', { class: 'dc-name', text: short }),
          rec.demo ? h('span', { class: 'dc-tag', text: L('演示', 'Demo') }) : null,
          h('span', { class: 'dc-sub', text: meta?.sub ?? '' }),
        ),
        h('button', { class: 'dc-x', title: L('移除设备', 'Remove device') }, iconEl('x', 14)),
      ),
      h('div', { class: 'dc-meta' },
        h('span', {
          class: 'dc-icons',
          title: rec.demo ? L('演示模式（模拟器）', 'Demo mode (simulator)')
            : wireless ? L('2.4G 无线', '2.4G wireless') : L('有线连接', 'Wired'),
        }, iconEl(rec.demo ? 'play' : wireless ? 'wifi' : 'plug', 16), battSlot),
      ),
    ),
  );
  card.addEventListener('click', () => openDevice(rec));
  card.querySelector('.dc-x').addEventListener('click', (e) => {
    e.stopPropagation();
    removeDevice(rec.id);
    toast(L(`已移除 ${short}`, `Removed ${short}`));
    render();
  });
  // 电量：仅无线卡片 + 真机已连接时查询（0x4A，休眠无响应则不显示）
  if (wireless && device.mode === 'hid') {
    const cached = Date.now() - batteryCache.at < 60_000 ? batteryCache.val : undefined;
    Promise.resolve(cached ?? device.readBattery()).then((b) => {
      if (cached === undefined) Object.assign(batteryCache, { at: Date.now(), val: b });
      if (!b) return;
      battSlot.replaceChildren(iconEl('battery', 15), h('span', { class: 'dc-batt-pct', text: `${b.percent}%` }));
      battSlot.classList.remove('hidden');
    });
  }
  return card;
}

// 点设备卡片：真机卡片先尝试静默重连已授权的设备（不弹窗，取消/失败按当前模式进入；
// 已授权的多个接口全部打开，识别命令可能只在其中一个上）；
// 演示卡片 = 纯模拟器：不重连，且真机仍连接着时先断开，避免演示会话误向硬件下发
async function openDevice(rec) {
  const meta = (await modelIndex()).find((m) => m.slug === rec.slug);
  if (!meta) { toast(L('该型号的数据文件缺失', 'Model data missing'), true); return; }
  if (rec.demo) {
    if (device.mode === 'hid') device.disconnect();
  } else if (device.mode !== 'hid' && hidReady()) {
    const opened = [];
    for (const known of await device.knownDevices()) {
      try { if (!known.opened) await known.open(); opened.push(known); }
      catch { /* 单个接口打开失败则跳过 */ }
    }
    if (opened.length) device.attach(opened[0], opened.slice(1));
  }
  onEnterApp(meta);
}

// ---------- 添加设备：点击即弹 HID 请求 → 自动识别型号 → 确认框（识别错了可转手动；识别失败转手动） ----------
let addBusy = null; // 连接/识别期间 CTA 的忙碌文案

async function addDevice() {
  if (addBusy) return;
  if (!hidReady()) {
    toast(L('当前浏览器不支持 WebHID（需 Chrome/Edge，经 localhost 或 HTTPS 访问），无法连接真机；可用右上角「演示模式」先体验。',
      'This browser has no WebHID (needs Chrome/Edge over localhost or HTTPS). Try demo mode from the top-right instead.'), true);
    return;
  }

  try {
    addBusy = L('连接中…', 'Connecting…'); render();
    let granted = null;
    try {
      granted = await device.requestConnect('any'); // 自动弹出浏览器 HID 选择框（无过滤，选哪行连哪个）
    } catch (e) {
      toast(L('连接失败：', 'Connect failed: ') + e.message, true);
      return;
    }
    if (!granted?.length) { toast(L('未选择设备', 'No device selected')); return; }
    let devs = await mergeKnown(granted);
    let chan = device.channelOf(devs[0]) ?? 'wired';

    // 识别 → 确认框 →（手动向导 → 重连/回退自动）循环，直到 添加 / 取消
    while (true) {
      addBusy = L('识别型号中…', 'Identifying…'); render();
      const { psd, reason, blob } = await device.readPsdAny(devs);
      const idx = await modelIndex();
      let meta = psd ? matchModelByPsd(psd, idx) : null;
      if (!meta && blob) meta = matchModelByBlob(blob, idx);
      if (!meta) {
        const named = devs.map((d) => d.productName).find(Boolean);
        meta = matchModelByName(named, idx);
        if (meta) toast(L(`已按设备名识别为 ${meta.short}（PSD 通道不可用）`, `Identified as ${meta.short} by device name (PSD channel unavailable)`));
      }
      addBusy = null;

      let preset = null, failed = null;
      if (meta) {
        // 识别成功 → 确认框：确认添加 / 识别错了转手动 / 取消
        const v = await openConfirmAdd(meta, devs, chan);
        if (v === true) { finishAdd(meta, devs, chan); return; }
        if (v == null) { closeDevs(devs); return; }
        preset = meta; // 用户判定识别错误 → 进手动向导（预选高亮供改选）
      } else {
        if (psd) toast(L('读到未知 PSD，未匹配到型号，请手动选择', 'Unknown PSD — no model matched, pick it manually'), true);
        else if (reason === 'no-report') toast(L(`已授权的 ${devs.length} 个接口均未声明识别报告：若选择弹窗里还有其他行请换行再连；若已无行可选，此键盘的识别接口可能无法被浏览器访问，请手动选型号，并把 HID 调试台日志反馈给开发者`,
          `None of the ${devs.length} granted interfaces declares the identify report — if the picker still has other rows, retry with another one; otherwise this keyboard's identify interface may be unreachable from the browser. Pick the model manually and share the HID console log`), true);
        else if (reason === 'send-failed') toast(L('识别命令被设备接口拒绝——弹窗里若有多行设备请换一行再连（授权会累积）；详情见 HID 调试台，或手动选择型号',
          'The identify command was rejected by this interface — if the picker listed multiple rows, retry with another one (grants accumulate); see the HID console, or pick the model manually'), true);
        else toast(L('键盘未响应识别查询：2.4G 请先按任意键唤醒键盘；有线连接若弹窗里有多行设备，请逐行授权再连（会累积，命令通道往往在其中一行）——仍失败可手动选择型号',
          'No reply to the identify query — on 2.4G press a key to wake the keyboard first; when wired, if the picker lists several rows grant them one by one and retry (grants accumulate — the command channel is usually on another row); otherwise pick the model manually'), true);
        failed = { psd: !!psd, reason, count: devs.length, name: devs.map((d) => d.productName).find(Boolean) };
      }

      render();
      const r = await openManualWizard({ preset, failed, devs, chan });
      if (!r) return; // 向导内取消（连接已由向导关闭）
      if (r.type === 'add') { finishAdd(r.meta, r.devs, r.chan); return; }
      devs = r.devs; chan = r.chan; // 'auto'：带着（可能重连过的）连接回到识别循环
    }
  } catch (e) {
    // 兜底：任何异常都不能把 CTA 卡在忙碌态
    toast(L('流程出错：', 'Something went wrong: ') + (e?.message ?? e), true);
  } finally {
    addBusy = null;
    render();
  }
}

// 合并此前授权过的接口（Chrome 授权持久化；识别命令可能只在其中某个接口上）
async function mergeKnown(granted) {
  const devs = [...granted];
  for (const k of await device.knownDevices()) {
    if (devs.includes(k)) continue;
    try { if (!k.opened) await k.open(); devs.push(k); }
    catch { /* 旧接口打不开则跳过 */ }
  }
  return devs;
}

function closeDevs(devs) {
  for (const d of devs) { try { d.close(); } catch { /* 未收编的句柄直接关闭 */ } }
}

function finishAdd(meta, devs, chan) {
  const primary = device.bestForLights(devs) ?? devs[0];
  device.attach(primary, devs.filter((x) => x !== primary));
  const added = addDeviceRecord(meta, chan); // 添加后回到主页设备列表，点卡片进入设置
  toast(added
    ? L(`已连接 ${meta.short}（${chanName(chan)}）`, `Connected to ${meta.short} (${chanName(chan)})`)
    : L(`${meta.short} 已在设备列表中`, `${meta.short} is already in the list`));
  // 有线个别接口无任何 output 报文（0x13 帧发不出去）：提示灯光/配置无法下发
  if (!device.canSend13()) {
    toast(L('注意：当前接口没有 0x13 输出通道，灯光/配置无法下发到键盘——建议改用 2.4G 接收器连接',
      'Note: this interface has no 0x13 output channel — lighting/config cannot be sent to the keyboard. Prefer the 2.4G dongle'), true);
  }
  render();
}

// 识别结果确认框：返回 true=确认添加、'manual'=识别错了转手动、null=取消
function openConfirmAdd(meta, devs, chan) {
  return new Promise((resolve) => {
    const close = (v) => { mask.remove(); resolve(v); };
    const mask = h('div', { class: 'modal-mask' });
    const primary = device.bestForLights(devs) ?? devs[0];
    const box = h('div', { class: 'modal cfm' },
      h('h4', {}, L('已识别设备', 'Device identified')),
      h('div', { class: 'cfm-body' },
        h('div', { class: 'cfm-img' }, h('img', { src: `assets/models/${meta.slug}/keyimg.png`, alt: meta.short })),
        h('div', { class: 'cfm-info' },
          h('b', { class: 'cfm-name', text: meta.short }),
          h('span', { class: 'dc-sub', text: meta.sub }),
          h('div', { class: 'cfm-kv' },
            h('span', { class: 'dc-icons' },
              iconEl(chan === 'wireless' ? 'wifi' : 'plug', 14),
              h('span', { text: chanName(chan) })),
            h('span', { class: 'wc-desc', text: vidPid(primary).toUpperCase() }),
            devs.length > 1 ? h('span', { class: 'wc-desc', text: L(`${devs.length} 个接口`, `${devs.length} interfaces`) }) : null,
          ),
          primary.productName ? h('div', { class: 'cfm-name-str', text: L(`设备名称：${primary.productName}`, `Device name: ${primary.productName}`) }) : null,
        ),
      ),
      h('div', { class: 'wiz-foot' },
        h('button', { class: 'btn', onclick: () => close('manual') }, L('识别错了？手动选择', 'Wrong? Pick manually')),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn', onclick: () => close(null) }, L('取消', 'Cancel')),
        h('button', { class: 'btn primary', onclick: () => close(true) }, L('确认添加', 'Confirm')),
      ),
    );
    box.addEventListener('click', (e) => e.stopPropagation());
    mask.addEventListener('click', () => close(null));
    mask.append(box);
    document.body.appendChild(mask);
  });
}

// 型号选择网格：点选回调 onSel(meta)，选中态高亮由这里统一处理
function modelGrid(onSel) {
  const wrap = h('div', { class: 'wiz-models' });
  modelIndex().then((idx) => {
    for (const m of idx) {
      const card = h('button', { class: 'wiz-model', type: 'button' },
        h('img', { src: `assets/models/${m.slug}/keyimg.png`, alt: m.short }),
        h('b', { text: m.short }),
        h('span', { text: m.sub }),
      );
      card.addEventListener('click', () => {
        onSel(m);
        wrap.querySelectorAll('.wiz-model').forEach((x) => x.classList.toggle('on', x === card));
      });
      wrap.appendChild(card);
    }
  });
  return wrap;
}

// 演示模式入口（主页右上角按钮）：选型号 → 直接进入模拟器，不添加设备
export function openDemoPicker() {
  return new Promise((resolve) => {
    let sel = null;
    const close = (v) => { mask.remove(); resolve(v); };
    const mask = h('div', { class: 'modal-mask' });
    const ok = h('button', { class: 'btn primary', disabled: true, onclick: () => close(sel) },
      L('进入演示', 'Enter demo'));
    const box = h('div', { class: 'modal wizard' },
      h('h4', {}, L('演示模式', 'Demo mode'),
        h('button', { class: 'ghost-btn', style: 'float:right;margin:-4px -6px 0 0', onclick: () => close(null) }, iconEl('x', 15))),
      h('p', { class: 'wiz-note', text: L('选择一个型号，以演示模式体验驱动：会在主页添加一张标注「演示」的设备卡片（仅保存在本机），不会连接或写入任何真机配置。',
        'Pick a model to explore in demo mode: a "Demo" device card is added on the home page (stored locally only). Nothing is written to any real device.') }),
      h('div', { class: 'wiz-step' },
        h('div', { class: 'wiz-label' }, h('i', { class: 'step-no', text: '1' }), L('选择型号', 'Pick a model')),
        modelGrid((m) => { sel = m; ok.disabled = false; }),
      ),
      h('div', { class: 'wiz-foot' },
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn', onclick: () => close(null) }, L('取消', 'Cancel')),
        ok,
      ),
    );
    box.addEventListener('click', (e) => e.stopPropagation());
    mask.addEventListener('click', () => close(null));
    mask.append(box);
    document.body.appendChild(mask);
  });
}

// ---------- 向导右上角：HID 日志气泡 ----------
// 连接 / 型号识别失败时当场翻日志用（与 HID 调试台同源 logBuf）。日志监听器模块级只注册
// 一次，指向"当前打开着的气泡日志区"，气泡未开（或弹窗已关）时为 null，零开销。
let bugLogEl = null;
onDevLog((entry) => {
  if (bugLogEl) appendBugLine(bugLogEl, entry);
});

function appendBugLine(el, entry) {
  if (entry === null) { el.textContent = ''; return; } // clearLogs 广播 null
  if (el.dataset.empty) { el.textContent = ''; delete el.dataset.empty; } // 抹掉空态提示
  // kind 即 CSS 类（tx/rx/in/ok/warn/er，颜色由 .dbg-log 各级规则承担）
  el.appendChild(h('span', { class: entry.kind, text: `[${entry.time}] ${entry.kind.toUpperCase()} ${entry.msg}\n` }));
  el.scrollTop = el.scrollHeight;
}

// 虫子按钮 + 日志气泡：随「添加设备」弹窗创建，close() 时调用 dispose 解绑
function bugLogBubble() {
  const logEl = h('div', { class: 'dbg-log bug-log' });
  const bubble = h('div', { class: 'bug-bubble hidden' },
    h('div', { class: 'bug-head' },
      h('b', { text: L('HID 日志', 'HID log') }),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'ghost-btn', onclick: async () => {
        const text = getLogs().map((e) => `[${e.time}] ${e.kind.toUpperCase()} ${e.msg}`).join('\n');
        try {
          await navigator.clipboard.writeText(text);
          toast(L(`已复制 ${getLogs().length} 行日志`, `Copied ${getLogs().length} log lines`));
        } catch (e) {
          toast(L('复制失败：', 'Copy failed: ') + e.message, true);
        }
      } }, L('复制', 'Copy')),
      h('button', { class: 'ghost-btn', onclick: () => clearLogs() }, L('清空', 'Clear')),
    ),
    logEl,
  );
  const btn = h('button', { class: 'ghost-btn', title: L('HID 日志', 'HID log') }, iconEl('bug', 15));
  btn.addEventListener('click', () => {
    const show = bubble.classList.contains('hidden');
    bubble.classList.toggle('hidden', !show);
    btn.classList.toggle('on', show);
    bugLogEl = show ? logEl : null;
    if (show) {
      logEl.textContent = '';
      const logs = getLogs();
      if (logs.length) for (const e of logs) appendBugLine(logEl, e);
      else { logEl.dataset.empty = '1'; logEl.textContent = L('暂无日志——连接键盘后，收发的报文会显示在这里。', 'No logs yet — HID traffic appears here once a keyboard is connected.'); }
    }
  });
  return { btn, bubble, dispose: () => { if (bugLogEl === logEl) bugLogEl = null; } };
}

// 手动添加向导：自选型号 + 自选连接方式 + 可回退自动识别。
// preset: 识别结果预选高亮；failed: 识别失败原因；devs/chan: 进入时已持有的连接。
// 返回 {type:'add', meta, devs, chan} | {type:'auto', devs, chan}（外层重跑识别）| null（取消，连接已关闭）
function openManualWizard({ preset = null, failed = null, devs = [], chan = null } = {}) {
  return new Promise((resolve) => {
    let sel = preset;
    let selChan = chan ?? 'any';  // 连接方式默认=当前连接的实际通道
    let cur = devs;               // 向导当前持有的连接（可能被重连替换）
    let curChan = chan;
    const bug = bugLogBubble();
    const close = (v) => { bug.dispose(); mask.remove(); resolve(v); };
    const mask = h('div', { class: 'modal-mask' });

    // 连接状态行（重连后刷新）
    const connIcon = h('span', { class: 'dc-icons' });
    const vidEl = h('span', { class: 'wc-desc' });
    const stateEl = h('span', { class: 'wc-desc' });
    const setConn = (list, c) => {
      connIcon.replaceChildren(iconEl(c === 'wireless' ? 'wifi' : 'plug', 14));
      vidEl.replaceChildren(document.createTextNode(list.length ? vidPid(list[0]).toUpperCase() : ''));
      stateEl.replaceChildren(document.createTextNode(list.length ? L('已连接', 'connected') : L('未连接', 'not connected')));
    };
    setConn(devs, chan);

    // ① 型号网格（preset 预选高亮，用户可改选）
    const ok = h('button', { class: 'btn primary', disabled: !sel, onclick: () => okClick() }, L('确认添加', 'Confirm'));
    const models = modelGrid((m) => { sel = m; ok.disabled = false; });
    if (preset) {
      modelIndex().then((idx) => {
        const cards = [...models.querySelectorAll('.wiz-model')];
        const card = cards.find((c, i) => idx[i]?.slug === preset.slug);
        if (card) { card.classList.add('on', 'hot'); card.scrollIntoView({ block: 'nearest' }); }
      });
    }

    // ② 连接方式：与当前连接一致时「确认添加」直接复用；不一致则先按所选通道重连
    const opts = [
      { v: 'any', name: L('自动', 'Auto'), desc: '258A:010C / 3554:FA09' },
      { v: 'wired', name: L('有线连接', 'Wired'), desc: L('USB 数据线直连', 'USB cable') + ' · 258A:010C' },
      { v: 'wireless', name: L('2.4G 接收器', '2.4G dongle'), desc: L('接收器需插在电脑上', 'dongle plugged in') + ' · 3554:FA09' },
    ];
    const radios = opts.map((o) => {
      const inp = h('input', { type: 'radio', name: 'wiz-chan', checked: o.v === selChan ? '' : null });
      inp.addEventListener('change', () => { if (inp.checked) selChan = o.v; });
      return h('label', { class: 'wiz-chan' },
        inp,
        h('span', { text: o.name }),
        h('span', { class: 'wc-desc', text: o.desc }),
      );
    });

    async function ensureConnection() {
      if (cur.length && (selChan === 'any' || device.channelOf(cur[0]) === selChan)) return { devs: cur, chan: curChan };
      closeDevs(cur); cur = []; curChan = null; setConn(cur, curChan);
      const granted = await device.requestConnect(selChan);
      if (!granted?.length) { toast(L('未选择设备', 'No device selected')); return null; }
      cur = await mergeKnown(granted);
      curChan = device.channelOf(cur[0]) ?? (selChan === 'wireless' ? 'wireless' : 'wired');
      setConn(cur, curChan);
      return { devs: cur, chan: curChan };
    }

    async function okClick() {
      if (!sel) return;
      ok.disabled = true;
      ok.textContent = L('连接中…', 'Connecting…');
      const c = await ensureConnection();
      if (!c) { ok.disabled = false; ok.textContent = L('确认添加', 'Confirm'); return; }
      close({ type: 'add', meta: sel, devs: c.devs, chan: c.chan });
    }

    // 回退自动识别：按所选连接方式就位后交回外层重跑识别（成功→确认框，失败→回到本向导）
    const retry = h('button', { class: 'btn', onclick: () => retryClick() }, L('重试自动识别', 'Retry auto-detect'));
    async function retryClick() {
      retry.disabled = true;
      retry.textContent = L('连接中…', 'Connecting…');
      const c = await ensureConnection();
      if (!c) { retry.disabled = false; retry.textContent = L('重试自动识别', 'Retry auto-detect'); return; }
      close({ type: 'auto', devs: c.devs, chan: c.chan });
    }

    const failedNote = failed
      ? (failed.psd
        ? L('读到的 PSD 未匹配到任何型号。可选择连接方式后重连，或手动选择型号：',
          'The reported PSD matches no known model. Reconnect with another transport or pick the model manually:')
        : L(`未能自动识别（${failed.count} 个接口，设备名「${failed.name || '-'}」）。可选择连接方式后重连，或手动选择型号：`,
          `Automatic identification failed (${failed.count} interface(s), name "${failed.name || '-'}"). Reconnect with another transport or pick the model manually:`))
      : null;

    const box = h('div', { class: 'modal wizard' },
      bug.bubble,
      h('h4', {}, L('手动添加设备', 'Add device manually'),
        h('span', { style: 'display:flex;gap:6px;align-items:center;margin:-4px -6px 0 0' },
          bug.btn,
          h('button', { class: 'ghost-btn', onclick: () => { closeDevs(cur); close(null); } }, iconEl('x', 15)))),
      h('div', { class: 'wiz-conn' }, connIcon, vidEl, stateEl),
      h('p', { class: 'wiz-note', text: failedNote ?? L('识别结果不对？请手动选择你的型号；也可更换连接方式后重连或回退自动识别。',
        'Wrong identification? Pick your model manually; you can also switch the transport and reconnect, or fall back to auto-detection.') }),
      h('div', { class: 'wiz-step' },
        h('div', { class: 'wiz-label' }, h('i', { class: 'step-no', text: '1' }), L('选择型号', 'Pick a model')),
        models,
      ),
      h('div', { class: 'wiz-step' },
        h('div', { class: 'wiz-label' }, h('i', { class: 'step-no', text: '2' }), L('连接方式', 'Connection')),
        h('div', { class: 'wiz-chans' }, ...radios),
      ),
      h('div', { class: 'wiz-foot' },
        h('button', { class: 'btn', onclick: () => { closeDevs(cur); close(null); } }, L('取消', 'Cancel')),
        h('span', { style: 'flex:1' }),
        retry,
        ok,
      ),
    );
    box.addEventListener('click', (e) => e.stopPropagation());
    mask.addEventListener('click', () => { closeDevs(cur); close(null); });
    mask.append(box);
    document.body.appendChild(mask);
  });
}
