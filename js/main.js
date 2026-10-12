// KeyHub — 启动与导航
// 构建标记：改动 js 后递增，用于日志中核对浏览器是否拿到最新代码（避免模块缓存误导调试）
export const BUILD = '2026-10-12.38（门禁：确认按钮勾选态初始同步，修复刷新后勾选不解锁）';
import { loadLang, setLang, L } from './i18n.js';
import { state, restore, save, loadCfgFor, on } from './store.js';
import { KeyboardView } from './keyboard/render.js';
import { LightSim } from './keyboard/lightsim.js';
import { device, devLog } from './device/index.js';
import { initConnectHero, openDemoPicker, addDemoRecord } from './connect.js';
import { initPanel } from './device/panel.js';
import { h, toast } from './ui.js';
import { iconEl } from './ui-icons.js';
import { setFuncLang } from './vk.js';
import { renderLightPage, cleanupLightPage } from './pages/light.js';
import { renderKeysPage, cleanupKeysPage } from './pages/keys.js';
import { renderMacroPage, cleanupMacroPage } from './pages/macro.js';
import { renderSettingsPage } from './pages/settings.js';
import { CODE_VK } from './codevk.js';

// ---------- 欢迎页（主页连接中心由 connect.js 渲染，型号选择走「添加设备」向导） ----------
async function enterApp(meta) {
  const model = await (await fetch(`assets/models/${meta.slug}/model.json`)).json();
  model.slug = meta.slug;
  loadCfgFor(meta.slug, model);
  document.getElementById('welcome').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('tb-model-name').textContent = model.short;
  document.getElementById('tb-model-sub').textContent = model.sub + ' · ' + model.name;
  bootModel(model);
  save();
}

// ---------- 主界面 ----------
const ctx = {
  view: null,
  lightsim: null,
  paintMode: false,
  onKeyClick: null,
  _paintHandler: null,
  setPaintHandler(fn) { this._paintHandler = fn; },
  onPaintMode(on) {
    this.paintMode = on;
    this.view?.setPaintMode(on);
    if (this.lightsim) this.lightsim.paintMode = on;
  },
  keyElByVk(vk) {
    const k = state.model?.keys.find((x) => x.vk === vk);
    return k ? ctx.view?.keyEls.get(k.i) : null;
  },
};

const PAGES = [
  { id: 'light', icon: 'lightbulb', name: () => L('灯光', 'Lighting'), mod: () => import('./pages/light.js') },
  { id: 'keys', icon: 'keyboard', name: () => L('按键', 'Keys'), mod: () => import('./pages/keys.js') },
  { id: 'macro', icon: 'codeXml', name: () => L('宏', 'Macros'), mod: () => import('./pages/macro.js') },
  { id: 'settings', icon: 'settings', name: () => L('设置', 'Settings'), mod: () => import('./pages/settings.js') },
];
let curPageMod = null;

function buildNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const p of PAGES) {
    if (p.cond && !p.cond()) continue;
    const b = h('button', { class: 'nav-btn' + (state.page === p.id ? ' on' : '') },
      iconEl(p.icon, 18), h('span', { text: p.name() }),
    );
    b.addEventListener('click', () => switchPage(p.id));
    nav.appendChild(b);
  }
}

async function switchPage(id) {
  state.page = id;
  curPageMod?.cleanup?.(ctx);
  curPageMod = null;
  buildNav();
  const host = document.getElementById('page');
  host.innerHTML = '';
  const p = PAGES.find((x) => x.id === id);
  const mod = await p.mod();
  mod[`render${id[0].toUpperCase() + id.slice(1)}Page`](host, ctx);
  curPageMod = mod;
}

async function bootModel(model) {
  ctx.view = new KeyboardView(document.getElementById('kb-view'));
  await ctx.view.setModel(model);
  ctx.lightsim = new LightSim();
  ctx.lightsim.setModel(model);
  ctx.lightsim.setConfig(state.cfg);
  ctx.lightsim.paintMode = ctx.paintMode;
  // 配置变化（效果/颜色/亮度/速度/涂色/动画）实时反映到模拟器
  on('cfg', (cfg) => ctx.lightsim?.setConfig(cfg));

  ctx.view.onKeyClick = (i) => {
    ctx.lightsim.press(i);
    ctx.onKeyClick?.(i);
  };
  ctx.view.onKeyPaint = (i) => ctx._paintHandler?.(i);

  buildNav();
  switchPage(state.page && PAGES.some((p) => p.id === state.page) ? state.page : 'light');
  startRenderLoop();
}

let rafId = 0;
function startRenderLoop() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    rafId = requestAnimationFrame(loop);
    if (!ctx.lightsim || !ctx.view) return;
    const colors = ctx.lightsim.render(performance.now());
    ctx.view.draw(colors);
  };
  loop();
}

// ---------- 全局语言切换（门页 / 主页 EN·CN 按钮与应用内下拉共用） ----------
async function switchLang(lang) {
  if (state.lang === lang) return;
  state.lang = lang;
  applyGateTexts(lang); // 门页文案 + 全部 .lang-item 选中态
  await applyLang();
  save();
  applyTheme(); // 同步主题按钮提示文案
  updateModeTag(); // 会话模式标签随语言重渲染
  heroCtl?.refresh(); // 主页 hero 文案随语言重渲染
  if (state.slug) { buildNav(); switchPage(state.page); }
  toast(L('语言已切换', 'Language switched'));
}

// ---------- 顶栏 / 调试台 ----------
// 会话模式标签：演示会话（模拟器）在型号名旁显示「演示」药丸，真机会话隐藏——
// 让「设置改的是模拟器还是键盘」在界面上一眼可辨
function updateModeTag() {
  const el = document.getElementById('tb-mode');
  if (!el) return;
  el.textContent = L('演示', 'Demo');
  el.classList.toggle('hidden', device.mode === 'hid');
}

function wireChrome() {
  document.getElementById('btn-back').addEventListener('click', showWelcome);
  document.querySelector('.logo').addEventListener('click', showWelcome);
  document.getElementById('btn-back').replaceChildren(iconEl('house', 18));

  wireThemeToggle(document.getElementById('btn-theme'));

  on('device', updateModeTag); // 会话中拔线 / 断开时同步
  updateModeTag();

  initPanel();
}

function showWelcome() {
  cancelAnimationFrame(rafId);
  curPageMod?.cleanup?.(ctx);
  curPageMod = null;
  ctx.view = null;
  ctx.lightsim = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('welcome').classList.remove('hidden');
  document.getElementById('kb-view').innerHTML = '';
  heroCtl?.refresh(); // 回到主页时同步连接中心状态（真机已连接 / 待连接）
}

async function applyLang() {
  await loadLang(state.lang);
  await loadLang(state.lang === 'zh' ? 'en' : 'zh'); // 预载另一语言，切换即时
  setLang(state.lang);
  setFuncLang(state.lang !== 'zh');
}

// ---------- 免责声明门：确认后才能进入型号选择 ----------
// 声明文案有实质变更时把版本号 +1，已确认过的用户会重新看到门禁
const GATE_VER = 1;
const GATE_TEXT = {
  zh: {
    badge: '非官方 · 开源驱动实现',
    desc: '本站是 LEOBOG ONE 官方桌面驱动的<b>开源网页复刻</b>，与 LEOBOG 官方无关。设备通信协议来自同芯片键盘（AULA F75 / F87 Pro，SINO WEALTH 方案）的'
      + '<a href="https://github.com/marcoslor/Aula-F87-Controller" target="_blank" rel="noreferrer">开源逆向项目</a>'
      + '；型号数据、语言包与灯效帧解析自官方驱动安装包。',
    warn: '协议<b>未经原厂键盘实测</b>，向真机写入配置可能出现预期之外的行为（灯光异常、配置错乱等）。使用本工具对设备造成的任何影响，<b>后果由使用者自行承担</b>。',
    agree: '我已了解这是非官方开源实现，自愿承担全部使用风险',
    enter: '确认并进入',
  },
  en: {
    badge: 'Unofficial · Open-source driver',
    desc: 'This site is an <b>open-source web replica</b> of the official LEOBOG ONE desktop driver, not affiliated with LEOBOG. The device protocol comes from '
      + '<a href="https://github.com/marcoslor/Aula-F87-Controller" target="_blank" rel="noreferrer">open-source reverse engineering</a>'
      + ' of keyboards sharing the same chip (AULA F75 / F87 Pro, SINO WEALTH platform); model data, language packs and light frames are parsed from the official driver package.',
    warn: 'The protocol is <b>untested against real keyboards</b>; writing configs to a real device may behave unexpectedly (lighting glitches, corrupted settings, etc.). <b>Use at your own risk.</b>',
    agree: 'I understand this is an unofficial open-source implementation and I accept all risks of using it',
    enter: 'Agree & Enter',
  },
};

function applyGateTexts(lang) {
  const txt = GATE_TEXT[lang === 'en' ? 'en' : 'zh'];
  document.getElementById('gate-badge').textContent = txt.badge;
  document.getElementById('gate-desc').innerHTML = txt.desc;
  document.getElementById('gate-warn-text').innerHTML = txt.warn;
  document.getElementById('gate-agree-text').textContent = txt.agree;
  document.getElementById('gate-enter').textContent = txt.enter;
  document.querySelectorAll('.lang-item').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang)); // 三页语言菜单选中态
  const demoTitle = lang === 'en'
    ? 'Demo mode: pick a model — a demo card is added on the home page'
    : '演示模式：选个型号，主页添加演示设备并进入体验';
  for (const id of ['gate-demo', 'welcome-demo']) {
    const b = document.getElementById(id);
    if (b) b.title = demoTitle; // 本函数在 setLang 前调用，不能走 L()
  }
}

// ---------- 日/夜间主题 ----------
function applyTheme() {
  const dark = state.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const icon = dark ? 'sun' : 'moon'; // 图标指向切换后的目标
  const title = L('切换日/夜间模式', 'Toggle day/night mode');
  for (const id of ['gate-theme', 'welcome-theme', 'btn-theme']) {
    const btn = document.getElementById(id);
    if (btn) { btn.replaceChildren(iconEl(icon, 18)); btn.title = title; }
  }
}

function wireThemeToggle(btn) {
  btn.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    save();
  });
}

// 语言图标按钮 → 下拉菜单（门禁页 / 主页 / 应用顶栏三处统一）
function wireLangMenus() {
  document.querySelectorAll('.lang-wrap').forEach((wrap) => {
    const btn = wrap.querySelector('.icon-btn');
    const menu = wrap.querySelector('.lang-menu');
    btn.replaceChildren(iconEl('languages', 18));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.lang-menu.open').forEach((m) => { if (m !== menu) m.classList.remove('open'); });
      menu.classList.toggle('open');
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
    menu.querySelectorAll('.lang-item').forEach((b) => {
      b.addEventListener('click', () => {
        menu.classList.remove('open');
        switchLang(b.dataset.lang);
      });
    });
  });
  document.addEventListener('click', () => document.querySelectorAll('.lang-menu.open').forEach((m) => m.classList.remove('open')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.lang-menu.open').forEach((m) => m.classList.remove('open')); });
}

function wireGate() {
  const agree = document.getElementById('gate-agree');
  const enter = document.getElementById('gate-enter');
  // 按钮解锁不能只依赖 change：浏览器刷新 / 会话恢复会还原复选框的勾选态但不触发 change，
  // 会卡在「已勾选但按钮仍禁用」。初始同步 + pageshow（bfcache 恢复后也会再触发一次）兜底。
  const syncEnter = () => { enter.disabled = !agree.checked; };
  agree.addEventListener('change', syncEnter);
  addEventListener('pageshow', syncEnter);
  syncEnter();
  enter.addEventListener('click', () => {
    if (agree.checked) {
      state.gateAck = GATE_VER; // 整个生命周期只确认一次
      save();
      document.getElementById('gate').classList.add('hidden'); // welcome 一直在底层渲染，无需再切显示
      devLog('in', '用户已确认开源免责声明。');
    }
  });
  // 门禁页 / 主页右上角：演示模式全流程入口——选型号 → 主页添加「演示」设备卡片 → 直接进入体验
  const openDemo = async () => {
    const meta = await openDemoPicker();
    if (!meta) return;
    addDemoRecord(meta);
    if (device.mode === 'hid') device.disconnect(); // 演示会话 = 纯模拟器，不向真机下发
    toast(L(`已添加「${meta.short}」演示设备`, `Demo device "${meta.short}" added`));
    enterApp(meta);
  };
  for (const id of ['gate-demo', 'welcome-demo']) {
    document.getElementById(id).replaceChildren(iconEl('play', 18));
    document.getElementById(id).addEventListener('click', openDemo);
  }
  // 三页右上角统一的语言菜单 + 日/夜间切换
  wireLangMenus();
  wireThemeToggle(document.getElementById('gate-theme'));
  wireThemeToggle(document.getElementById('welcome-theme'));
  applyTheme();
  applyGateTexts(state.lang);
}

// ---------- 启动 ----------
let heroCtl = null;

(async function main() {
  try {
    restore();
    if (state.gateAck >= GATE_VER) document.getElementById('gate').classList.add('hidden'); // 已确认过则不再弹门禁
    await applyLang();
    wireChrome();
    heroCtl = initConnectHero(enterApp); // 主页连接中心：动画 + 添加新设备向导
    wireGate();
    devLog('in', `KeyHub 已启动（演示模式）[${BUILD}]。连接真机：回主页「添加新设备」。`);
    window.__dbg = { state, ctx, device }; // 调试句柄
    document.querySelectorAll('[data-icon]').forEach((el) => el.replaceChildren(iconEl(el.dataset.icon, 14)));
  } catch (e) {
    window.__bootError = (e && e.stack) || String(e);
    throw e;
  }
})();
