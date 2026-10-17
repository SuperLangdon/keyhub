// 全局状态 + localStorage 持久化
import { L } from './i18n.js';

// 构建标记：由 tools/bump-build.mjs 生成（git 短哈希 + 日期），改 js 后跑一次脚本——
// 日志/诊断包引用它核对浏览器是否拿到最新代码（避免模块缓存误导调试）。
// （原定义于 main.js，迁此供 device 层诊断包引用且不引入循环依赖）
export const BUILD = '2026-10-18.367e861+reenter';

const LS_KEY = 'leobog-web-v1'; // 历史键名（更名 KeyHub 前沿用）：不改名，保住老用户的 localStorage 数据

export const state = {
  lang: 'zh',
  theme: 'light',      // light | dark
  slug: null,          // 当前型号
  model: null,         // model.json 对象
  deviceMode: 'sim',   // sim | hid
  devices: [],         // 主页设备卡片：{ id: slug|channel, slug, channel }
  cfg: null,           // 当前型号配置
  cfgs: {},            // slug -> cfg（全部型号的记忆）
  macros: [],          // 宏列表
  page: 'light',
  gateAck: 0,          // 已确认免责声明的版本号（main.js GATE_VER）
};

const listeners = new Map();
export function on(ev, fn) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev).add(fn);
  return () => listeners.get(ev).delete(fn);
}
export function emit(ev, data) {
  listeners.get(ev)?.forEach((fn) => fn(data));
}

// ---------- 默认配置 ----------
export function defaultCfg(model) {
  const layers = [];
  for (let l = 0; l < model.layerNum; l++) {
    const m = {};
    if (l === 0) for (const k of model.keys) if (k.fn) m[k.i] = { ...k.fn };
    if (l === 1) for (const [i, f] of Object.entries(model.fn1 ?? {})) m[i] = { ...f };
    layers.push(m);
  }
  return {
    effectUi: ledUiByIndex(model, model.defLedIndex) ?? 1,
    color: [255, 0, 0],
    colorful: false,
    brightness: 4,
    speed: 2,
    direction: 0,
    perKey: {},          // key i -> [r,g,b]
       // 自定义动画 id
    layers,
    sleep: model.sleepTime ?? 0,   // 分钟
    debounce: 2,
    tapSens: 4,                    // Tap 灵敏度档（板载配置 payload[8]，出厂模板 0x04）
  };
}

export function ledUiByIndex(model, ledIndex) {
  // DefLedIndex 是效果列表里的序号（1 起，跳过 LedMask 隐藏的效果——与原驱动 UI 列表一致）
  const masked = (ui) => ui >= 1 && ui <= 18 && (model.ledMask & (1 << (ui - 1))) !== 0;
  const opts = model.ledopts.filter((o) => !masked(o.ui) && (o.fw !== 0 || o.ui === o.fw));
  if (!opts.length) return 1;
  const o = opts[Math.min(ledIndex ?? 0, opts.length - 1)];
  return o.ui;
}


// ---------- 持久化 ----------
export function save() {
  const data = { lang: state.lang, theme: state.theme, slug: state.slug, devices: state.devices, cfgs: state.cfgs, macros: state.macros, gateAck: state.gateAck };
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* 忽略配额错误 */ }
}

export function restore() {
  try {
    const data = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (data.lang) state.lang = data.lang;
    if (data.theme === 'dark' || data.theme === 'light') state.theme = data.theme;
    if (Array.isArray(data.devices)) state.devices = data.devices.filter((d) => d && d.slug);
    if (data.cfgs) state.cfgs = data.cfgs;
    if (Array.isArray(data.macros)) state.macros = data.macros;
    if (typeof data.gateAck === 'number') state.gateAck = data.gateAck;
    return data.slug || null;
  } catch { return null; }
}

// ---------- 配置导入导出 ----------
export function exportAll() {
  return JSON.stringify({ app: 'keyhub', ver: 2, exported: new Date().toISOString(), cfgs: state.cfgs, macros: state.macros }, null, 2);
}

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// 导入形状校验：cfg 只收「值为对象且 layers 为数组」的条目；宏事件只收
// {at:number, kind:'dn'|'up', code:number}。畸形条目丢弃并计数（返回值供 UI 提示），
// 防止手工损坏/旧版导出文件把 localStorage 污染成进型号即崩溃的状态。
// 宏 id：保留文件内合法且唯一的 id（键位指派按 id 引用），仅把缺失/重复的换成新号。
export function importAll(json) {
  const data = JSON.parse(json);
  if (data.app !== 'keyhub' && data.app !== 'leobog-web') throw new Error(L('不是本应用的配置文件', 'Not a profile exported from this app'));
  let cfgN = 0, dropped = 0;
  if (isPlainObj(data.cfgs)) {
    for (const [slug, cfg] of Object.entries(data.cfgs)) {
      if (typeof slug === 'string' && slug && isPlainObj(cfg) && Array.isArray(cfg.layers)) { state.cfgs[slug] = cfg; cfgN++; }
      else dropped++;
    }
  }
  let macN = 0;
  if (Array.isArray(data.macros)) {
    const clean = [];
    for (const m of data.macros) {
      if (!isPlainObj(m) || typeof m.name !== 'string') { dropped++; continue; }
      const events = (Array.isArray(m.events) ? m.events : []).filter((e) =>
        isPlainObj(e) && Number.isFinite(e.at) && (e.kind === 'dn' || e.kind === 'up') && Number.isFinite(e.code));
      clean.push({ id: Number.isInteger(m.id) && m.id > 0 ? m.id : 0, name: m.name, events });
      macN++;
    }
    let next = Math.max(0, ...clean.map((m) => m.id));
    const seen = new Set();
    for (const m of clean) {
      if (m.id > 0 && !seen.has(m.id)) seen.add(m.id);
      else m.id = ++next;
    }
    state.macros = clean;
  }
  save();
  return { cfgs: cfgN, macros: macN, dropped };
}

export function setCfg(cfg) {
  state.cfg = cfg;
  if (state.slug) { state.cfgs[state.slug] = cfg; save(); }
  emit('cfg', cfg);
}

// 修改当前配置（自动持久化 + 广播）
export function updateCfg(patch) {
  Object.assign(state.cfg, patch);
  setCfg(state.cfg);
}

export function loadCfgFor(slug, model) {
  state.slug = slug;
  state.model = model;
  state.cfg = state.cfgs[slug] || defaultCfg(model);
  setCfg(state.cfg);
}
