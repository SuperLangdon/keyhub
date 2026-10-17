#!/usr/bin/env node
// js/device/protocol.js 单元测试（node:test，零依赖）
// 该文件承载全部写硬件的字节打包逻辑——帧格式/位域/往返一致性在这里锁死，
// 重构时任何字节偏移漂移都应在此报警。运行：node --test tools/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../js/device/protocol.js';

// ---------- 0x13 基础帧 ----------
test('buildFrame 布局与校验和', () => {
  const payload = Uint8Array.from({ length: 15 }, (_, i) => i + 1);
  const f = P.buildFrame(P.CMD_WRITE, P.NFRAMES_CONFIG, 3, payload);
  assert.equal(f.length, 20);
  assert.equal(f[0], P.REPORT_ID);
  assert.equal(f[1], P.CMD_WRITE);
  assert.equal(f[2], P.NFRAMES_CONFIG);
  assert.equal(f[3], 3);
  for (let i = 0; i < 15; i++) assert.equal(f[4 + i], payload[i]);
  assert.equal(f[19], P.checksum(f));
});

test('decodeFrame 解析/容错', () => {
  const f = P.buildFrame(0x44, 0x0a, 2, new Uint8Array(15));
  const d = P.decodeFrame(f);
  assert.equal(d.cmd, 0x44);
  assert.equal(d.seq, 2);
  assert.equal(d.sumOk, true);
  const bad = Uint8Array.from(f); bad[7] ^= 0xff;
  assert.equal(P.decodeFrame(bad).sumOk, false);
  assert.equal(P.decodeFrame(null), null);
  assert.equal(P.decodeFrame(new Uint8Array(19)), null);
  assert.equal(P.decodeFrame(new Uint8Array(20)), null); // 首字节非 0x13
});

// ---------- 分片帧（Send13 同构） ----------
test('buildTaggedFrames：14B 分片 + (tag<<4)|len + 帧号/总数', () => {
  const data = Uint8Array.from({ length: 100 }, (_, i) => (i * 7 + 3) & 0xff);
  const frames = P.buildTaggedFrames(P.CMD_MACRO_W, 3, data);
  assert.equal(frames.length, Math.ceil(100 / 14)); // 8
  const out = [];
  frames.forEach((f, i) => {
    assert.equal(f[2], 8, '总帧数');
    assert.equal(f[3], i, '帧号');
    const len = f[4] & 0x0f;
    assert.equal(f[4] >> 4, 3, 'tag 高 4 位');
    out.push(...f.slice(5, 5 + len));
  });
  assert.deepEqual(Uint8Array.from(out), data);
});

test('buildTaggedFrames：短数据单帧', () => {
  const frames = P.buildTaggedFrames(P.CMD_MATRIX_W, 0, Uint8Array.of(9, 8));
  assert.equal(frames.length, 1);
  assert.equal(frames[0][4], (0 << 4) | 2);
});

// ---------- 有线 blob ↔ 十片配置 互转 ----------
// 十片 × 14B payload = 140B 是 0x13 配置的有效域；400B 读回的其余字节是
// 疑似每键 RGB 三平面区（buildConfigWrite 有线写侧单独处理），不在互转域内。
test('blobToFrames / framesToBlob 往返恒等（前 140B 配置域）', () => {
  const blob = Uint8Array.from({ length: 0x190 }, (_, i) => (i * 13 + 5) & 0xff);
  const frames = P.blobToFrames(blob);
  assert.equal(frames.length, 10);
  assert.ok(frames.every((f) => f[1] === P.CMD_READ), '读头 0x44');
  assert.equal(frames[9][4], 0x02, '第 9 片 payload[0]=0x02 标记');
  assert.deepEqual(P.framesToBlob(frames).subarray(0, 140), blob.subarray(0, 140));
});

// ---------- 配置写补丁 ----------
test('buildConfigWrite：字段落位（模板基）', () => {
  const wr = P.buildConfigWrite(null, {
    effect: 5, colorMode: 1, brightness: 2, speed: 3, colorful: true,
    colorRgb: [10, 20, 30], sleepIndex: 4, debounce: 3, tapSens: 5, animMode: false,
  });
  assert.equal(wr.length, 10);
  assert.equal(wr[0][15], 5, '效果字节 @帧0[15]');
  assert.equal(wr[0][17], 1, '色彩模式 @帧0[17]');
  assert.equal(wr[0][13], 4, '睡眠档位索引 @帧0[13]（payload[9]）');
  assert.equal(wr[0][6], 2, '去抖-1 @帧0[6]（payload[2]）');
  assert.equal(wr[0][7], 2, '去抖-1 @帧0[7]（payload[3]）');
  assert.equal(wr[0][12], 5, 'Tap 灵敏度 @帧0[12]（payload[8]）');
  assert.equal(wr[0][8], 0x01, '渲染模式 01=普通');
  assert.equal(wr[0][14], 0x00, 'apply 标志必须 0');
  const [seq, off] = P.effectTableLoc(5);
  assert.deepEqual([seq, off], [4, 15]);
  assert.equal(wr[4][15], 2, '亮度落效果槽亮度字节');
  assert.equal(wr[4][16], P.encodeSpeedByte(3, true), '速度/炫彩字节紧随其后');
  assert.deepEqual([wr[9][7], wr[9][8], wr[9][9]], [10, 20, 30], '自定义色 @帧9[7..9]');
  assert.ok(wr.every((f) => P.decodeFrame(f).sumOk), '校验和全部重算');
});

test('buildConfigWrite：clearColor 清残留色（读取基）', () => {
  const blob = new Uint8Array(0x190);
  blob[128] = 99; blob[129] = 98; blob[130] = 97; // 帧9 payload idx3-5 = 自定义色区
  const base = P.blobToFrames(blob);
  const wr = P.buildConfigWrite(base, { effect: 1, clearColor: true });
  assert.deepEqual([wr[9][7], wr[9][8], wr[9][9]], [0, 0, 0]);
  const wr2 = P.buildConfigWrite(base, { effect: 1, colorRgb: [1, 2, 3] });
  assert.deepEqual([wr2[9][7], wr2[9][8], wr2[9][9]], [1, 2, 3]);
});

test('buildConfigWrite：animMode 渲染模式 + 帧6 参数向量', () => {
  const wr = P.buildConfigWrite(null, { animMode: true });
  assert.equal(wr[0][8], 0x02, 'blob[3]=02 动画渲染');
  assert.deepEqual([wr[6][8], wr[6][9], wr[6][10], wr[6][11], wr[6][12]], [0x47, 0x04, 0x47, 0x04, 0x47]);
});

test('parseConfig 解码与 buildConfigWrite 语义一致', () => {
  const wr = P.buildConfigWrite(null, { effect: 5, colorMode: 1, sleepIndex: 4, debounce: 3, tapSens: 5 });
  const c = P.parseConfig(wr);
  assert.equal(c.effect, 5);
  assert.equal(c.colorMode, 1);
  assert.equal(c.debounce, 3);
  assert.equal(c.tapSens, 5);
  assert.equal(c.sleepMin, P.SLEEP_LEVELS[4]);
  assert.equal(P.parseConfig([null]), null); // 容错
});

// ---------- 每键 RGB ----------
test('buildPerKey：R/G/B 三平面 × 9 片 + 尾片', () => {
  const frames = P.buildPerKey({ 0: [1, 2, 3], 125: [4, 5, 6] }, 126);
  assert.equal(frames.length, 3 * 9 + 1);
  assert.equal(frames[0][5], 1, 'R[0] → 帧0 payload[1]');   // 帧0 p[0]=0e p[1..]=R[0..13]
  assert.equal(frames[9][5], 2, 'G[0] → 帧9 payload[1]');
  assert.equal(frames[18 + 8][4 + 14], 6, 'B[125] → 帧26 payload[14]'); // 125 = 8*14+13
  const t = frames[27];
  assert.equal(t[4], 0x06);
  assert.equal(t[7], 0x5a);
  assert.equal(t[8], 0xa5);
});

// ---------- 调色板 ----------
test('buildPalette：自定义色从流偏移 21 起整片灌 + 帧1 标志位', () => {
  const frames = P.buildPalette([9, 8, 7]);
  assert.equal(frames.length, 37);
  assert.equal(frames[36][4], P.PAL_LAST[0], '尾片 08');
  // 帧0：流 0..13 全 <21 → 全零（除 p[0]=0e）
  assert.equal(frames[0][5], 0);
  // 帧1 p[8]（j=8 → 流 21）= colorRgb[0]
  assert.equal(frames[1][4 + 8], 9);
  assert.equal(frames[1][4 + 9], 8);
  assert.equal(frames[1][4 + 10], 7);
  assert.equal(frames[1][4 + 12], 0xff, '帧1 p[12] 自定义色启用标志');
});

test('buildPalette(null)：除尾片外全零（不污染固件槽位）', () => {
  const frames = P.buildPalette(null);
  for (let i = 0; i < 36; i++) {
    assert.equal(frames[i][4], 0x0e, 'p[0] 标记');
    for (let j = 1; j < 15; j++) assert.equal(frames[i][4 + j], 0);
  }
});

test('buildPaletteDefault / buildPaletteAnim：流映射一致', () => {
  const def = P.buildPaletteDefault();
  const s21 = 1 * 14 + 7; // 帧1 p[8] → 流 21
  assert.equal(def[1][4 + 8], P.hsvRgb(Math.floor((s21 - 21) / 3) * 360 / 161)[(s21 - 21) % 3]);
  const anim = P.buildPaletteAnim();
  for (let i = 0; i < 36; i++) {
    for (let j = 1; j <= 14; j++) {
      const s = i * 14 + (j - 1);
      const want = (s >= 21 && s <= 504) ? P.FLOWER_PATTERN[s - 21] : 0;
      assert.equal(anim[i][4 + j], want, `帧${i} p[${j}]（流 ${s}）`);
    }
  }
});

// ---------- 宏 ----------
test('encodeMacroEvent：0x80 = 即发标志（延时==0 且类型∉{滚轮,多媒体,移动}）', () => {
  // 2026-10 K65 版驱动 StMacro_To_HdMacro 0x490940 实证：b0 |= 0x80 ⟺ delay==0 && type∉{3,4,5}
  assert.deepEqual(P.encodeMacroEvent(P.MAC_EV_KEY, 0x04, 0, true), [0x80, 0, 0, 0x04]);   // 零延时 → 0x80
  assert.deepEqual(P.encodeMacroEvent(P.MAC_EV_KEY, 0x04, 0, false), [0x80, 0, 0, 0x04]);  // press 形参不再参与
  assert.deepEqual(P.encodeMacroEvent(P.MAC_EV_KEY, 0x04, 150), [0x00, 0, 150, 0x04]);     // 有延时 → 无 0x80（类型 0 → 高 nibble 0）
  assert.deepEqual(P.encodeMacroEvent(P.MAC_EV_WHEEL, 0x33, 0), [0x30, 0, 0, 0x33]);       // 滚轮恒无 0x80
  assert.deepEqual(P.encodeMacroEvent(P.MAC_EV_CONSUMER, 0xE9, 0), [0x40, 0, 0, 0xE9]);    // 多媒体恒无 0x80（K65 修正）
  assert.deepEqual(P.encodeMacroEvent(P.MAC_EV_MOVE, 5, 0), [0x50, 0, 0, 0x05]);           // 移动恒无 0x80
  const d = 0x12345;
  const ev = P.encodeMacroEvent(P.MAC_EV_WHEEL, 0x33, d, false);
  assert.deepEqual(ev, [(P.MAC_EV_WHEEL << 4) | ((d >> 16) & 0x0f), (d >> 8) & 0xff, d & 0xff, 0x33]);
});

test('macroEventsToBytes：按下=按住时长 / 释放=距下次按下（0x80 仅零延时）', () => {
  const bytes = P.macroEventsToBytes([
    { at: 0, kind: 'dn', code: 0x41 },
    { at: 150, kind: 'up', code: 0x41 },
    { at: 400, kind: 'dn', code: 0x42 },
    { at: 500, kind: 'dn', code: 0 }, // 无 HID 映射 → 丢弃
  ]);
  assert.equal(bytes.length, 12);
  assert.deepEqual([...bytes.slice(0, 4)], P.encodeMacroEvent(P.MAC_EV_KEY, 0x04, 150));
  assert.deepEqual([...bytes.slice(4, 8)], P.encodeMacroEvent(P.MAC_EV_KEY, 0x04, 250));
  assert.deepEqual([...bytes.slice(8, 12)], [0x80, 0, 0, 0x05]); // 零延时 dn → 即发标志
});

test('buildMacroBlob：索引表重定位 + 名字 UTF-16LE + 事件流 + 30 字符名截断', () => {
  const { blob, count } = P.buildMacroBlob([
    { id: 1, name: 'AB', events: [{ at: 0, kind: 'dn', code: 0x41 }] },
    { id: 2, name: 'C', events: [] },
  ]);
  assert.equal(count, 2);
  assert.equal(blob.length, 8 + (1 + 4 + 4) + (1 + 2 + 0));
  // 表项 0：addr=8 size=9；表项 1：addr=17 size=3
  assert.equal(blob[0] | (blob[1] << 8), 8);
  assert.equal(blob[2] | (blob[3] << 8), 9);
  assert.equal(blob[4] | (blob[5] << 8), 17);
  assert.equal(blob[6] | (blob[7] << 8), 3);
  // 记录 0：名长 4 + 'A',0,'B',0 + 4B 事件
  assert.equal(blob[8], 4);
  assert.deepEqual([...blob.slice(9, 13)], [65, 0, 66, 0]);
  assert.deepEqual([...blob.slice(13, 17)], P.encodeMacroEvent(P.MAC_EV_KEY, 0x04, 0));
  // 名字上限 30 字符（驱动 wcsnlen(…, 0x1E)——K65 版 StMacro_To_HdMacro 实证）
  const long = P.buildMacroBlob([{ id: 9, name: 'x'.repeat(50), events: [] }]);
  assert.equal(long.blob[4], 60); // 30 字符 × 2 字节 UTF-16LE
});

test('macroKeyDword / 循环码', () => {
  assert.equal(P.macroKeyDword(3, 2, 4), ((3 << 24) | (2 << 16) | (4 << 8) | 0x03) >>> 0);
  assert.deepEqual(P.MACRO_LOOP_CODES, { once: 1, hold: 2, anyKey: 4 });
});

// ---------- 档位与效果槽表 ----------
test('sleepIndexOf 就近档位（并列取先）', () => {
  assert.equal(P.sleepIndexOf(0), 0);
  assert.equal(P.sleepIndexOf(3), 1);   // 距 1/5 等距 → 取 1
  assert.equal(P.sleepIndexOf(90), 7);  // 距 60/120 等距 → 取 60
  assert.equal(P.sleepIndexOf(120), 8);
});

test('effectTableLoc 分段', () => {
  assert.deepEqual(P.effectTableLoc(1), [4, 7]);
  assert.deepEqual(P.effectTableLoc(6), [4, 17]);
  assert.deepEqual(P.effectTableLoc(7), [5, 5]);
  assert.deepEqual(P.effectTableLoc(13), [5, 17]);
  assert.deepEqual(P.effectTableLoc(14), [6, 5]);
  assert.deepEqual(P.effectTableLoc(18), [6, 13]);
  assert.deepEqual(P.effectTableLoc(21), [4, 7]); // 越界兜底
});

// ---------- film 屏幕烧录（feat520 通道；布局反汇编实证自 K65 版 OemDrv.exe） ----------
test('buildFilmDataReport / buildGifParamPayload', () => {
  // 像素数据帧（AccessData_Page 0x492490）：[rid][0C][00][帧序][包序][00][len16LE][数据@8]
  const f = P.buildFilmDataReport(9, 3, 127, [1, 2, 3, 4]);
  assert.equal(f.length, P.FEAT520_LEN);
  assert.deepEqual([...f.slice(0, 8)], [9, 0x0c, 0, 3, 127, 0, 4, 0]);
  assert.deepEqual([...f.slice(8, 12)], [1, 2, 3, 4]);
  // len >255 → 16 位小端
  const big = P.buildFilmDataReport(9, 0, 0, new Uint8Array(512).fill(0xab));
  assert.equal(big[6], 0x00);
  assert.equal(big[7], 0x02);
  assert.equal(big[8], 0xab);
  // GIF 参数载荷（SetGIFParam 0x492830）：b0=gifIndex|op<<6 + 帧数/延时 u16LE
  const p = P.buildGifParamPayload(0, 1, 80, 500);
  assert.equal(p.length, 8);
  assert.equal(p[0], 0x40); // op=1 开始
  assert.deepEqual([...p.slice(1, 5)], [80, 0, 500 & 0xff, 500 >> 8]);
  assert.deepEqual([...p.slice(5)], [0, 0, 0]);
  const fin = P.buildGifParamPayload(0, 0, 80, 500);
  assert.equal(fin[0], 0x00); // op=0 正常收尾
  const cancel = P.buildGifParamPayload(0, 2, 80, 500);
  assert.equal(cancel[0], 0x80); // op=2 取消收尾
});

// ---------- 520B feature 帧 ----------
test('buildFeat520Frame / buildTunnel6', () => {
  const f = P.buildFeat520Frame(6, 0x82, 0x01, 0, 6, [1, 2, 3, 4, 5, 6]);
  assert.equal(f.length, P.FEAT520_LEN);
  assert.deepEqual([...f.slice(0, 8)], [6, 0x82, 0x01, 0, 0x01, 0, 6, 0]);
  assert.deepEqual([...f.slice(8, 14)], [1, 2, 3, 4, 5, 6]);
  const t = P.buildTunnel6(0x09, [9, 8, 7, 6]);
  assert.equal(t[0], 6);
  assert.equal(t[2], 0x09);
  assert.equal(t[3], 1, '隧道帧标识 [3]=1');
  assert.equal(t[6] | (t[7] << 8), 4);
  assert.deepEqual([...t.slice(8, 12)], [9, 8, 7, 6]);
  let ck = 0;
  for (let i = 2; i < P.FEAT520_LEN; i++) ck = (ck + t[i]) & 0xff;
  assert.equal(t[1], ck, '隧道帧校验和 = 字节2..519 累加');
});

// ---------- VK↔HID 映射 ----------
test('VK2HID 抽查', () => {
  assert.equal(P.VK2HID.get(0x41), 0x04); // A
  assert.equal(P.VK2HID.get(0x31), 0x1e); // '1'（真机 Hi98 Pro 槽7=0x1E000000）
  assert.equal(P.VK2HID.get(0x30), 0x27); // '0'（真机槽61=0x27000000）
  assert.equal(P.VK2HID.get(0x5b), 0xe3); // LWin
  assert.equal(P.VK2HID.get(0xdb), 0x2f); // [
  assert.equal(P.VK2HID.get(0x6f), 0x54); // Num/
});

// ---------- 设备族重建（放最后：原地改写全局表，测完还原） ----------
test('rebuildDeviceFamilies：同 VID/PID 并族 + 还原', () => {
  const backup = [...P.DEVICE_FAMILIES];
  try {
    const ok = P.rebuildDeviceFamilies([
      { slug: 'x1', wired: { vid: 0x1111, pid: 0x2222 }, wireless: null },
      { slug: 'x2', wired: { vid: 0x1111, pid: 0x2222 }, wireless: { vid: 0x3333, pid: 0x4444 } },
    ]);
    assert.equal(ok, true);
    assert.equal(P.DEVICE_FAMILIES.length, 1);
    assert.equal(P.DEVICE_FAMILIES[0].wireless.vid, 0x3333, '族合并取无线侧');
    const ids = P.idsForChannel('wired');
    assert.deepEqual(ids, [{ vid: 0x1111, pid: 0x2222 }]);
    assert.equal(P.rebuildDeviceFamilies([]), false, '空表拒绝');
    assert.equal(P.rebuildDeviceFamilies(null), false);
  } finally {
    P.DEVICE_FAMILIES.length = 0;
    P.DEVICE_FAMILIES.push(...backup);
  }
});

// ---------- 改键 dword 全量编码 fnToDword（keyinfo_to_hardware_code@0x491f90 实证规则） ----------
test('fnToDword：普通键 = hid<<24（A→0x04000000）', () => {
  assert.equal(P.fnToDword({ type: 0x02, code: 0x41, param: 0 }), 0x04000000);
  assert.equal(P.fnToDword({ type: 0x02, code: 0x1b, param: 0 }), 0x29000000); // Esc（VK2HID 0x1b→0x29）
  assert.equal(P.fnToDword({ type: 0x02, code: 0x31, param: 0 }), 0x1e000000); // '1' 真机槽7
  assert.equal(P.fnToDword({ type: 0x02, code: 0x30, param: 0 }), 0x27000000); // '0' 真机槽61
});

test('fnToDword：组合键 = hid<<24 | mods<<8（Shift 位=0x02）', () => {
  // keys.js MODS：Ctrl=0x01 Shift=0x02 Alt=0x04 Win=0x08；param=mods<<8
  assert.equal(P.fnToDword({ type: 0x02, code: 0x41, param: 0x02 << 8 }), (0x04 << 24 | 0x02 << 8) >>> 0);
  assert.equal(P.fnToDword({ type: 0x02, code: 0x41, param: 0x0f << 8 }), (0x04 << 24 | 0x0f << 8) >>> 0);
});

test('fnToDword：修饰键作主键 = HID 位图<<8（真机六键金标准）', () => {
  assert.equal(P.fnToDword({ type: 0x02, code: 0xa0, param: 0 }), 0x00000200); // LShift→bit1
  assert.equal(P.fnToDword({ type: 0x02, code: 0xa1, param: 0 }), 0x00002000); // RShift→bit5
  assert.equal(P.fnToDword({ type: 0x02, code: 0xa2, param: 0 }), 0x00000100); // LCtrl→bit0
  assert.equal(P.fnToDword({ type: 0x02, code: 0xa3, param: 0 }), 0x00001000); // RCtrl→bit4
  assert.equal(P.fnToDword({ type: 0x02, code: 0xa4, param: 0 }), 0x00000400); // LAlt→bit2
  assert.equal(P.fnToDword({ type: 0x02, code: 0x5b, param: 0 }), 0x00000800); // LWin→bit3
});

test('fnToDword：FN/无功能/未知键', () => {
  assert.equal(P.fnToDword({ type: 0x02, code: 0xfa, param: 0 }), 0x0000000d);
  assert.equal(P.fnToDword({ type: 0x02, code: 0xfb, param: 0 }), 0x0000010d);
  assert.equal(P.fnToDword({ type: 0x02, code: 0x00, param: 0x01 }), 0xffffffff); // 禁用（驱动 0x18→-1）
  assert.equal(P.fnToDword({ type: 0x02, code: 0xf0, param: 0 }), null); // VK2HID 无映射
});

test('fnToDword：鼠标（1-5 透传 param，6-9 跳过）', () => {
  assert.equal(P.fnToDword({ type: 0x02, code: 0x01, param: 0x05000000 }), 0x05000000); // A75 K65 真值
  assert.equal(P.fnToDword({ type: 0x02, code: 0x02, param: 0x05000000 }), 0x05000000); // 透传机制
  assert.equal(P.fnToDword({ type: 0x02, code: 0x07, param: 0x05000000 }), null);      // 前进：值域未校准
});

test('fnToDword：多媒体/灯光 = param 字节重排 [b1][b0][b2][b3]（sub_465EF0）', () => {
  assert.equal(P.fnToDword({ type: 0x09, code: 0x01, param: 0x020000ea }), 0xea000002); // 音量-（真机 K12）
  assert.equal(P.fnToDword({ type: 0x09, code: 0x01, param: 0x0700001d }), 0x1d000007); // KB.ini 旋钮默认
  assert.equal(P.fnToDword({ type: 0x09, code: 0x01, param: 0x08030200 }), 0x00020308); // 灯光控制（真机 K6）
});

test('fnToDword：常用命令查表 + 复位无编码', () => {
  assert.equal(P.fnToDword({ type: 0x01, code: 0x13, param: 0 }), 0x00010201);
  assert.equal(P.fnToDword({ type: 0x01, code: 0x1b, param: 0 }), 0x32ff0701);
  assert.equal(P.fnToDword({ type: 0x01, code: 0x1d, param: 0 }), null);
  assert.equal(P.fnToDword({ type: 0x01, code: 0x99, param: 0 }), null);
});

test('fnToDword：宏 = macroKeyDword（序号取 macroOrder 下标，rep/loopCode 随指派）', () => {
  const order = [{ id: 7 }, { id: 8 }];
  assert.equal(P.fnToDword({ type: 0x0a, code: 0x01, param: 8, rep: 3, loopCode: 2 }, { macroOrder: order }),
    P.macroKeyDword(1, 3, 2));
  assert.equal(P.fnToDword({ type: 0x0a, code: 0x01, param: 7 }, { macroOrder: order }),
    P.macroKeyDword(0, 1, P.MACRO_LOOP_CODES.once));
  assert.equal(P.fnToDword({ type: 0x0a, code: 0x01, param: 999 }, { macroOrder: order }), null);
  assert.equal(P.fnToDword({ type: 0x0a, code: 0x01, param: 7 }), null); // 无 macroOrder
});

// ---------- 旋钮模式配置字段（FillCfg 变体 B 实证偏移；侧灯经核实官方未开放，不做） ----------
test('buildConfigWrite：knobCustom 写 slice1 f[17]（Cfg[26]）= 6/0', () => {
  const on = P.buildConfigWrite(null, { knobCustom: true });
  const off = P.buildConfigWrite(null, { knobCustom: false });
  assert.equal(on[1][17], 6);
  assert.equal(off[1][17], 0);
  const untouched = P.buildConfigWrite(null, {});
  assert.notEqual(untouched[1][17], 6);
  for (const f of on) assert.equal(f[19], P.checksum(f), '校验和自洽');
});

// ---------- fw26 世代（K65 版 OemDrv FillCfg 0x491430 实证，2026-10 REA） ----------
test('cfgGenOf：已知固件代际 + 未知默认 fw24', () => {
  assert.equal(P.cfgGenOf({ fw: 24 }), 'fw24');
  assert.equal(P.cfgGenOf({ fw: 26 }), 'fw26');
  assert.equal(P.cfgGenOf(null), 'fw24');
  assert.equal(P.cfgGenOf({}), 'fw24');
});

test('modelSleepTable / modelLightHw：型号档位表与亮度映射', () => {
  // K65（无 SleepUI 行 → 驱动内置表，HW=分钟/30）
  const k65 = { fw: 26 };
  const t1 = P.modelSleepTable(k65);
  assert.deepEqual(t1.ui, P.SLEEP_DEFAULT_UI);
  assert.deepEqual(t1.hw, P.SLEEP_DEFAULT_HW);
  assert.equal(t1.hw[t1.ui.indexOf(60)], 2, '60 分钟 → HW=2');
  // KB.ini 显式表优先（model.sleepUI/sleepHW）
  const t2 = P.modelSleepTable({ fw: 26, sleepUI: [0, 30, 60], sleepHW: [0, 1, 2] });
  assert.deepEqual(t2.hw, [0, 1, 2]);
  // fw24 → 旧档位表 + 索引写入
  const t3 = P.modelSleepTable({ fw: 24 });
  assert.deepEqual(t3.ui, P.SLEEP_LEVELS);
  assert.deepEqual(t3.hw, P.SLEEP_LEVELS.map((_, i) => i));
  // 亮度映射：K65 [0..4]→[1,5,10,15,20]；无表恒等
  assert.equal(P.lightHwOf({ fw: 26, brightnessHw: [1, 5, 10, 15, 20] }, 0), 1);
  assert.equal(P.lightHwOf({ fw: 26, brightnessHw: [1, 5, 10, 15, 20] }, 4), 20);
  assert.equal(P.lightHwOf({ fw: 24 }, 3), 3);
  assert.equal(P.modelLightHw({ fw: 24 }), null);
});

test('buildConfigWrite fw26：睡眠=blob[24]、Tap=blob[22]、去抖=blob[3]、animMode 不写', () => {
  const wr = P.buildConfigWrite(null, {
    gen: 'fw26', effect: 5, colorMode: 1, brightness: 2, speed: 1,
    sleepHw: 2, tapSens: 6, debounce: 3, animMode: true,
  });
  assert.equal(wr[1][15], 2, '睡眠 HW 值 @slice1 f[15]（blob[24]）');
  assert.equal(wr[1][13], 6, 'Tap @slice1 f[13]（blob[22]）');
  assert.equal(wr[0][8], 3, '去抖 UI 值 @slice0 f[8]（blob[3]，fw26 单字节）');
  assert.equal(wr[0][6], 0x03, 'blob[1] 出厂常量不动（模板 03）');
  assert.equal(wr[0][7], 0x03, 'blob[2] 出厂常量不动（模板 03）');
  assert.equal(wr[0][13], 0x07, '旧睡眠位 blob[8] 不写（保持模板常量 07）');
  assert.equal(wr[0][12], 0x04, '旧 Tap 位 blob[7] 不写（模板值）');
  assert.equal(wr[0][17], 0x01, 'colorMode 恢复写入（1=自定义；§11.2 停写实验已回滚）');
  // fw26：blob[3] 是去抖域，animMode 的 02 不再写入（花开富贵走表驱动 + 帧6 参数）
  assert.notEqual(wr[0][8], 0x02);
  assert.deepEqual([wr[6][8], wr[6][9], wr[6][10], wr[6][11], wr[6][12]], [0x47, 0x04, 0x47, 0x04, 0x47], '帧6 参数向量照旧');
  for (const f of wr) assert.equal(f[19], P.checksum(f), '校验和自洽');
  // 旧睡眠字段在 fw24 仍写索引
  const w24 = P.buildConfigWrite(null, { gen: 'fw24', sleepIndex: 4 });
  assert.equal(w24[0][13], 4);
});

test('buildConfigWrite fw26：效果字节 = UI 号、colorMode 恢复始终写（§11.5/§11.2 回滚后行为）', () => {
  // LedOpt 行布局实为 [使能,fw,ui,...]，驱动 FillCfgB 取行+2 = ui 列——效果字节是 UI 号。
  // 真机反证：写 fw 号后 ui8→16 渲染成瀑布(#16)、ui12→17 渲染成花开富贵(#17)、18/20 → 黑。
  const wr = P.buildConfigWrite(null, { gen: 'fw26', effect: 9, colorMode: 0x01, brightness: 2, speed: 1 });
  assert.equal(wr[0][15], 9, 'blob[10] = UI 号 9（踏雪无痕）');
  assert.equal(wr[0][17], 1, 'colorMode 恢复写入（停写会让设备卡在历史值无法自愈）');
  const [seq, off] = P.effectTableLoc(9);
  assert.equal(wr[seq][off], 2, '参数槽仍按 UI 号索引');
});

test('buildConfigWrite 速度字节低 nibble：炫彩=7 / 非炫彩=0（两代一致，最初真机可用行为）', () => {
  const [seq, off] = P.effectTableLoc(9);
  const base = P.blobToFrames(new Uint8Array(0x190));
  base[seq][4 + 1 + (off - 5) + 1] = (2 << 4) | 5;
  const mk = (gen, colorful) => P.buildConfigWrite(base, { gen, effect: 9, brightness: 3, speed: 4, colorful });
  assert.equal(mk('fw26', false)[seq][off + 1], (4 << 4) | 0, '非炫彩 → 0');
  assert.equal(mk('fw26', true)[seq][off + 1], (4 << 4) | 7, '炫彩 → 7');
  assert.equal(mk('fw24', false)[seq][off + 1], (4 << 4) | 0, 'fw24 同');
});

test('buildConfigWrite 亮度 LightHW 映射（K65 [1,5,10,15,20]）', () => {
  const wr = P.buildConfigWrite(null, { effect: 5, brightness: 2, speed: 3, lightHw: [1, 5, 10, 15, 20] });
  const [, off] = P.effectTableLoc(5);
  assert.equal(wr[4][off], 10, 'UI 档 2 → HW 10（驱动 FillCfg 写 LightHW[档]）');
  const wr0 = P.buildConfigWrite(null, { effect: 5, brightness: 2, speed: 3 });
  assert.equal(wr0[4][off], 2, '无映射表（fw24）→ 直写 UI 档');
});

test('padMatrixDwords：CRC 型号补槽至 MatrixLen + 末槽 A5A5A5A5', () => {
  const d = P.padMatrixDwords([0x04000000, 0x29000000], 128, true);
  assert.equal(d.length, 128);
  assert.equal(d[0], 0x04000000);
  assert.equal(d[2], 0, '未指派槽补零');
  assert.equal(d[127], 0xa5a5a5a5, '末槽标记（驱动 FillMatrix 0x490D10 同款）');
  const d2 = P.padMatrixDwords([1, 2, 3], 3, false);
  assert.deepEqual(d2, [1, 2, 3], '非 CRC 不打标记');
});

test('GetPower 电量帧（K65 版 CDevG5MS::GetPower @0x4946E0）：校验和布局 cmd 09/01 len 1', () => {
  const f = P.buildFeat520FrameK65(P.BATTERY_CMD_K65, P.BATTERY_SUB_K65, 0, 1, null, 1);
  assert.equal(f.length, P.FEAT520_LEN);
  assert.equal(f[0], 9, 'report id 9');
  assert.deepEqual([...f.slice(2, 8)], [0x09, 0x01, 0x01, 0x00, 0x01, 0x00], 'cmd/sub/块数/seq/len16LE');
  let ck = 0;
  for (let i = 2; i < P.FEAT520_LEN; i++) ck = (ck + f[i]) & 0xff;
  assert.equal(f[1], ck, '校验和 = 字节 2..519 累加（GetPower 内联计算同款）');
});
