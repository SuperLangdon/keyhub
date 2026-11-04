// 主页连接中心：键盘灯波动画（无设备空态）+ 设备卡片列表 + 「添加新设备」向导
// 型号识别：所有型号共用 VID/PID，但固件支持 GetPSD 查询（report ID 0x05，逆向自原驱动
// OemDrv.exe 的 GetPassword）——连上后读 6 字节 PSD 与 index.json 各型号 psd 匹配：
// 唯一命中→确认框；PSD 撞车（开放注册表后可能出现）→候选集内按设备名消歧，仍歧义转手动；
// 识别失败（无响应 / PSD 未知）→blob 滑窗、设备名兜底，最终回退用户手动选型号。
// 添加的设备记录（slug + 通道）与各型号配置均保存在 localStorage，点卡片进入设置。
import { h, toast, modalA11y } from './ui.js';
import { iconEl } from './ui-icons.js';
import { t } from './i18n.js';
import { state, save, emit } from './store.js';
import { device, hidReady, onDevLog, getLogs, clearLogs, devLog, exportDiagnostics } from './device/index.js';
import { DEVICE_FAMILIES, rebuildDeviceFamilies, cfgGenOf } from './device/protocol.js';

function vidPid(dev) {
  return `${dev.vendorId.toString(16).padStart(4, '0')}:${dev.productId.toString(16).padStart(4, '0')}`;
}
// 各设备族的 VID/PID 文案（手动向导连接方式行）："258A:010C / 3554:FA09 · 258A:019D / 258A:0150"
function idsHex(fam, channel) {
  const list = channel === 'wired' ? [fam.wired] : channel === 'wireless' ? [fam.wireless] : [fam.wired, fam.wireless];
  return list.filter(Boolean)
    .map(({ vid, pid }) => `${vid.toString(16).padStart(4, '0').toUpperCase()}:${pid.toString(16).padStart(4, '0').toUpperCase()}`)
    .join(' / ');
}
function devLabel(dev) {
  return `${dev.productName || 'Keyboard'} (${vidPid(dev)})`;
}

// ---------- 型号索引 ----------
let idxPromise = null;
function modelIndex() {
  if (!idxPromise) {
    idxPromise = fetch('assets/models/index.json').then((r) => r.json())
      .then((idx) => {
        // 注册表驱动设备族表（requestDevice 过滤 / channelOf / knownDevices）：
        // 社区贡献的新 VID/PID 型号加载即生效。重建失败不阻断——内置表继续兜底。
        if (rebuildDeviceFamilies(idx))
          devLog('in', `设备族表已按注册表重建：${DEVICE_FAMILIES.length} 族（${DEVICE_FAMILIES.map((f) => f.name).join(' · ')}）`);
        return idx;
      })
      .catch((e) => { idxPromise = null; throw e; }); // 失败不缓存：下次调用重试
  }
  return idxPromise;
}

// PSD（6 字节）↔ 型号匹配：与 index.json 各型号 psd（十六进制，来自 KB.ini 的 Psd=）逐字节全等。
// 返回**全部**命中——注册表开放共建后 PSD 可能撞车（厂商模板值复用），与 name/blob
// 匹配同款策略：命中多个时先在候选集内按设备名消歧，仍歧义则交用户手动选择，
// 绝不静默取第一个，防止配置下发到错误布局。撞车在入库时由 validate-registry 查重把关。
function matchModelsByPsd(psd, idx) {
  if (!psd || psd.length !== 6) return [];
  return idx.filter((m) => Array.isArray(m.psd) && m.psd.length === 6 && m.psd.every((b, i) => b === psd[i]));
}

// VID/PID 识别（兜底）：注册表把 wired/wireless VID/PID 记到**型号粒度**（来自各 KB.ini）。
// 族内共用 ID 的（LEOBOG 全系 3554:fa09）会命中多个 → 视为歧义不取；唯一命中（如 K65 的
// 258a:0150——其 2.4G 固件不实现 0x13 cmd05 GetPSD，设备名又是通用的「Gaming KB」）才可定型号。
// 比设备名兜底硬：ID 是驱动配置里的硬数据，产品字符串厂商随便填。
function matchModelsById(dev, idx) {
  if (!dev) return [];
  return idx.filter((m) =>
    (m.wired && m.wired.vid === dev.vendorId && m.wired.pid === dev.productId) ||
    (m.wireless && m.wireless.vid === dev.vendorId && m.wireless.pid === dev.productId));
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
// PSD 在应答中的偏移未经抓包确定；滑窗 + 型号表双重校验（PSD 全局唯一性由
// validate-registry 入库查重保证）足够安全。命中多个不同型号 → null（防止误配）。
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
  return { wired: t('app.common.wired'), wireless: t('app.common.wireless'), any: t('app.common.auto') }[ch] ?? ch;
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
  // 空态：动画 → 标题 → 提示 → CTA；有设备：卡片 → CTA → 提示脚注
  els.actions.style.marginTop = has ? '44px' : '32px';
  if (has) {
    els.title.classList.add('hidden');
    els.actions.after(els.hint); // 有设备时提示移到 CTA 下方作脚注（.conn-actions + .conn-hint 收紧间距）
  } else {
    els.title.classList.remove('hidden');
    els.actions.before(els.hint);
  }
  // 空态给无硬件访客一条显式演示入口（真机连接前的完整体验路径）；
  // 有设备后收起——此时按钮已是熟路
  const demoLink = h('button', { class: 'conn-demo-link', type: 'button', onclick: () => document.getElementById('welcome-demo').click() },
    t('app.conn.tryDemo'), iconEl('play', 12));
  setActions(
    h('button', { class: 'conn-cta', onclick: addDevice, disabled: !!addBusy },
      addBusy ? h('span', { class: 'conn-spin' }) : iconEl('plus', 16),
      addBusy ?? t('app.conn.addNew')),
    has ? null : demoLink,
  );

  if (has) {
    Promise.all(devices.map(deviceCard)).then((cards) => {
      if (cards.length === state.devices.length) els.cards.replaceChildren(...cards);
    });
    // 蓝牙不支持是唯一需要常驻的提醒；「点卡片进入设置」由卡片本身传达
    els.hint.textContent = t('app.conn.btHint');
  } else {
    els.cards.replaceChildren();
    els.title.textContent = t('app.conn.heroTitle');
    // 先说自动识别（正面预期），限制作括注
    els.hint.textContent = t('app.conn.heroHint');
  }
}

// ---------- 设备卡片 ----------
// 电量缓存（按 VID:PID 键控——多把键盘同插时不能串显）：键盘 2.4G 闲置会快睡，
// 频繁查询只会超时，按分钟级节流
const batteryCache = new Map(); // "vid:pid" -> { at, val }

async function deviceCard(rec) {
  const idx = await modelIndex();
  const meta = idx.find((m) => m.slug === rec.slug);
  const short = meta?.short ?? rec.slug;
  const wireless = rec.channel === 'wireless';
  const battSlot = h('span', { class: 'dc-batt hidden' });
  const card = h('div', { class: 'device-card' },
    h('div', { class: 'dc-img' }, h('img', { src: `assets/models/${rec.slug}/keyimg.png`, alt: short })),
    h('div', { class: 'dc-body' },
      h('div', { class: 'dc-top' },
        h('div', { class: 'dc-title' },
          h('b', { class: 'dc-name', text: short }),
          rec.demo ? h('span', { class: 'dc-tag', text: t('app.common.demo') }) : null,
          h('span', { class: 'dc-sub', text: meta?.sub ?? '' }),
        ),
        h('button', { class: 'dc-x', title: t('app.conn.removeDevice') }, iconEl('x', 14)),
      ),
      h('div', { class: 'dc-meta' },
        h('span', {
          class: 'dc-icons',
          title: rec.demo ? t('app.conn.demoCardTip')
            : wireless ? t('app.common.wireless') : t('app.conn.wiredConn'),
        }, iconEl(rec.demo ? 'play' : wireless ? 'wifi' : 'plug', 16), battSlot),
      ),
    ),
  );
  card.addEventListener('click', () => openDevice(rec));
  card.querySelector('.dc-x').addEventListener('click', (e) => {
    e.stopPropagation();
    removeDevice(rec.id);
    render(); // 卡片消失即反馈
  });
  // 电量：K65（fw26）读屏幕控制器寄存器（report 10，无线/有线接口皆可）→ 无线卡片显示；
  // LEOBOG（fw24）走 0x13 cmd 0x4A 仅 2.4G 接收器应答（休眠无响应则不显示）。
  const battOk = device.mode === 'hid' &&
    (cfgGenOf(meta) === 'fw26' || (wireless && cfgGenOf(meta) === 'fw24'));
  if (battOk) {
    const key = vidPid(device.dev);
    const c = batteryCache.get(key);
    const cached = c && Date.now() - c.at < 60_000 ? c.val : undefined;
    Promise.resolve(cached ?? device.readBattery()).then((b) => {
      if (cached === undefined) batteryCache.set(key, { at: Date.now(), val: b });
      if (!b) return;
      battSlot.replaceChildren(iconEl('battery', 15), h('span', { class: 'dc-batt-pct', text: `${b.percent}%` }));
      battSlot.classList.remove('hidden');
    });
  }
  return card;
}

// 点设备卡片：真机卡片先尝试静默重连已授权的设备（不弹窗，取消/失败按当前模式进入；
// 已授权的多个接口全部打开，识别命令可能只在其中一个上）；
// 演示卡片 = 纯模拟器：不重连，且真机仍连接着时先断开，避免演示会话误向硬件下发。
// 识别（GetPSD HID 往返）可能耗时数百 ms 到数秒——期间连点只走第一次，防止并发多次进入。
let openingDevice = false;

function openDevice(rec) {
  if (openingDevice) return;
  openingDevice = true;
  openDeviceInner(rec).finally(() => { openingDevice = false; });
}

async function openDeviceInner(rec) {
  let meta = (await modelIndex()).find((m) => m.slug === rec.slug);
  if (!meta) { toast(t('app.conn.modelMissing'), true); return; }
  if (rec.demo) {
    if (device.mode === 'hid') device.disconnect();
  } else if (hidReady()) {
    if (device.mode !== 'hid') {
      const opened = [];
      for (const known of await device.knownDevices()) {
        try { if (!known.opened) await known.open(); opened.push(known); }
        catch { /* 单个接口打开失败则跳过 */ }
      }
      if (opened.length) device.attach(opened[0], opened.slice(1));
    }
    // 进真机卡片前重新识别（GetPSD 只读）：LEOBOG 全系共用同一对 VID/PID，持久授权的
    // 接口集合可能实际是另一款键盘——不核对就进卡片型号，下发会按错误布局写硬件。
    // 唯一命中且与卡片不符 → 按实际键盘进入（与添加向导同语义）；识别失败维持卡片型号。
    // 局限：USB 描述符无法区分同型号的两把键盘，多把同型号键盘请逐把授权/连接。
    if (device.mode === 'hid') {
      try {
        const { psd } = await device.readPsdAny();
        if (psd) {
          const hit = matchModelsByPsd(psd, await modelIndex());
          if (hit.length === 1 && hit[0].slug !== rec.slug) {
            toast(t('app.conn.actualModel', { actual: hit[0].short, card: meta.short }));
            onEnterApp(hit[0]);
            return;
          }
        }
      } catch { /* 识别失败不阻断进入 */ }
    }
  }
  onEnterApp(meta);
}

// ---------- 开页自动重连 ----------
// WebHID 授权按源持久化：「添加设备」时 Chrome 授权一次，之后 navigator.hid.getDevices()
// 静默返回全部已授权设备——不弹窗、无需用户手势。启动时若设备列表里有真机记录，就把
// 已授权接口全部打开并挂接；运行中插回键盘由 hid connect 事件接管（每接口发一事件，
// 防抖后统一收集——键盘的厂商功能可能分散在多个 USB 接口上，须等事件到齐再挂接）。
// 型号不在此核对：同族 VID/PID 无法区分具体型号，点卡片进入时 openDevice 会重新识别。
// 失败路径全部留痕（devLog + toast）：自动重连不弹窗，「为什么没连上」只能靠提示回答。
// 授权与 localStorage 都按「协议+域名+端口」隔离——换地址打开（localhost↔127.0.0.1、
// 换端口、走局域网 IP）会同时丢掉设备记录与授权，这是「重启后没自动连」的最常见原因。
let plugTimer = 0;
// 已挂接状态下并入新插回的已授权接口（如 2.4G 会话中插入键盘 USB 线）：
// 未授权的不弹窗静默跳过；并入成功 emit 'device'，屏幕页等按会话能力门控的界面随之刷新
//（屏幕无线遮罩据此自动揭开，无需重进页面）
async function mergeNewIfaces(why) {
  try {
    const fresh = [];
    for (const d of await device.knownDevices()) {
      if (device.hidDevs.includes(d)) continue;
      try { if (!d.opened) await d.open(); fresh.push(d); }
      catch { /* 未插回 / 被占用：跳过 */ }
    }
    if (fresh.length) {
      device.addIfaces(fresh);
      emit('device', device.mode);
    }
  } catch (e) { devLog('warn', `并入新接口（${why}）失败: ${e?.message ?? e}`); }
}
async function silentReconnect(why) {
  if (device.mode === 'hid') {
    // 已挂接（如 2.4G 接收器会话）又插回新接口（键盘 USB 线）：只并入新接口，
    // 不重建会话——主接口（灯光路由）保持不变
    await mergeNewIfaces(why);
    return;
  }
  const recs = state.devices.filter((r) => !r.demo).length;
  if (!recs) {
    devLog('in', `自动重连（${why}）：本站（${location.origin}）没有真机设备记录，跳过。若此前添加过设备，是打开地址变了——换地址数据不跟随。`);
    return;
  }
  const notReadyKey = !navigator.hid ? 'app.conn.autoFailNoHid'
    : !window.isSecureContext ? 'app.conn.autoFailInsecure'
    : null;
  if (notReadyKey) {
    devLog('er', `自动重连（${why}）：${t(notReadyKey)}`);
    toast(t('app.conn.autoFail', { reason: t(notReadyKey) }), true, true);
    return;
  }
  try {
    await modelIndex(); // knownDevices 按注册表设备族过滤，须等注册表重建完成
    const known = await device.knownDevices();
    if (!known.length) {
      devLog('warn', `自动重连（${why}）：浏览器已授权设备列表为空（本站有 ${recs} 条真机记录）——换地址打开授权不跟随，回原地址或「添加新设备」重新授权`);
      toast(t('app.conn.noGrant'), true, true);
      return;
    }
    const opened = [];
    for (const d of known) {
      try { if (!d.opened) await d.open(); opened.push(d); }
      catch (e) { devLog('warn', `自动重连：接口 ${vidPid(d)} 打开失败: ${e.message}`); }
    }
    if (!opened.length) {
      devLog('er', `自动重连（${why}）：${known.length} 个已授权接口全部打开失败（可能被官方驱动等其他程序占用）`);
      toast(t('app.conn.openFailed'), true, true);
      return;
    }
    const primary = device.bestForLights(opened) ?? opened[0];
    device.attach(primary, opened.filter((x) => x !== primary));
    // 不 toast 自动连接成功：开页/插回的静默后台流程，失败路径才有提示（下方 devLog 留痕）
    devLog('ok', `自动重连（${why}）：已打开此前授权的 ${opened.length} 个接口`);
    render(); // 刷新卡片（无线卡片的电量查询依赖 device.mode === 'hid'）
  } catch (e) {
    devLog('warn', `自动重连失败（${why}）: ${e?.message ?? e}`);
  }
}

export function autoConnect() {
  silentReconnect('启动');
  if (typeof navigator.hid?.addEventListener === 'function') {
    navigator.hid.addEventListener('connect', () => {
      clearTimeout(plugTimer);
      plugTimer = setTimeout(() => silentReconnect('插回'), 250);
    });
  }
}

// ---------- 添加设备：点击即弹 HID 请求 → 自动识别型号 → 确认框（识别错了可转手动；识别失败转手动） ----------
let addBusy = null; // 连接/识别期间 CTA 的忙碌文案

async function addDevice() {
  if (addBusy) return;
  if (!hidReady()) {
    toast(t('app.conn.noWebHID'), true, true);
    return;
  }

  try {
    addBusy = t('app.conn.connecting'); render();
    let granted = null;
    try {
      granted = await device.requestConnect('any'); // 自动弹出浏览器 HID 选择框（无过滤，选哪行连哪个）
    } catch (e) {
      toast(t('app.conn.connectFailed', { msg: e.message }), true);
      return;
    }
    if (!granted?.length) return; // 用户在选择框点了取消：关闭即表态，无需提示
    let devs = await mergeKnown(granted);
    let chan = device.channelOf(devs[0]) ?? 'wired';

    // 识别 → 确认框 →（手动向导 → 重连/回退自动）循环，直到 添加 / 取消
    while (true) {
      addBusy = t('app.conn.identifyBusy'); render();
      const { psd, reason, blob } = await device.readPsdAny(devs);
      const idx = await modelIndex();
      // 三态：唯一命中 → 确认框；多个命中 → 候选集内按设备名消歧，仍歧义转手动（候选高亮）；
      // 零命中 → blob 滑窗 / 设备名兜底（原链路）
      const psdHits = psd ? matchModelsByPsd(psd, idx) : [];
      // 最近一次识别结果（适配诊断包 buildDiagnostics 引用；未知 PSD 时贡献者据此报 issue）
      device.lastIdentify = {
        at: new Date().toISOString(),
        psd: psd ? [...psd] : null,
        reason: reason ?? null,
        blobBytes: blob?.length ?? 0,
        hits: psdHits.map((x) => x.slug),
      };
      let meta = psdHits.length === 1 ? psdHits[0] : null;
      if (!meta && !psdHits.length && blob) meta = matchModelByBlob(blob, idx);
      if (!meta) {
        const named = devs.map((d) => d.productName).find(Boolean);
        if (psdHits.length > 1) {
          // PSD 撞车：PSD 是硬信号，仅在候选集内按设备名消歧，候选外不取；
          // 消歧失败弹候选对话框（布局图对照终审），取消则落回手动向导（候选高亮）
          meta = named ? matchModelByName(named, psdHits) : null;
          if (!meta) {
            const pick = await openCandidatePick(psdHits, devs, chan);
            if (pick) { finishAdd(pick, devs, chan); return; }
          }
        } else {
        // 兜底链：VID/PID（注册表型号粒度 ID，唯一命中才取）→ 设备名。
        // 命中结果随后由确认框展示（型号名 + 布局图），识别途径不再单独 toast
        const idHits = matchModelsById(devs[0], idx);
        meta = idHits.length === 1 ? idHits[0] : null;
        if (!meta) meta = matchModelByName(named, idx);
        }
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
        if (psd) toast(t('app.conn.unknownPsd'), true);
        else if (reason === 'no-report') toast(t('app.conn.noReport', { n: devs.length }), true, true);
        else if (reason === 'send-failed') toast(t('app.conn.rejected'), true, true);
        else toast(t('app.conn.noReply'), true, true);
        failed = { psd: !!psd, reason, count: devs.length, name: devs.map((d) => d.productName).find(Boolean), candidates: psdHits.length > 1 ? psdHits : null };
      }

      render();
      const r = await openManualWizard({ preset, failed, devs, chan });
      if (!r) return; // 向导内取消（连接已由向导关闭）
      if (r.type === 'add') { finishAdd(r.meta, r.devs, r.chan); return; }
      devs = r.devs; chan = r.chan; // 'auto'：带着（可能重连过的）连接回到识别循环
    }
  } catch (e) {
    // 兜底：任何异常都不能把 CTA 卡在忙碌态
    toast(t('app.conn.flowError', { msg: e?.message ?? e }), true);
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
  device.ensureFwGrant(); // 确认框点击的手势仍有效：顺手补 WebUSB 授权，固件版本从此自动回填
  addDeviceRecord(meta, chan); // 添加后主页出现设备卡片即反馈（已在列表时卡片同样可见）
  // 有线个别接口无任何 output 报文（0x13 帧发不出去）：提示灯光/配置无法写入
  if (!device.canSend13()) {
    toast(t('app.conn.noCh13'), true, true);
  }
  render();
}

// 识别结果确认框：返回 true=确认添加、'manual'=识别错了转手动、null=取消
function openConfirmAdd(meta, devs, chan) {
  return new Promise((resolve) => {
    const mask = h('div', { class: 'modal-mask' });
    let unA11y = () => {};
    const close = (v) => { unA11y(); mask.remove(); resolve(v); };
    unA11y = modalA11y(mask, () => close(null));
    const primary = device.bestForLights(devs) ?? devs[0];
    const box = h('div', { class: 'modal cfm' },
      h('h4', {}, t('app.conn.identified')),
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
            devs.length > 1 ? h('span', { class: 'wc-desc', text: t('app.conn.ifaceCount', { n: devs.length }) }) : null,
          ),
          primary.productName ? h('div', { class: 'cfm-name-str', text: t('app.conn.deviceName', { name: primary.productName }) }) : null,
        ),
      ),
      h('div', { class: 'wiz-foot' },
        h('button', { class: 'btn', onclick: () => close('manual') }, t('app.conn.wrongPickManual')),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn', onclick: () => close(null) }, t('app.common.cancel')),
        h('button', { class: 'btn primary', onclick: () => close(true) }, t('app.conn.confirmAdd')),
      ),
    );
    box.addEventListener('click', (e) => e.stopPropagation());
    mask.addEventListener('click', () => close(null));
    mask.append(box);
    document.body.appendChild(mask);
  });
}

// PSD 撞车候选消歧：签名同时命中多个型号（不同厂商复用模板值）时，让用户对照
// 布局图终审——绝不静默取第一个。返回选中的 meta；取消返回 null（外层落回手动向导）。
function openCandidatePick(cands, devs, chan) {
  return new Promise((resolve) => {
    const mask = h('div', { class: 'modal-mask' });
    let unA11y = () => {};
    const close = (v) => { unA11y(); mask.remove(); resolve(v); };
    unA11y = modalA11y(mask, () => close(null));
    const box = h('div', { class: 'modal cfm' },
      h('h4', {}, t('app.conn.whichModel')),
      h('p', { class: 'wiz-note', text: t('app.conn.candNote') }),
      h('div', { class: 'wiz-models cand-list' },
        ...cands.map((m) => h('button', { class: 'wiz-model', type: 'button', onclick: () => close(m) },
          h('img', { src: `assets/models/${m.slug}/keyimg.png`, alt: m.short }),
          h('b', { text: m.short }),
          h('span', { text: m.sub }),
          h('span', { text: `${t('app.conn.keysLabel')}: ${m.keys}` }),
        ))),
      h('div', { class: 'wiz-foot' },
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn', onclick: () => close(null) }, t('app.conn.pickFromAll')),
      ),
    );
    box.addEventListener('click', (e) => e.stopPropagation());
    mask.addEventListener('click', () => close(null));
    mask.append(box);
    document.body.appendChild(mask);
  });
}

// 适配请求 issue 模板（.github/ISSUE_TEMPLATE/adapter-request.md 的内联版）：
// 自动填入最近一次识别结果（PSD/命中/原因），贡献者不用手抄十六进制。
function adapterIssueText() {
  const li = device.lastIdentify;
  const psdHex = li?.psd?.length ? '0x' + li.psd.map((b) => b.toString(16).padStart(2, '0')).join(' ') : null;
  return [
    '### 键盘型号 / Keyboard model',
    '- 品牌 / 型号（键盘正面或包装盒）: ',
    '- 布局（60% / 65% / 75% / 98 键…）: ',
    '- 连接方式: 有线 / 2.4G 接收器 / 蓝牙',
    '',
    '### 官方驱动 / Official driver',
    '- 能否找到官方驱动（下载链接）: ',
    '',
    '### 识别情况 / Identification（KeyHub 自动填写）',
    ...(li ? [
      `- PSD: ${psdHex ?? '未读到'}`,
      `- 匹配: ${li.hits?.length ? '命中 ' + li.hits.join(', ') : `未命中（reason: ${li.reason ?? '?'}）`}`,
      `- 识别时间: ${li.at}`,
    ] : ['- （本会话未尝试识别——连上键盘点「添加新设备」后再导出）']),
    '',
    '### 附件 / Attachments',
    '- keyhub-diag-*.json 适配诊断包（HID 控制台右上角纸飞机按钮导出）',
    '- 键盘正面全键位实拍照片',
    '',
    `环境: ${navigator.userAgent}`,
    `页面: ${location.href}`,
  ].join('\n');
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
    const mask = h('div', { class: 'modal-mask' });
    let unA11y = () => {};
    const close = (v) => { unA11y(); mask.remove(); resolve(v); };
    unA11y = modalA11y(mask, () => close(null));
    const ok = h('button', { class: 'btn primary', disabled: true, onclick: () => close(sel) },
      t('app.conn.enterDemo'));
    const box = h('div', { class: 'modal wizard' },
      h('h4', {}, t('app.conn.demoMode'),
        h('button', { class: 'ghost-btn', style: 'float:right;margin:-4px -6px 0 0', onclick: () => close(null) }, iconEl('x', 15))),
      h('p', { class: 'wiz-note', text: t('app.conn.demoNote') }),
      h('div', { class: 'wiz-step' },
        h('div', { class: 'wiz-label' }, t('app.conn.pickModel')),
        modelGrid((m) => { sel = m; ok.disabled = false; }),
      ),
      h('div', { class: 'wiz-foot' },
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn', onclick: () => close(null) }, t('app.common.cancel')),
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
      h('b', { text: t('app.conn.hidLog') }),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'ghost-btn', onclick: async () => {
        const text = getLogs().map((e) => `[${e.time}] ${e.kind.toUpperCase()} ${e.msg}`).join('\n');
        try {
          await navigator.clipboard.writeText(text);
          toast(t('app.conn.logCopied', { n: getLogs().length }));
        } catch (e) {
          toast(t('app.common.copyFailed', { msg: e.message }), true);
        }
      } }, t('app.common.copy')),
      h('button', { class: 'ghost-btn', onclick: () => clearLogs() }, t('app.common.clear')),
    ),
    logEl,
  );
  const btn = h('button', { class: 'ghost-btn', title: t('app.conn.hidLog') }, iconEl('bug', 15));
  btn.addEventListener('click', () => {
    const show = bubble.classList.contains('hidden');
    bubble.classList.toggle('hidden', !show);
    btn.classList.toggle('on', show);
    bugLogEl = show ? logEl : null;
    if (show) {
      logEl.textContent = '';
      const logs = getLogs();
      if (logs.length) for (const e of logs) appendBugLine(logEl, e);
      else { logEl.dataset.empty = '1'; logEl.textContent = t('app.conn.logEmpty'); }
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
    const mask = h('div', { class: 'modal-mask' });
    let unA11y = () => {};
    const close = (v) => { unA11y(); bug.dispose(); mask.remove(); resolve(v); };
    // Esc = 取消向导并关闭连接（与点遮罩同语义）
    unA11y = modalA11y(mask, () => { closeDevs(cur); close(null); });

    // 连接状态行（重连后刷新）
    const connIcon = h('span', { class: 'dc-icons' });
    const vidEl = h('span', { class: 'wc-desc' });
    const stateEl = h('span', { class: 'wc-desc' });
    const setConn = (list, c) => {
      connIcon.replaceChildren(iconEl(c === 'wireless' ? 'wifi' : 'plug', 14));
      vidEl.replaceChildren(document.createTextNode(list.length ? vidPid(list[0]).toUpperCase() : ''));
      stateEl.replaceChildren(document.createTextNode(list.length ? t('app.common.connected') : t('app.common.notConnected')));
    };
    setConn(devs, chan);

    // ① 型号网格（preset 预选高亮，用户可改选）
    const ok = h('button', { class: 'btn primary', disabled: !sel, onclick: () => okClick() }, t('app.conn.confirmAdd'));
    const models = modelGrid((m) => { sel = m; ok.disabled = false; });
    // 预选高亮：preset 单选（on+hot）；PSD 撞车候选集整组 hot（不代选，用户终审）
    const candSlugs = new Set([...(failed?.candidates ?? []).map((m) => m.slug)]);
    if (preset || candSlugs.size) {
      modelIndex().then((idx) => {
        const cards = [...models.querySelectorAll('.wiz-model')];
        for (let i = 0; i < cards.length; i++) {
          const slug = idx[i]?.slug;
          if (preset && slug === preset.slug) { cards[i].classList.add('on', 'hot'); cards[i].scrollIntoView({ block: 'nearest' }); }
          else if (candSlugs.has(slug)) cards[i].classList.add('hot');
        }
      });
    }

    // ② 连接方式：与当前连接一致时「确认添加」直接复用；不一致则先按所选通道重连
    // VID/PID 文案从 protocol.js 设备族表动态拼出，覆盖全部已适配型号
    const opts = [
      { v: 'any', name: t('app.common.auto'), desc: DEVICE_FAMILIES.map((f) => idsHex(f, 'any')).join(' · ') },
      { v: 'wired', name: t('app.conn.wiredConn'), desc: t('app.conn.usbCable') + ' · ' + DEVICE_FAMILIES.map((f) => idsHex(f, 'wired')).join(' / ') },
      { v: 'wireless', name: t('app.conn.dongle'), desc: t('app.conn.donglePlugged') + ' · ' + DEVICE_FAMILIES.map((f) => idsHex(f, 'wireless')).join(' / ') },
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
      if (!granted?.length) return null; // 用户取消选择框：关闭即表态
      cur = await mergeKnown(granted);
      curChan = device.channelOf(cur[0]) ?? (selChan === 'wireless' ? 'wireless' : 'wired');
      setConn(cur, curChan);
      return { devs: cur, chan: curChan };
    }

    async function okClick() {
      if (!sel) return;
      ok.disabled = true;
      ok.textContent = t('app.conn.connecting');
      const c = await ensureConnection();
      if (!c) { ok.disabled = false; ok.textContent = t('app.conn.confirmAdd'); return; }
      close({ type: 'add', meta: sel, devs: c.devs, chan: c.chan });
    }

    // 回退自动识别：按所选连接方式就位后交回外层重跑识别（成功→确认框，失败→回到本向导）
    const retry = h('button', { class: 'btn', onclick: () => retryClick() }, t('app.conn.retryAuto'));
    async function retryClick() {
      retry.disabled = true;
      retry.textContent = t('app.conn.connecting');
      const c = await ensureConnection();
      if (!c) { retry.disabled = false; retry.textContent = t('app.conn.retryAuto'); return; }
      close({ type: 'auto', devs: c.devs, chan: c.chan });
    }

    const failedNote = failed
      ? (failed.candidates?.length
        ? t('app.conn.psdMulti', { n: failed.candidates.length, list: failed.candidates.map((m) => m.short).join(' / ') })
        : failed.psd
        ? t('app.conn.psdNoMatch')
        : t('app.conn.autoFailCount', { n: failed.count, name: failed.name || '-' }))
      : null;

    // 社区适配贡献块（识别失败时显示）：把「被拒之门外的用户」变成「贡献者」
    const contribute = failed ? h('details', { class: 'wiz-contribute' },
      h('summary', {}, t('app.conn.contributeTitle')),
      h('p', { text: t('app.conn.contributeNote') }),
      h('p', { text: t('app.conn.contributeDriver') }),
      h('p', { text: t('app.conn.contributeKb') }),
      h('div', { class: 'wiz-contribute-btns' },
        h('button', { class: 'btn', onclick: () => exportDiagnostics() }, t('app.conn.exportDiag')),
        h('button', { class: 'btn', onclick: async () => {
          try {
            await navigator.clipboard.writeText(adapterIssueText());
            toast(t('app.conn.issueCopied'));
          } catch (e) { toast(t('app.common.copyFailed', { msg: e.message }), true); }
        } }, t('app.conn.copyIssue')),
      ),
    ) : null;

    const box = h('div', { class: 'modal wizard' },
      bug.bubble,
      h('h4', {}, t('app.conn.manualAdd'),
        h('span', { style: 'display:flex;gap:6px;align-items:center;margin:-4px -6px 0 0' },
          bug.btn,
          h('button', { class: 'ghost-btn', onclick: () => { closeDevs(cur); close(null); } }, iconEl('x', 15)))),
      h('div', { class: 'wiz-conn' }, connIcon, vidEl, stateEl),
      h('p', { class: 'wiz-note', text: failedNote ?? t('app.conn.manualNote') }),
      contribute,
      h('div', { class: 'wiz-step' },
        h('div', { class: 'wiz-label' }, h('i', { class: 'step-no', text: '1' }), t('app.conn.pickModel')),
        models,
      ),
      h('div', { class: 'wiz-step' },
        h('div', { class: 'wiz-label' }, h('i', { class: 'step-no', text: '2' }), t('app.conn.connLabel')),
        h('div', { class: 'wiz-chans' }, ...radios),
      ),
      h('div', { class: 'wiz-foot' },
        h('button', { class: 'btn', onclick: () => { closeDevs(cur); close(null); } }, t('app.common.cancel')),
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
