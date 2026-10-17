#!/usr/bin/env node
// js/gif.js 单元测试（node:test，零依赖）
// GIF 解码是屏幕页「导入 GIF」的核心路径——LZW 位流、KwKwK 回指、字典生长、隔行、
// 透明色、disposal 合成都在这里锁死。
// 构造样例用的极简编码器：码长恒为 minCodeSize+1，字典将满时发 Clear 并同步重置
// （解码端码长生长逻辑由 KwKwK/字典用例覆盖——那里码长增长仅来自 minCodeSize=8 的
// 初始码长，编码器全程不变长，避免在测试里复刻变长码长切换）。
// 运行：node --test tools/test/gif.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGif } from '../../js/gif.js';

// ---------- 极简 GIF 编码器（仅测试构造用） ----------
function lzwEncode(minCodeSize, indices) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const codeSize = minCodeSize + 1;
  let dict = new Map();
  let next = eoi + 1;
  const codes = [];
  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const key = cur + ',' + indices[i];
    const found = dict.get(key);
    if (found !== undefined) { cur = found; continue; }
    codes.push(cur);
    dict.set(key, next++);
    if (next >= (1 << codeSize) - 1) { // 字典将触碰码长边界：发 Clear 并重置（解码端同步）
      codes.push(clear);
      dict = new Map();
      next = eoi + 1;
    }
    cur = indices[i];
  }
  codes.push(cur, eoi);

  let bytes = [], bitBuf = 0, bitCnt = 0;
  for (const code of codes) {
    bitBuf |= code << bitCnt;
    bitCnt += codeSize;
    while (bitCnt >= 8) { bytes.push(bitBuf & 0xff); bitBuf >>= 8; bitCnt -= 8; }
  }
  if (bitCnt > 0) bytes.push(bitBuf & 0xff);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const c = bytes.slice(i, i + 255);
    chunks.push(c.length, ...c);
  }
  chunks.push(0);
  return Uint8Array.from([minCodeSize, ...chunks]);
}

// 组装一张 GIF：frames = [{indices, left, top, w, h, interlace?, minCodeSize?, gce?:{delay,transparent,disposal}}]
function buildGif(w, h, colors, frames) {
  const out = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
  const gctPow = Math.log2(colors.length) - 1;
  out.push(w & 0xff, w >> 8, h & 0xff, h >> 8, 0x80 | gctPow, 0, 0);
  for (const [r, g, b] of colors) out.push(r, g, b);
  for (const f of frames) {
    if (f.gce) {
      const packed = (f.gce.disposal ?? 0) << 2 | (f.gce.transparent !== undefined ? 1 : 0);
      out.push(0x21, 0xf9, 0x04, packed, f.gce.delay & 0xff, (f.gce.delay >> 8) & 0xff,
        f.gce.transparent ?? 0, 0x00);
    }
    out.push(0x2c, f.left & 0xff, f.left >> 8, f.top & 0xff, f.top >> 8,
      f.w & 0xff, f.w >> 8, f.h & 0xff, f.h >> 8,
      f.interlace ? 0x40 : 0x00);
    out.push(...lzwEncode(f.minCodeSize ?? 2, f.indices));
  }
  out.push(0x3b);
  return Uint8Array.from(out).buffer;
}

const px = (r, w, x, y) => {
  const o = (y * w + x) * 4;
  return [r[o], r[o + 1], r[o + 2], r[o + 3]];
};

// ---------- 基础解码（全局色表 + 不透明） ----------
test('parseGif 基础解码：像素与延时', () => {
  const colors = [[10, 20, 30], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const indices = Uint8Array.from([0, 1, 2, 3, 3, 2, 1, 0]); // 4×2
  const gif = buildGif(4, 2, colors, [{ indices, left: 0, top: 0, w: 4, h: 2, gce: { delay: 25 } }]);
  const r = parseGif(gif);
  assert.equal(r.width, 4);
  assert.equal(r.height, 2);
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].delay, 250);
  assert.deepEqual(px(r.frames[0].data, 4, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(px(r.frames[0].data, 4, 3, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(r.frames[0].data, 4, 2, 1), [255, 0, 0, 255]); // 行1=[3,2,1,0]
});

// ---------- KwKwK 回指：同值串「aaaa…」触发解码端字典缺项回退 ----------
test('parseGif KwKwK 回指解码', () => {
  const colors = [[0, 0, 0], [200, 200, 200]];
  const indices = new Uint8Array(8).fill(1); // aaaaaaaa
  const gif = buildGif(8, 1, colors,
    [{ indices, left: 0, top: 0, w: 8, h: 1, minCodeSize: 8, gce: { delay: 5 } }]);
  const r = parseGif(gif);
  assert.equal(r.frames[0].delay, 50);
  for (let x = 0; x < 8; x++)
    assert.deepEqual(px(r.frames[0].data, 8, x, 0), [200, 200, 200, 255], `x=${x}`);
});

// ---------- 字典生长 + 组合码复用（交替图案，minCodeSize=8 有字典空间） ----------
test('parseGif 字典生长与组合码复用', () => {
  const colors = [[0, 0, 0], [200, 200, 200]];
  const N = 200;
  const indices = new Uint8Array(N);
  for (let i = 0; i < N; i++) indices[i] = i % 2;
  const gif = buildGif(N, 1, colors,
    [{ indices, left: 0, top: 0, w: N, h: 1, minCodeSize: 8 }]);
  const r = parseGif(gif);
  for (let x = 0; x < N; x++) {
    const want = x % 2 ? [200, 200, 200, 255] : [0, 0, 0, 255];
    assert.deepEqual(px(r.frames[0].data, N, x, 0), want, `x=${x}`);
  }
});

// ---------- 大图：跨子块（>255B）位流 ----------
test('parseGif 大图跨子块解码', () => {
  const colors = [[0, 0, 0], [255, 255, 255]];
  const W = 64, H = 64;
  const indices = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) indices[y * W + x] = (x + y) % 2;
  const gif = buildGif(W, H, colors,
    [{ indices, left: 0, top: 0, w: W, h: H, minCodeSize: 8 }]);
  const r = parseGif(gif);
  assert.equal(r.frames.length, 1);
  for (let y = 0; y < H; y += 7)
    for (let x = 0; x < W; x += 5) {
      const want = (x + y) % 2 ? 255 : 0;
      assert.equal(px(r.frames[0].data, W, x, y)[0], want, `(${x},${y})`);
    }
});

// ---------- 透明色 + disposal 2（清背景） ----------
test('parseGif 透明色与 disposal 2', () => {
  const colors = [[1, 1, 1], [255, 0, 0]];
  // 帧1 只画下行（上行保持初始透明）；帧2 画上行，索引1=透明（跳过）、0=黑
  const f1 = Uint8Array.from([1, 1]);
  const f2 = Uint8Array.from([1, 0]);
  const r = parseGif(buildGif(2, 2, colors, [
    { indices: f1, left: 0, top: 1, w: 2, h: 1, gce: { delay: 10 } },
    { indices: f2, left: 0, top: 0, w: 2, h: 1, gce: { delay: 10, transparent: 1, disposal: 2 } },
    { indices: Uint8Array.from([1, 1, 1, 1]), left: 0, top: 0, w: 2, h: 2, gce: { delay: 10 } },
  ]));
  assert.equal(r.frames.length, 3);
  const d1 = r.frames[0].data;
  assert.deepEqual(px(d1, 2, 0, 0), [0, 0, 0, 0]);     // 未绘制区域 = 初始透明
  assert.deepEqual(px(d1, 2, 0, 1), [255, 0, 0, 255]); // 下行红
  const d2 = r.frames[1].data;
  assert.deepEqual(px(d2, 2, 0, 0), [0, 0, 0, 0]);     // 透明索引 → 跳过，保持未绘制
  assert.deepEqual(px(d2, 2, 1, 0), [1, 1, 1, 255]);   // 黑
  assert.deepEqual(px(d2, 2, 0, 1), [255, 0, 0, 255]); // 帧1 保留（disposal 发生在输出后）
  const d3 = r.frames[2].data;
  // 帧2 输出后其矩形已被 disposal 2 清空，帧3 重画全屏 → 全红
  assert.deepEqual(px(d3, 2, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(d3, 2, 1, 1), [255, 0, 0, 255]);
});

// ---------- disposal 3（回退到绘制前画面） ----------
test('parseGif disposal 3 回退前帧', () => {
  const colors = [[255, 0, 0], [0, 255, 0]];
  const f1 = Uint8Array.from([0, 0, 0, 0]);
  const f2 = Uint8Array.from([1]);
  const f3 = Uint8Array.from([1]);
  const gif = buildGif(2, 2, colors, [
    { indices: f1, left: 0, top: 0, w: 2, h: 2, gce: { delay: 10 } },
    { indices: f2, left: 1, top: 1, w: 1, h: 1, gce: { delay: 10, disposal: 3 } },
    { indices: f3, left: 0, top: 0, w: 1, h: 1, gce: { delay: 10 } },
  ]);
  const r = parseGif(gif);
  const d2 = r.frames[1].data;
  assert.deepEqual(px(d2, 2, 1, 1), [0, 255, 0, 255]); // 帧2 叠了绿块
  assert.deepEqual(px(d2, 2, 0, 0), [255, 0, 0, 255]); // 其余是帧1 红
  const d3 = r.frames[2].data;
  assert.deepEqual(px(d3, 2, 0, 0), [0, 255, 0, 255]); // 帧3 在左上画绿
  assert.deepEqual(px(d3, 2, 1, 1), [255, 0, 0, 255]); // 帧2 的绿块被 disposal 3 回退抹掉
});

// ---------- 隔行还原 ----------
test('parseGif 隔行（interlace）行序还原', () => {
  const colors = Array.from({ length: 8 }, (_, i) => [i * 10, i * 10, i * 10]);
  // 目标：图像第 y 行 = 索引 y。交错「存储序」= 按扫描趟重排：0,4 | 2,6 | 1,3,5,7
  const stored = Uint8Array.from([0, 4, 2, 6, 1, 3, 5, 7]);
  const gif = buildGif(1, 8, colors,
    [{ indices: stored, left: 0, top: 0, w: 1, h: 8, interlace: true, minCodeSize: 4 }]);
  const r = parseGif(gif);
  const d = r.frames[0].data;
  for (let y = 0; y < 8; y++)
    assert.deepEqual(px(d, 1, 0, y), [y * 10, y * 10, y * 10, 255], `row ${y}`);
});

// ---------- 非法输入 ----------
test('parseGif 非法输入抛错', () => {
  assert.throws(() => parseGif(new TextEncoder().encode('PNG....').buffer), /GIF/);
  assert.throws(() => parseGif(new ArrayBuffer(0)));
});

// ---------- 帧延时下限（<=10ms 按浏览器惯例 100ms） ----------
test('parseGif 零延时取 100ms 兜底', () => {
  const colors = [[0, 0, 0], [9, 9, 9]];
  const gif = buildGif(1, 1, colors, [{ indices: Uint8Array.from([0]), left: 0, top: 0, w: 1, h: 1, gce: { delay: 0 } }]);
  assert.equal(parseGif(gif).frames[0].delay, 100);
});
