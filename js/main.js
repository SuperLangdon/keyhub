// KeyHub — 启动与导航
// 构建标记（store.js 定义，main 再导出）：改动 js 后递增，用于日志/诊断包中核对
// 浏览器是否拿到最新代码（避免模块缓存误导调试）
import { loadLang, setLang, t } from './i18n.js';
import { state, restore, save, loadCfgFor, on, BUILD } from './store.js';
export { BUILD };
import { KeyboardView } from './keyboard/render.js';
import { LightSim } from './keyboard/lightsim.js';
import { device, devLog } from './device/index.js';
import { initConnectHero, openDemoPicker, addDemoRecord, autoConnect } from './connect.js';
import { initPanel } from './device/panel.js';
import { h, toast } from './ui.js';
import { iconEl } from './ui-icons.js';
// 各功能页由 PAGES 的 mod() 动态 import 按需加载（switchPage 调用），
// 不要在此静态引入——会让懒加载失效、启动全量拉取。

// ---------- 欢迎页（主页连接中心由 connect.js 渲染，型号选择走「添加设备」向导） ----------
async function enterApp(meta) {
  let model;
  try {
    const r = await fetch(`assets/models/${meta.slug}/model.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    model = await r.json();
  } catch (e) {
    console.error(e);
    toast(t('app.common.modelLoadFail', { slug: meta.slug, msg: e.message }), true);
    return; // 留在欢迎页，不进入残缺会话
  }
  model.slug = meta.slug;
  loadCfgFor(meta.slug, model);
  document.getElementById('welcome').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('tb-model-name').textContent = model.short;
  document.getElementById('tb-model-sub').textContent = model.sub + ' · ' + model.name;
  device.configureModel(model); // K65（fw≠24）= 520B 走 report 9（布局同 LEOBOG）
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
  { id: 'light', icon: 'lightbulb', name: () => t('app.nav.lighting'), mod: () => import('./pages/light.js') },
  { id: 'keys', icon: 'keyboard', name: () => t('app.nav.keys'), mod: () => import('./pages/keys.js') },
  { id: 'screen', icon: 'pip', name: () => t('app.nav.screen'), mod: () => import('./pages/screen.js'),
    cond: () => !!state.model?.screen }, // 仅带屏型号（K65：model.screen 由 KB.ini ShowScreen/siScreen 生成）
  { id: 'macro', icon: 'codeXml', name: () => t('app.nav.macros'), mod: () => import('./pages/macro.js') },
  { id: 'settings', icon: 'settings', name: () => t('app.nav.settings'), mod: () => import('./pages/settings.js') },
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
  document.getElementById('page-top')?.replaceChildren(); // 页面级横幅（灯光总开关等）随切页清空
  const p = PAGES.find((x) => x.id === id);
  try {
    const mod = await p.mod();
    mod[`render${id[0].toUpperCase() + id.slice(1)}Page`](host, ctx);
    curPageMod = mod;
  } catch (e) {
    // 模块加载失败 / 页面渲染异常：给出可见反馈，不让导航停在空白页
    console.error(e);
    host.replaceChildren(h('p', { class: 'dim', style: 'padding:20px' },
      t('app.common.pageLoadFailDetail', { id, msg: e.message })));
    toast(t('app.common.pageLoadFail'), true);
  }
}

async function bootModel(model) {
  // 重复进入（如真机识别等待期间连点设备卡片）时先清掉旧视图——#kb-view 是 flex 行，
  // 残留多个 .kb-view 会并排叠出多份键盘底图
  document.getElementById('kb-view').replaceChildren();
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
  await applyLang(); // 先就位语言包再刷新界面（data-i18n 静态文案随 applyLang 写入）
  syncLangMenuSel(); // 三页语言菜单选中态
  save();
  applyTheme(); // 同步主题按钮提示文案
  updateModeTag(); // 会话模式标签随语言重渲染
  heroCtl?.refresh(); // 主页 hero 文案随语言重渲染
  if (state.slug) { buildNav(); switchPage(state.page); }
  // 不 toast「语言已切换」：整个界面即刻换语，本身就是反馈
}

// ---------- 顶栏 / 调试台 ----------
// 会话模式标签：演示会话（模拟器）在型号名旁显示「演示」药丸，真机会话隐藏——
// 让「设置改的是模拟器还是键盘」在界面上一眼可辨
function updateModeTag() {
  const el = document.getElementById('tb-mode');
  if (!el) return;
  el.textContent = t('app.common.demo');
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
  applyStaticI18n(); // HTML 静态文案（data-i18n-*）与 <title> 同步当前语言
}

// HTML 静态文案本地化：元素带 data-i18n-text/-html/-title/-aria/-placeholder 属性，
// 值为语言包键名；applyLang 时统一扫描写入（与 JS 渲染的页面文案同语言，切语言即刷新）。
function applyStaticI18n() {
  document.title = t('app.appTitle');
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
  for (const el of document.querySelectorAll('[data-i18n-text]')) el.textContent = t(el.dataset.i18nText);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}

// ---------- 免责声明门：确认后才能进入型号选择 ----------
// 声明文案存于语言包 app.gate.*（HTML 节点带 data-i18n-* 属性，applyStaticI18n 统一写入）。
// 声明文案有实质变更时把版本号 +1，已确认过的用户会重新看到门禁
// （v2：项目从 LEOBOG 单品牌扩展为多厂商型号注册表，措辞随之改为按注册表表述）
const GATE_VER = 2;

// 三页语言菜单（门禁页 / 主页 / 应用顶栏）的选中态指示
function syncLangMenuSel() {
  document.querySelectorAll('.lang-item').forEach((b) => b.classList.toggle('on', b.dataset.lang === state.lang));
}

// ---------- 日/夜间主题 ----------
function applyTheme() {
  const dark = state.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const icon = dark ? 'sun' : 'moon'; // 图标指向切换后的目标
  const title = t('app.topbar.toggleTheme');
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
    enterApp(meta); // 直接进入该型号——界面切换即反馈，不再 toast
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
  syncLangMenuSel();
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
    autoConnect(); // 此前授权过的键盘开页即连（Chrome 仅首次「添加设备」时授权一次）
    devLog('in', `KeyHub 已启动（演示模式）[${BUILD}]。连接真机：回主页「添加新设备」。`);
    window.__dbg = { state, ctx, device }; // 调试句柄
    document.querySelectorAll('[data-icon]').forEach((el) => el.replaceChildren(iconEl(el.dataset.icon, 14)));
  } catch (e) {
    window.__bootError = (e && e.stack) || String(e);
    throw e;
  }
})();
