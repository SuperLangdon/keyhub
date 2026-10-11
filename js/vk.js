// Windows VK 码表与键值功能编解码（与原驱动 keycode 32 位编码一致）
import { state } from './store.js';

export const VK_NAME = new Map([
  [0x08, 'Backspace'], [0x09, 'Tab'], [0x0D, 'Enter'], [0x13, 'Pause'], [0x14, 'Caps'],
  [0x1B, 'Esc'], [0x20, 'Space'], [0x21, 'PgUp'], [0x22, 'PgDn'], [0x23, 'End'], [0x24, 'Home'],
  [0x25, '←'], [0x26, '↑'], [0x27, '→'], [0x28, '↓'], [0x2C, 'PrtSc'], [0x2D, 'Ins'], [0x2E, 'Del'],
  [0x5B, 'Win'], [0x5C, 'RWin'], [0x5D, 'App'],
  [0x90, 'NumLk'], [0x91, 'ScrLk'],
  [0xA0, 'LShift'], [0xA1, 'RShift'], [0xA2, 'LCtrl'], [0xA3, 'RCtrl'], [0xA4, 'LAlt'], [0xA5, 'RAlt'],
  [0xBA, ';'], [0xBB, '='], [0xBC, ','], [0xBD, '-'], [0xBE, '.'], [0xBF, '/'], [0xC0, '`'],
  [0xDB, '['], [0xDC, '\\'], [0xDD, ']'], [0xDE, "'"],
  [0xFA, 'FN'],
  [0x01, 'Mouse L'], [0x02, 'Mouse R'], [0x04, 'Mouse M'],
  [0x30, '0'], [0x39, '9'],
]);
for (let i = 0; i < 10; i++) VK_NAME.set(0x30 + i, String(i));
for (let i = 0; i < 26; i++) VK_NAME.set(0x41 + i, String.fromCharCode(65 + i));
for (let i = 0; i < 12; i++) VK_NAME.set(0x70 + i, 'F' + (i + 1));
for (let i = 0; i < 10; i++) VK_NAME.set(0x60 + i, 'Num' + i);
VK_NAME.set(0x6A, 'Num*').set(0x6B, 'Num+').set(0x6D, 'Num-').set(0x6E, 'Num.').set(0x6F, 'Num/');

// 多媒体 usage (consumer page)
const CONSUMER = new Map([
  [0xB5, '下一曲'], [0xB6, '上一曲'], [0xCD, '播放/暂停'], [0xE2, '静音'],
  [0xE9, '音量+'], [0xEA, '音量-'],
  [0x223, 'AC Back'], [0x18A, '本机浏览'],
  [0x227, '收藏'], [0x225, '主页'], [0x23C, '我的电脑'], [0x192, '计算器'], [0x183, '媒体播放器'],
  [0x18C, '邮件'], [0xB7, '停止'],
]);
const CONSUMER_EN = new Map([
  [0xB5, 'Next'], [0xB6, 'Prev'], [0xCD, 'Play/Pause'], [0xE2, 'Mute'],
  [0xE9, 'Vol +'], [0xEA, 'Vol -'],
  [0x223, 'AC Back'], [0x18A, 'Local browser'],
  [0x227, 'Favorites'], [0x225, 'Home'], [0x23C, 'My computer'], [0x192, 'Calculator'], [0x183, 'Media player'],
  [0x18C, 'Email'], [0xB7, 'Stop'],
]);

const MOUSE_ACTIONS = new Map([
  [0x01, '鼠标左键'], [0x02, '鼠标右键'], [0x04, '鼠标中键'],
  [0x05, '滚轮上'], [0x06, '滚轮下'], [0x07, '前进'], [0x08, '后退'], [0x09, '双击'],
]);
const MOUSE_EN = new Map([
  [0x01, 'Mouse L'], [0x02, 'Mouse R'], [0x04, 'Mouse M'],
  [0x05, 'Scroll up'], [0x06, 'Scroll down'], [0x07, 'Forward'], [0x08, 'Back'], [0x09, 'D-click'],
]);

// 灯光控制（0x09,0x01,0x08xxxxxx 类指令）
export const LEDCTL = new Map([
  ['power/toggle', '灯光开/关'], ['speed/up', '灯效加速'], ['speed/down', '灯效减速'],
  ['light/up', '亮度+'], ['light/down', '亮度-'],
  ['direction/up', '方向切换'], ['direction/toggle', '方向切换'],
]);

export function vkName(vk) {
  if (vk == null) return '';
  return VK_NAME.get(vk) ?? ('VK ' + vk.toString(16).toUpperCase());
}

// func = {type, code, param}  →  显示文本
export function funcLabel(func, t) {
  if (!func) return '';
  const en = langIsEn();
  const { type, code, param } = func;
  if (type === 0x0A) {
    const m = state.macros?.find((x) => x.id === param);
    return (en ? 'Macro ' : '宏 ') + (m ? m.name : '#' + param);
  }
  if (type === 0x01) {
    const c = COMMON_CMDS.find((x) => x.code === code);
    return c ? (t ? t(c.tag, 'CMD ' + code.toString(16)) : c.tag) : (en ? 'Cmd #' : '命令 #') + (code ?? 0).toString(16);
  }
  if (type === 0x02) {
    if (code === 0x01 && param === 0x05000000) return 'B'; // Alice 分离 B 键
    if (code >= 0x01 && code <= 0x09 && code !== 0x08 && param) return (en ? MOUSE_EN : MOUSE_ACTIONS).get(code) || ('Mouse ' + code);
    return vkName(code);
  }
  if (type === 0x09 && param) {
    const top = (param >>> 24) & 0xFF;
    if (top === 0x07) return (en ? 'FX #' : '灯效 #') + (param & 0xFF);
    if (top === 0x08) {
      const which = en
        ? { 0: 'Light', 2: 'Speed', 3: 'Brightness', 4: 'Direction' }[(param >>> 16) & 0xFF] || 'Light'
        : { 0: '灯光', 2: '速度', 3: '亮度', 4: '方向' }[(param >>> 16) & 0xFF] || '灯光';
      const dir = { 1: '+', 2: '-', 0: en ? ' on/off' : '开关' }[(param >>> 8) & 0xFF] ?? '';
      return which + dir;
    }
    if (top === 0x02) {
      const usage = param & 0xFFFF;
      return (en ? CONSUMER_EN : CONSUMER).get(usage) || ('Media ' + usage.toString(16));
    }
    return 'Cmd ' + param.toString(16);
  }
  return vkName(code);
}

let langIsEn = () => false;
export function setFuncLang(isEn) { langIsEn = () => !!isEn; }

// 供"按键页"面板使用的功能分类数据
export function keyboardKeyList() {
  const list = [];
  for (const [vk] of VK_NAME) {
    if (vk <= 0x06 || vk === 0xFA || (vk >= 0xB8 && vk <= 0xB9)) continue;
    list.push(vk);
  }
  list.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra - rb || a - b;
  });
  function rank(v) {
    if (v === 0x1B) return 0;
    if (v >= 0x70 && v <= 0x7B) return 1;
    if ((v >= 0x41 && v <= 0x5A) || (v >= 0x30 && v <= 0x39)) return 2;
    if (v >= 0xA0 && v <= 0xA5) return 4;
    if (v === 0x20 || v === 0x09 || v === 0x08 || v === 0x0D) return 3;
    if (v >= 0x21 && v <= 0x2E) return 5;
    return 6;
  }
  return list;
}

// 编码一个功能（32 位 keycode 语义）
export function makeKeyFunc(vk) { return { type: 0x02, code: vk, param: 0 }; }
export function makeConsumerFunc(usage) { return { type: 0x09, code: 0x01, param: (0x02 << 24) | (usage & 0xFFFF) }; }
export function makeMouseFunc(btn) { return { type: 0x02, code: btn, param: 0x05000000 }; }
export function makeDisabledFunc() { return { type: 0x02, code: 0x00, param: 0x01 }; }
export function makeLedFxFunc(fwEffect) { return { type: 0x09, code: 0x01, param: (0x07 << 24) | (fwEffect & 0xFF) }; }
export function makeLedCtlFunc(which, dir) {
  const w = { power: 0, speed: 2, light: 3, direction: 4 }[which] ?? 3;
  const d = { up: 1, down: 2, toggle: 0 }[dir] ?? 1;
  return { type: 0x09, code: 0x01, param: (0x08 << 24) | (w << 16) | (d << 8) };
}
export function sameFunc(a, b) {
  return !!a && !!b && a.type === b.type && a.code === b.code && a.param === b.param;
}

// ---------- 常用命令（逆向自 OemDrv.exe 按键页）----------
// UI 网格构建序列 @0x42a7de：(code, 项序) 对 = [0x11,0x13,0x12,0x14,0x15,0x19,0x1a,0x16,0x17]，
// 与语言包 tc_cmd1-9 的标签顺序对应（锁定计算机=0x13、运行命令=0x12）。
// 硬件 dword 来自 keyinfo_to_hardware_code(0x491f90) type-1 跳转表 0x492444（键位表写入用，
// 暂未实现全量改键下发；code→hw 映射已验证存在，0x18=禁用按键→-1）：
//   0x11→0x00010101  0x13→0x00010201  0x12→0x00010301  0x14→0x00010401  0x15→0x00010501
//   0x19→0x00000801  0x1a→0x00000901  0x16→0x32020101  0x17→0x32030101
//   （0x14/0x15 的 dword 在部分型号互换——驱动按型号能力位 0x49200c 特判，此处保留默认）
// tc_cmd10=禁用按键（韩文包 키 비활성화；zh/en 留空）→ 对应本页底部的「无功能」；
// tc_cmd11-13（锁Win/锁键盘/复位键盘）是驱动全局设置项，不在按键指派网格内。
export const COMMON_CMDS = [
  { code: 0x11, tag: 'tc_cmd1', hw: 0x00010101 },
  { code: 0x13, tag: 'tc_cmd2', hw: 0x00010201 }, // 锁定计算机
  { code: 0x12, tag: 'tc_cmd3', hw: 0x00010301 },
  { code: 0x14, tag: 'tc_cmd4', hw: 0x00010401 },
  { code: 0x15, tag: 'tc_cmd5', hw: 0x00010501 },
  { code: 0x19, tag: 'tc_cmd6', hw: 0x00000801 },
  { code: 0x1a, tag: 'tc_cmd7', hw: 0x00000901 },
  { code: 0x16, tag: 'tc_cmd8', hw: 0x32020101 },
  { code: 0x17, tag: 'tc_cmd9', hw: 0x32030101 },
  // —— 以下三项原驱动放在「常用命令」设置组（非按键网格）。锁Win/锁键盘的固件键位编码
  // 存在于 keyinfo 编码器（0x492005/0x49200c），可作按键指派写入；复位键盘（0x1d）无
  // 键位编码（编码器 switch 止于 0x1c 且 default 落灯光族，全二进制无同族字节）——
  // 原驱动里它是主机发起的全局操作（等同恢复出厂），写入真机时跳过并提示。
  { code: 0x1b, tag: 'tc_cmd11', hw: 0x32ff0701 }, // 锁Win键
  { code: 0x1c, tag: 'tc_cmd12', hw: 0x32ff0601 }, // 锁键盘
  { code: 0x1d, tag: 'tc_cmd13', hw: null },       // 复位键盘（无固件键位编码）
];
export function makeCommonCmdFunc(code) {
  return { type: 0x01, code, param: 0 };
}
