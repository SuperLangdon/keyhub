// 语言包加载与缓存 + 词条查找
// assets/i18n/{code}.json 每语言一份：tc_* 平级键 = 原驱动语言包词条（zh/en/kr 齐全，
// 键名与驱动资源一致，勿改）；app.* 分组 = 本应用界面文案（zh/en；kr 未译，查找时回退 en）。
// 文案中的 {x} 为插值占位符，调用方以 t(key, { x: 值 }) 填充。
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

// 点路径查找：'app.nav.lighting' → pack.app.nav.lighting；不含点的键（tc_*）平级直取
function lookup(pack, key) {
  if (!pack) return undefined;
  if (Object.prototype.hasOwnProperty.call(pack, key)) {
    return typeof pack[key] === 'string' ? pack[key] : undefined;
  }
  let o = pack;
  for (const seg of key.split('.')) {
    o = o?.[seg];
    if (o === undefined) return undefined;
  }
  return typeof o === 'string' ? o : undefined;
}

// t(key, params)：当前语言 → en 兜底（kr 缺 app 段）→ 键名本身（漏键直接可见，便于排查）。
// 空串视为缺失（驱动包部分键在个别语言留空）。
export function t(key, params) {
  let v = lookup(current, key);
  if (v === undefined || v === '') v = lookup(cache.en, key);
  if (v === undefined || v === '') return key;
  if (params) for (const [k, val] of Object.entries(params)) v = v.split('{' + k + '}').join(String(val));
  return v;
}

// ---- 灯效名（三种语言的 tc_kb_led1..19 都从第 1 个效果开始编号，led20=关闭） ----
export function fxName(ui) {
  return t('tc_kb_led' + ui);
}
export function fxOffName() {
  return t('tc_kb_led20');
}
export const FX_CUSTOM_UI = 19; // 自定义模式槽位
