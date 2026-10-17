// 一次性资源转换器：原驱动安装包（仓库外 ../origin_installer/，不入库） -> assets/
// Usage:
//   node tools/convert.mjs                     全量重跑主源（LEOBOG，重写全部型号 + i18n + index）
//   node tools/convert.mjs <src> [src…]        增量模式：额外驱动源（解包目录，含 Dev/kb），
//                                              只转换其中的新型号并合并进 index.json，不动 i18n
//   node tools/convert.mjs <src> --contributor <名字>
//                                              社区贡献：未登记的 ShortName 自动派生 slug 收录，
//                                              元数据写入 contributor（source/attribution 规范见
//                                              docs/registry-schema.md）
// 例：node tools/convert.mjs "E:\Dev\Playground\yindiao_k65\source"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(ROOT, '..', 'origin_installer', 'LEOBOG ONE Setup v2.0 20250527');
const OUT = path.join(ROOT, 'assets');

// ---------- VK tables ----------
const VK_NAME = new Map([
  [0x08, 'Backspace'], [0x09, 'Tab'], [0x0D, 'Enter'], [0x13, 'Pause'], [0x14, 'Caps Lock'],
  [0x1B, 'Esc'], [0x20, 'Space'], [0x21, 'PgUp'], [0x22, 'PgDn'], [0x23, 'End'], [0x24, 'Home'],
  [0x25, '←'], [0x26, '↑'], [0x27, '→'], [0x28, '↓'], [0x2C, 'Print Screen'], [0x2D, 'Insert'],
  [0x2E, 'Delete'], [0x5B, 'Win'], [0x5D, 'App'], [0x90, 'Num Lock'], [0x91, 'Scroll Lock'],
  [0xA0, 'LShift'], [0xA1, 'RShift'], [0xA2, 'LCtrl'], [0xA3, 'RCtrl'], [0xA4, 'LAlt'], [0xA5, 'RAlt'],
  [0xBA, ';'], [0xBB, '='], [0xBC, ','], [0xBD, '-'], [0xBE, '.'], [0xBF, '/'], [0xC0, '`'],
  [0xDB, '['], [0xDC, '\\'], [0xDD, ']'], [0xDE, "'"], [0xFA, 'FN'],
  [0x01, 'Mouse L'], [0x02, 'Mouse R'], [0x04, 'Mouse M'],
]);
for (let i = 0; i < 10; i++) VK_NAME.set(0x30 + i, String(i));
for (let i = 0; i < 26; i++) VK_NAME.set(0x41 + i, String.fromCharCode(65 + i));
for (let i = 0; i < 12; i++) VK_NAME.set(0x70 + i, 'F' + (i + 1));
for (let i = 0; i < 10; i++) VK_NAME.set(0x60 + i, 'Num' + i);
Object.assign(VK_NAME, new Map([[0x6A, 'Num*'], [0x6B, 'Num+'], [0x6D, 'Num-'], [0x6E, 'Num.'], [0x6F, 'Num/']]));

// ET/Cartoon key-name -> candidate VKs (driver's text_to_vk)
const NAME_VK = new Map([
  ['esc', [0x1B]], ['tab', [0x09]], ['caps', [0x14]], ['enter', [0x0D]], ['back', [0x08]],
  ['space', [0x20]], ['space2', [0x20]], ['del', [0x2E]], ['home', [0x24]], ['end', [0x23]],
  ['pgup', [0x21]], ['pgdn', [0x22]], ['up', [0x26]], ['down', [0x28]], ['left', [0x25]], ['right', [0x27]],
  ['shift', [0xA0]], ['rshift', [0xA1]], ['ctrl', [0xA2]], ['rctrl', [0xA3]],
  ['alt', [0xA4]], ['ralt', [0xA5]], ['lalt', [0xA4]], ['win', [0x5B]], ['fn', [0xFA]],
  ['app', [0x5D]], ['print', [0x2C]], ['scroll', [0x91]], ['pause', [0x13]], ['insert', [0x2D]],
  ['~', [0xC0]], ['`', [0xC0]], ['-', [0xBD]], ['_', [0xBD]], ['=', [0xBB]], ['+', [0xBB]],
  ['[', [0xDB]], ['{', [0xDB]], [']', [0xDD]], ['}', [0xDD]], ['\\', [0xDC]], ['|', [0xDC]],
  [';', [0xBA]], [':', [0xBA]], ["'", [0xDE]], ['"', [0xDE]], [',', [0xBC]], ['<', [0xBC]],
  ['.', [0xBE]], ['>', [0xBE]], ['/', [0xBF]], ['?', [0xBF]],
  ['sf1', [0x42]], // tc_sf1 = "B"
  ['num0', [0x60]], ['num1', [0x61]], ['num2', [0x62]], ['num3', [0x63]], ['num4', [0x64]],
  ['num5', [0x65]], ['num6', [0x66]], ['num7', [0x67]], ['num8', [0x68]], ['num9', [0x69]],
  ['k45', [0x64]], ['k56', [0x65]], // 驱动键名 kNN = 小键盘数字（K65 动画 wheel_unit 用到 k56） ['numlock', [0x90]], ['numenter', [0x0D]], ['ins', [0x2D]],
  ['num/', [0x6F]], ['num*', [0x6A]], ['num-', [0x6D]], ['num+', [0x6B]], ['num.', [0x6E]],
  ['rwin', [0x5C]], ['mute', [0xAD]], ['cal', [0x98]], ['mail', [0xB4]], ['media', [0xB3]], ['calc', [0x98]],
]);
for (let i = 0; i < 10; i++) NAME_VK.set(String(i), [0x30 + i]);
for (let i = 0; i < 26; i++) NAME_VK.set(String.fromCharCode(97 + i), [0x41 + i]);
for (let i = 0; i < 12; i++) NAME_VK.set('f' + (i + 1), [0x70 + i]);

function parseIni(text) {
  const sections = {}; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    const mSec = line.match(/^\[(.+)\]$/);
    if (mSec) { cur = sections[mSec[1]] = {}; continue; }
    const m = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (m && cur) cur[m[1].trim()] = m[2].trim();
  }
  return sections;
}

function parseNum(v) {
  if (v == null) return undefined;
  v = String(v).trim();
  if (/^0x/i.test(v)) return parseInt(v, 16);
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}
const numList = (s) => String(s || '').split(',').map((x) => parseInt(x.trim(), 10));
// Psd=3,0,0,0,0,A2 —— 原驱动按十六进制逐字节解析（OemDrv.exe 中 wcstoul(base=16)），型号识别用
const hexList = (s) => String(s || '').split(',').map((x) => parseInt(x.trim(), 16));

// keycode dword from "type,code,param" -> {type, code, param} (params may be dword-ish hex)
function parseFunc(parts) {
  const type = parseNum(parts[0]);
  const code = parseNum(parts[1]);
  const param = parts[2] != null ? (String(parts[2]).startsWith('0x') ? parseInt(parts[2], 16) : parseInt(parts[2], 10)) : 0;
  return { type, code, param: Number.isFinite(param) ? param >>> 0 : 0 };
}

// Decode a 0x09,0x01,dword special into a semantic object (for UI display)
export function decodeSpecial(dword) {
  const top = (dword >>> 24) & 0xFF;
  const b2 = (dword >>> 16) & 0xFF, b1 = (dword >>> 8) & 0xFF, b0 = dword & 0xFF;
  if (top === 0x07) return { kind: 'ledfx', effect: b0 };
  if (top === 0x08) {
    const which = { 0: 'power', 2: 'speed', 3: 'light', 4: 'direction' }[b2] || ('x' + b2);
    const dir = b1 === 1 ? 'up' : b1 === 2 ? 'down' : b1 === 0 ? 'toggle' : b1;
    return { kind: 'ledctl', which, dir };
  }
  if (top === 0x02) return { kind: 'consumer', usage: dword & 0xFFFF };
  if (top === 0x00 && (b2 === 0x04 || b2 === 0x08)) return { kind: 'special', raw: dword };
  return { kind: 'unknown', raw: dword };
}

function convertModel(dir) {
  const iniText = fs.readFileSync(path.join(dir, 'KB.ini'), 'latin1');
  const { OPT: opt, KEY, FN1 } = parseIni(iniText);

  const keys = [];
  for (const [k, v] of Object.entries(KEY || {})) {
    const idx = parseInt(k.slice(1), 10);
    const parts = v.split(',').map((s) => s.trim());
    if (parts.length < 8) continue;
    const [l, t, r, b] = parts.slice(0, 4).map((x) => parseInt(x, 10));
    const f = parseFunc(parts.slice(4));
    keys.push({ i: idx, r: [l, t, r, b], vk: f.type === 0x02 ? f.code : null, fn: f, matrix: parseInt(parts[7], 10) });
  }
  keys.sort((a, b) => a.i - b.i);

  const fn1 = {};
  for (const [k, v] of Object.entries(FN1 || {})) {
    const idx = parseInt(k.slice(1), 10);
    fn1[idx] = parseFunc(v.split(',').map((s) => s.trim()));
  }

  const optOut = {};
  for (const [k, v] of Object.entries(opt)) {
    if (/^(VID|PID|Fw|LayerNum|SleepTime|ChannelMask|ShowPower|ShowEffect|ShowMusic|ShowLED|MusicMask|MusicUI|ShowDebounce|FnAlign|ShowTapTip|DefLedIndex|GaoshouGroupNum|GaoshouIndex|LedMask|WheelMode|KnobIndex|KbLayout|KbDrawType|CRC|IC2481|FillKeyWhenHasFunc|FwVerNeedToUpdate|ShowDebounce|MatrixLen|MacroBufferSize)$/.test(k)) {
      optOut[k] = parseNum(v);
    } else if (/^(VID_Wireless|PID_Wireless)$/.test(k)) {
      optOut[k] = parseNum(v);
    } else if (/^clr|^Psd|^Name$|^ShortName$|^Light|^Speed|^RGBIndex|^GameRGBIndex|^GaoshouKey|^KeyNotToSet|^MusicRGBIndex/.test(k)) {
      optOut[k] = v;
    }
  }

  // LED effect table: uiIndex, fwEffect, hasSpeed, hasLight, hasDirection, hasRandomColor, hasColor
  const ledopts = [];
  for (let n = 1; n <= 30; n++) {
    const row = opt[`LedOpt${n}`];
    if (!row) continue;
    const c = numList(row);
    if (c[0] === 0 && n > 1 && c[1] === 0) continue;
    ledopts.push({ ui: c[0], fw: c[1], speed: c[2] === 1, light: c[3] === 1, dir: c[4] === 1, rand: c[5] === 1, color: c[6] === 1 });
  }
  ledopts.sort((a, b) => a.ui - b.ui);

  // Animations (ET / Cartoon)
  const animations = {};
  for (const sub of ['ET', 'Cartoon']) {
    const p = path.join(dir, sub);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p).filter((x) => x.endsWith('.txt'))) {
      const name = f.replace(/\.txt$/, '').replace(/_unit$/, '');
      const lines = fs.readFileSync(path.join(p, f), 'latin1').split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith(';'))
        .map((line) => {
          const mColor = line.match(/[:,]\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
          const color = mColor ? [Number(mColor[1]), Number(mColor[2]), Number(mColor[3])] : null;
          const body = mColor ? line.slice(0, mColor.index) : line;
          const groups = body.split(':').map((g) => {
            const idxs = [];
            for (const tok of g.split(',')) {
              const name0 = tok.trim().toLowerCase();
              if (!name0) continue;
              if (/^k\d+$/.test(name0)) { idxs.push(parseInt(name0.slice(1), 10)); continue; }
              const vks = NAME_VK.get(name0);
              if (!vks) { warn(`${dir}:${f}: unresolved key name "${tok}"`); continue; }
              for (const key of keys) if (vks.includes(key.vk)) idxs.push(key.i);
            }
            return [...new Set(idxs)];
          });
          return { groups: groups.filter((g) => g.length), color };
        });
      animations[sub.toLowerCase() + '/' + name] = lines;
    }
  }

  const imgSize = imageSize(path.join(dir, 'keyimg.png'));
  // 屏幕能力（银雕 K65 等带屏型号）：ShowScreen=1 时记录尺寸/帧上限，
  // siScreen=宽,高 / MaxScreenFrame=帧数上限（KB.ini 原值）
  const showScreen = parseNum(opt.ShowScreen);
  const siScreen = String(opt.siScreen || '').split(',').map((x) => parseInt(x.trim(), 10));
  const screen = showScreen && siScreen.length === 2 && siScreen.every(Number.isFinite) ? {
    w: siScreen[0], h: siScreen[1],
    maxFrames: parseNum(opt.MaxScreenFrame) || 80,
  } : null;
  return {
    dir: path.basename(dir),
    name: opt.Name, short: opt.ShortName,
    vid: parseNum(opt.VID), pid: parseNum(opt.PID),
    vidW: parseNum(opt.VID_Wireless), pidW: parseNum(opt.PID_Wireless),
    fw: parseNum(opt.Fw), layerNum: parseNum(opt.LayerNum) || 4,
    sleepTime: parseNum(opt.SleepTime), channelMask: parseNum(opt.ChannelMask),
    // LedMask：第 N-1 位=1 → 原驱动 UI 隐藏第 N 个效果（固件未实现；反汇编 0x434E6D 的 test+jne）
    ledMask: parseNum(opt.LedMask),
    show: { power: !!parseNum(opt.ShowPower), music: !!parseNum(opt.ShowMusic), musicUI: opt.MusicUI !== undefined ? !!parseNum(opt.MusicUI) : true, tapTip: !!parseNum(opt.ShowTapTip), debounce: parseNum(opt.ShowDebounce) },
    wheel: { mode: parseNum(opt.WheelMode), knobIndex: parseNum(opt.KnobIndex) },
    screen,
    colors: { ov: numList(opt.clrKeyOv), dn: numList(opt.clrKeyDn), hasFunc: numList(opt.clrKeyHasFunc) },
    gaoshouKeys: numList(opt.GaoshouKey1).map((x) => x), gaoshouIndex: parseNum(opt.GaoshouIndex),
    brightness: numList(opt.Light), speed: numList(opt.Speed),
    // K65 版驱动实证（2026-10 REA，OemDrv.exe 0x491430 FillCfg）：配置效果参数对写的是
    // LightHW[UI 档]/SpeedHW[UI 档]（KB.ini Light/LightHW、Speed/SpeedHW 两张表映射后写入），
    // 睡眠字节写 SleepHW[档]（SleepUI/SleepHW 分钟表；缺省 UI=[30..1200]、HW=分钟/30）。
    // LEOBOG 无 LightHW 行 → 驱动回退 HW=UI 恒等（fw24 直写 UI 档即正确，真机验证一致）。
    brightnessHw: opt.LightHW != null ? numList(opt.LightHW) : null,
    speedHw: opt.SpeedHW != null ? numList(opt.SpeedHW) : null,
    sleepUI: opt.SleepUI != null ? numList(opt.SleepUI) : null,
    sleepHW: opt.SleepHW != null ? numList(opt.SleepHW) : null,
    // CRC=1（K65）：有线键位层末槽强制 0xA5A5A5A5、每层按 MatrixLen 槽（缺省 128）全量下发
    // （FillMatrix 0x490D10）；MacroBufferSize 缺省 4096（驱动打包上限，先于 0x2800 静态数组上限生效）
    crc: parseNum(opt.CRC) ?? 0,
    matrixLen: parseNum(opt.MatrixLen) ?? null,
    macroBufferSize: parseNum(opt.MacroBufferSize) ?? null,
    psd: hexList(opt.Psd),
    defLedIndex: parseNum(opt.DefLedIndex),
    ledopts, keys, fn1, animations,
    img: { w: imgSize.w, h: imgSize.h },
  };
}

function imageSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; // PNG IHDR
}

// ---------- text.xml ----------
function convertLang(file) {
  const txt = fs.readFileSync(file, 'utf16le').replace(/^\uFEFF/, '');
  const out = {};
  const re = /<\s*(tc_[A-Za-z0-9_]+)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/g;
  let m;
  while ((m = re.exec(txt))) out[m[1]] = m[2].trim();
  return out;
}

// ---------- i18n zh/en 同步 ----------
// 原驱动 sc(简中)/en 两语言包的标签名有出入：en 用 tc_dclick、sc 用 tc_dbclick/tc_rdbclick
// 指同一批鼠标动作，en 还多出 tc_kb_led21/22 两个空词条。按语义互译补齐并删除单侧空词条，
// 使 zh/en 键集一致；kr 不在同步范围。若源包出现新的单侧差异，下方校验会打 warning。
const I18N_PATCH = {
  zh: { tc_dclick: '左键双击' },
  en: { tc_msfun: 'Mouse Buttons', tc_dbclick: 'Left Double Click', tc_rdbclick: 'Right Double Click' },
};
const I18N_DROP = [['en', 'tc_kb_led21'], ['en', 'tc_kb_led22']]; // 仅 en 存在的空词条
function syncI18n(langs) {
  for (const [code, patch] of Object.entries(I18N_PATCH)) Object.assign(langs[code], patch);
  for (const [code, key] of I18N_DROP) delete langs[code][key];
  // en 键盘特效名去下划线：原驱动英文包是 Fixed_on / Rainbow_wheel 式 snake_case，界面显示改空格
  for (const [k, v] of Object.entries(langs.en)) {
    if (/^tc_kb_led/.test(k) && typeof v === 'string') langs.en[k] = v.replace(/_/g, ' ');
  }
  const zk = new Set(Object.keys(langs.zh)), ek = new Set(Object.keys(langs.en));
  for (const k of [...zk].filter((k) => !ek.has(k))) warn(`i18n sync: key only in zh: ${k}`);
  for (const k of [...ek].filter((k) => !zk.has(k))) warn(`i18n sync: key only in en: ${k}`);
}

// ---------- main ----------
let warnings = [];
function warn(msg) { warnings.push(msg); }

fs.mkdirSync(path.join(OUT, 'models'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'i18n'), { recursive: true });

const kbRoot = path.join(SRC, 'Dev', 'kb');
const SLUG = { '2': 'hi75', 'A75': 'a75', 'Hi75C Pro': 'hi75c-pro', 'Hi8': 'hi8', 'Hi8SE': 'hi8se', 'Hi86': 'hi86', 'Hi98': 'hi98', 'Hi98 3-Mode': 'hi98-3mode', 'RGB': 'hi75-rgb' };
const SUB = { '2': '75% 客制化套件', 'A75': 'Alice 布局 · 三模 · 旋钮', 'Hi75C Pro': '75% Pro', 'Hi8': '全铝 · 三模', 'Hi8SE': '全铝 SE', 'Hi86': '86 键', 'Hi98': '98 键 · 有线', 'Hi98 3-Mode': '98 键 · 三模', 'RGB': '75% RGB · 旋钮' };

// ---------- 增量模式：额外驱动源 ----------
// 额外源里各型号的登记表（slug / 副标题 / model.json 的 dir 字段），按 KB.ini ShortName 索引。
// 未登记的 ShortName 不再跳过：自动派生 slug 收录（社区贡献主路径）。
const EXTRA_SLUG = {
  K65: { slug: 'k65', sub: '65% 三模 · 滚轮 · 屏幕', dir: 'K65' },
};

// ---------- 贡献元数据（docs/registry-schema.md 约定：溯源必填，validate-registry 强制） ----------
const ATTR_OFFICIAL = (vendor) => `keyimg.png 与适配数据派生自 ${vendor} 官方驱动安装包（版权归原作者所有，仅用于互操作适配）`;
// 主源（全量重跑也重建 index，元数据随之重建——保持注册表校验可过）
const MAIN_META = {
  source: { vendor: 'LEOBOG', driver: 'LEOBOG ONE Setup v2.0 20250527' },
  attribution: ATTR_OFFICIAL('LEOBOG'),
  contributor: 'SuperLangdon',
  added: '2026-10-11',
};
// 已收录额外型号的固化元数据（重跑增量时不丢 contributor/added；source 以现源为准可被覆盖）
const EXTRA_META = {
  k65: { source: { vendor: 'YINDIAO（银雕/BYCOMBO 同平台）', driver: 'yindiao_k65' }, contributor: 'SuperLangdon', added: '2026-10-12' },
};
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const today = () => new Date().toISOString().slice(0, 10);

// 转换一个额外驱动源里的全部型号并合并进 index.json。
// 单型号驱动（如银雕 K65）把 KB.ini 直接放在 Dev/kb/ 下；多型号驱动是子目录。
// 未登记的 ShortName 自动派生 slug 收录（slugify）；元数据规范见 docs/registry-schema.md，
// 重跑时保留既有条目的 contributor/added/attribution，只更新 source。
function convertExtra(src, contributor) {
  const kbDir = path.join(src, 'Dev', 'kb');
  if (!fs.existsSync(kbDir)) { warn(`extra: ${src} 无 Dev/kb，跳过`); return; }
  const modelDirs = fs.existsSync(path.join(kbDir, 'KB.ini'))
    ? [kbDir]
    : fs.readdirSync(kbDir).map((d) => path.join(kbDir, d)).filter((d) => fs.statSync(d).isDirectory());
  const indexPath = path.join(OUT, 'models', 'index.json');
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : [];
  const srcName = path.basename(src);
  for (const modelDir of modelDirs) {
    const model = convertModel(modelDir);
    const reg = EXTRA_SLUG[model.short] ?? {};
    const slug = reg.slug ?? slugify(model.short);
    if (!slug) { warn(`extra: ShortName "${model.short}"（${src}）无法派生目录安全的 slug，跳过`); continue; }
    model.slug = slug;
    model.sub = reg.sub ?? model.name; // 未登记型号副标题先用 KB.ini Name，PR 时人工润色
    if (reg.dir) model.dir = reg.dir;
    const outDir = path.join(OUT, 'models', slug);
    // slug 撞车守卫：同 slug 且 PSD 不同 = 不同厂商键盘共用了 ShortName（slugify 相同）。
    // 直接覆盖会静默抹掉前一位贡献者的型号数据——拒绝并提示登记 EXTRA_SLUG 指定独立 slug。
    const prevEntry = index.find((x) => x.slug === slug);
    const samePsd = prevEntry && Array.isArray(prevEntry.psd) && Array.isArray(model.psd)
      && prevEntry.psd.length === model.psd.length && prevEntry.psd.every((b, i) => b === model.psd[i]);
    if (prevEntry && !samePsd) {
      warn(`extra: ShortName "${model.short}"（${srcName}）派生的 slug "${slug}" 已被 "${prevEntry.name}"（PSD [${prevEntry.psd}]）占用，且本次 PSD 不同（[${model.psd}]）——疑似不同键盘同名，已跳过；确为新型号时请在 convert.mjs 的 EXTRA_SLUG 登记表指定独立 slug`);
      continue;
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(model));
    fs.copyFileSync(path.join(modelDir, 'keyimg.png'), path.join(outDir, 'keyimg.png'));
    const prev = index.find((x) => x.slug === slug) ?? {};
    const fixed = EXTRA_META[slug] ?? {};
    const entry = {
      slug, dir: model.dir, name: model.name, short: model.short, sub: model.sub,
      keys: model.keys.filter((k) => k.r[2] > k.r[0]).length, psd: model.psd,
      wired: { vid: model.vid, pid: model.pid }, wireless: model.vidW ? { vid: model.vidW, pid: model.pidW } : null,
      source: fixed.source ?? { vendor: srcName, driver: srcName },
      attribution: prev.attribution ?? fixed.attribution ?? ATTR_OFFICIAL(srcName),
      contributor: prev.contributor ?? fixed.contributor ?? contributor,
      added: prev.added ?? fixed.added ?? today(),
    };
    const at = index.findIndex((x) => x.slug === slug);
    if (at >= 0) index[at] = entry; else index.push(entry);
    console.log(`extra ${srcName}:${model.short} -> ${slug} (${model.keys.length} keys, ${Object.keys(model.animations).length} anims)`);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));
}

// --contributor <名字>：写入新收录型号的 contributor；其余参数为驱动源目录
let contributor = 'community';
const EXTRA_SRC = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--contributor') { contributor = process.argv[++i] ?? contributor; continue; }
  EXTRA_SRC.push(a);
}
if (EXTRA_SRC.length) {
  for (const src of EXTRA_SRC) convertExtra(src, contributor);
  console.log('\n贡献后续步骤（详见 CONTRIBUTING.md）：');
  console.log('  1. node tools/validate-registry.mjs          # 本地校验（CI 同款闸门）');
  console.log('  2. 人工核对 keyimg 布局/键数，润色 index.json 里的 sub/source/attribution');
  console.log(`  3. git add assets/models/ assets/models/index.json，提交 PR（--contributor ${contributor}）`);
} else {
  const index = [];
  for (const dir of fs.readdirSync(kbRoot)) {
    const modelDir = path.join(kbRoot, dir);
    if (!fs.statSync(modelDir).isDirectory() || !SLUG[dir]) continue;
    const model = convertModel(modelDir);
    const slug = SLUG[dir];
    model.slug = slug; model.sub = SUB[dir];
    const outDir = path.join(OUT, 'models', slug);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(model));
    fs.copyFileSync(path.join(modelDir, 'keyimg.png'), path.join(outDir, 'keyimg.png'));
    index.push({ slug, dir, name: model.name, short: model.short, sub: model.sub, keys: model.keys.filter((k) => k.r[2] > k.r[0]).length, psd: model.psd, wired: { vid: model.vid, pid: model.pid }, wireless: model.vidW ? { vid: model.vidW, pid: model.pidW } : null, ...MAIN_META });
    console.log(`model ${dir} -> ${slug} (${model.keys.length} keys, ${Object.keys(model.animations).length} anims)`);
  }
  fs.writeFileSync(path.join(OUT, 'models', 'index.json'), JSON.stringify(index, null, 1));

  const langs = {};
  for (const [dir, code] of [['en', 'en'], ['sc', 'zh'], ['Korean', 'kr']]) {
    langs[code] = convertLang(path.join(SRC, 'Text', dir, 'text.xml'));
  }
  syncI18n(langs);
  for (const [code, lang] of Object.entries(langs)) {
    fs.writeFileSync(path.join(OUT, 'i18n', code + '.json'), JSON.stringify(lang));
    console.log(`lang ${code}: ${Object.keys(lang).length} strings`);
  }
}

if (warnings.length) {
  // 生成物写在仓库根（不入库，.gitignore 已排除）——不放 assets/，那是要整目录发布的静态资源
  fs.writeFileSync(path.join(ROOT, 'convert-warnings.txt'), warnings.join('\n'));
  console.log(`\n${warnings.length} warnings -> convert-warnings.txt`);
}
console.log('done');
