// 语言包加载与缓存 + 应用自带的双语标签
const cache = {};

export async function loadLang(code) {
  if (cache[code]) return cache[code];
  const r = await fetch(`assets/i18n/${code}.json`);
  if (!r.ok) throw new Error('i18n load fail: ' + code);
  cache[code] = await r.json();
  return cache[code];
}

let current = null;
let currentCode = 'zh';

export function setLang(code) {
  current = cache[code] || null;
  currentCode = code;
}

export function lang() { return currentCode; }

// t(key, fallback)：取原驱动语言包词条
export function t(key, fallback) {
  if (!current) return fallback ?? key;
  const v = current[key];
  return (v === undefined || v === '') ? (fallback ?? key) : v;
}

// L(zh, en)：应用界面自用双语（原语言包的通用词条存在错位，不用作界面骨架）
export function L(zh, en) {
  return currentCode === 'zh' ? zh : en;
}

// ---- 灯效名（三种语言的 tc_kb_led1..19 都从第 1 个效果开始编号，led20=关闭） ----
export function fxName(ui) {
  return t('tc_kb_led' + ui, '效果 ' + ui);
}
export function fxOffName() {
  return t('tc_kb_led20', L('关闭灯光', 'Light OFF'));
}
export const FX_CUSTOM_UI = 19; // 自定义模式槽位
