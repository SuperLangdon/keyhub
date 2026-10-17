#!/usr/bin/env node
// 型号注册表校验器（零依赖）：node tools/validate-registry.mjs
// 依据 docs/registry-schema.md 检查 assets/models/ 的结构一致性、PSD 唯一性、
// 几何合法性、协议代际白名单与贡献元数据。CI（.github/workflows/validate.yml）
// 以本脚本的退出码为合并闸门；错误必须清零，警告仅提示。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = resolve(ROOT, 'assets/models');

// 协议代际白名单（js/device/protocol.js 的 configureModel 按 fw 分派 520B 通道）：
// 24 = LEOBOG 520B feature report 6 族；26 = 银雕 K65 report 9 族。
// 新代际须先逆向确认写入 protocol.js，再同步加到这里——否则校验拒绝入库（防盲写硬件）。
const KNOWN_FW = new Set([24, 26]);

const errors = [];
const warns = [];
const err = (slug, msg) => errors.push(`[${slug ?? '?'}] ${msg}`);
const warn = (slug, msg) => warns.push(`[${slug ?? '?'}] ${msg}`);

const isInt = (v) => Number.isInteger(v);
const isByte = (v) => isInt(v) && v >= 0 && v <= 255;
const isPid = (v) => isInt(v) && v >= 0 && v <= 0xffff;

// PNG IHDR 宽高（大端 uint32 @ 偏移 16/20）；非 PNG 返回 null
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return { __parseError: e.message }; }
}

// ---------- index.json ----------
const idxFile = resolve(MODELS, 'index.json');
if (!existsSync(idxFile)) { console.error('缺少 assets/models/index.json'); process.exit(1); }
const idx = readJson(idxFile);
if (idx.__parseError) { console.error('index.json 解析失败: ' + idx.__parseError); process.exit(1); }
if (!Array.isArray(idx) || !idx.length) { console.error('index.json 必须为非空数组'); process.exit(1); }

// PSD 全局查重：撞车必须显式可区分（键数或名称不同），否则拒绝
const byPsd = new Map();
for (const m of idx) {
  if (!Array.isArray(m.psd)) continue;
  const k = m.psd.join(',');
  if (!byPsd.has(k)) byPsd.set(k, []);
  byPsd.get(k).push(m);
}
for (const [k, group] of byPsd) {
  if (group.length < 2) continue;
  const distinct = group.some((m, i) => group.slice(i + 1).some((n) => m.keys !== n.keys || m.name !== n.name));
  if (!distinct) {
    group.forEach((m) => err(m.slug, `PSD [${k}] 与其他型号重复且无区分字段（键数/名称均相同）——撞车型号必须可区分，见 docs/registry-schema.md`));
  } else {
    group.forEach((m) => warn(m.slug, `PSD [${k}] 被 ${group.length} 个型号共享（已声明区分字段），运行时识别将进入候选消歧`));
  }
}

// ---------- 逐条目 ----------
const seenSlug = new Set();
const seenDir = new Set();
for (const m of idx) {
  const slug = m.slug;
  if (typeof slug !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(slug)) { err(slug, 'slug 缺失或含非法字符（允许 [A-Za-z0-9_.-]）'); continue; }
  if (seenSlug.has(slug)) err(slug, 'slug 重复'); seenSlug.add(slug);

  const dir = resolve(MODELS, slug);
  if (basename(dir) !== slug) err(slug, 'slug 必须与目录名一致');
  if (!existsSync(dir)) { err(slug, `目录 ${slug}/ 不存在`); continue; }
  seenDir.add(slug);

  // ---- index 条目自身 ----
  for (const f of ['name', 'short', 'sub']) if (typeof m[f] !== 'string' || !m[f].trim()) err(slug, `index.${f} 缺失或为空`);
  if (!Array.isArray(m.psd) || m.psd.length !== 6 || !m.psd.every(isByte)) err(slug, 'index.psd 必须为 6 字节（0-255 整数）数组');
  if (!isInt(m.keys) || m.keys <= 0) err(slug, 'index.keys 必须为正整数');
  for (const side of ['wired', 'wireless']) {
    const v = m[side];
    if (v === null) continue;
    if (!v || !isPid(v.vid) || !isPid(v.pid)) err(slug, `index.${side} 必须为 {vid,pid} 或 null`);
  }
  if (!m.wired && !m.wireless) err(slug, 'wired 与 wireless 不能同时为空');
  // 贡献元数据（docs/registry-schema.md 约定 7：溯源必填）
  if (!m.source || typeof m.source.vendor !== 'string' || !m.source.vendor.trim() || typeof m.source.driver !== 'string' || !m.source.driver.trim())
    err(slug, 'index.source 必填：{vendor, driver}（驱动来源与版本）');
  if (typeof m.attribution !== 'string' || !m.attribution.trim()) err(slug, 'index.attribution 必填：keyimg/派生数据的版权标注');
  if (typeof m.contributor !== 'string' || !m.contributor.trim()) err(slug, 'index.contributor 必填');
  if (typeof m.added !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.added)) err(slug, 'index.added 必填：YYYY-MM-DD');

  // ---- model.json ----
  const mjFile = resolve(dir, 'model.json');
  const kiFile = resolve(dir, 'keyimg.png');
  if (!existsSync(mjFile)) { err(slug, '缺少 model.json'); continue; }
  if (!existsSync(kiFile)) err(slug, '缺少 keyimg.png'); // 下面 pngSize 会再报一次解析问题
  const j = readJson(mjFile);
  if (j.__parseError) { err(slug, 'model.json 解析失败: ' + j.__parseError); continue; }

  // 交叉一致（约定 5）
  if (Array.isArray(j.psd) && Array.isArray(m.psd) && j.psd.join(',') !== m.psd.join(',')) err(slug, `psd 不一致：index=[${m.psd}] model=[${j.psd}]`);
  for (const f of ['name', 'short', 'sub']) if (typeof j[f] === 'string' && typeof m[f] === 'string' && j[f] !== m[f]) err(slug, `${f} 不一致：index="${m[f]}" model="${j[f]}"`);
  if (isPid(j.vid) && m.wired && (j.vid !== m.wired.vid || j.pid !== m.wired.pid)) err(slug, `有线 VID/PID 不一致：index=${JSON.stringify(m.wired)} model=${j.vid}:${j.pid}`);
  const jW = (isPid(j.vidW) && isPid(j.pidW)) ? { vid: j.vidW, pid: j.pidW } : null;
  if (JSON.stringify(jW) !== JSON.stringify(m.wireless ?? null)) err(slug, `无线 VID/PID 不一致：index=${JSON.stringify(m.wireless)} model=${JSON.stringify(jW)}`);
  if (j.slug !== undefined && j.slug !== slug) err(slug, `model.slug("${j.slug}") 与目录名不符`);

  // 协议代际白名单（约定 3）
  if (!isInt(j.fw)) err(slug, 'model.fw 缺失或非整数');
  else if (!KNOWN_FW.has(j.fw)) err(slug, `未知协议代际 fw=${j.fw}（白名单：${[...KNOWN_FW].join('/')}）——新代际需先逆向确认（提 issue 附调试台诊断包），加白名单后方可入库`);

  // 结构
  if (!isInt(j.layerNum) || j.layerNum < 1) err(slug, 'model.layerNum 必须为 ≥1 整数');
  if (!isInt(j.ledMask) || j.ledMask < 0) err(slug, 'model.ledMask 必须为非负整数');
  if (!Array.isArray(j.ledopts) || !j.ledopts.length) {
    err(slug, 'model.ledopts 缺失或为空');
  } else {
    const uis = new Set();
    let hasOff = false;
    for (const o of j.ledopts) {
      if (!o || !isInt(o.ui) || !isInt(o.fw)) { err(slug, 'ledopts 行缺少 ui/fw 整数: ' + JSON.stringify(o)); continue; }
      if (uis.has(o.ui)) err(slug, `ledopts.ui ${o.ui} 重复`);
      uis.add(o.ui);
      for (const b of ['speed', 'light', 'dir', 'rand', 'color']) if (typeof o[b] !== 'boolean') err(slug, `ledopts ui=${o.ui} 缺少能力布尔值 ${b}`);
      if (o.fw === 0) hasOff = true;
    }
    // 约定：必须含 fw===0 关灯行（js/pages/light.js 依赖 findIndex 定位自定义槽插入点）
    if (!hasOff) err(slug, 'ledopts 必须至少含一行 fw===0（关灯行）——否则灯光页自定义槽会插错位置');
    if (j.ledopts.length !== 19)
      warn(slug, `ledopts 共 ${j.ledopts.length} 行（现有型号均为 19）——非致命，请确认灯效表与该固件代际一致`);
  }

  // img / keyimg.png
  if (!j.img || !isInt(j.img.w) || !isInt(j.img.h) || j.img.w <= 0 || j.img.h <= 0) {
    err(slug, 'model.img 必须为 {w,h} 正整数');
  } else if (existsSync(kiFile)) {
    const sz = pngSize(kiFile);
    if (!sz) err(slug, 'keyimg.png 不是合法 PNG');
    else if (sz.w !== j.img.w || sz.h !== j.img.h) err(slug, `img(${j.img.w}x${j.img.h}) 与 keyimg.png 实际尺寸(${sz.w}x${sz.h})不符`);
  }

  // keys
  if (!Array.isArray(j.keys) || !j.keys.length) { err(slug, 'model.keys 缺失或为空'); }
  else {
    const seenI = new Set(), seenMatrix = new Set();
    let visible = 0, prevI = 0;
    const keyIds = new Set();
    for (const k of j.keys) {
      const tag = `keys[i=${k?.i}]`;
      if (!isInt(k.i) || k.i <= 0) { err(slug, `${tag} i 必须为正整数`); continue; }
      keyIds.add(k.i);
      if (k.i <= prevI) err(slug, `${tag} i 未严格升序（前一个 ${prevI}）`);
      prevI = k.i;
      if (seenI.has(k.i)) err(slug, `${tag} i 重复`);
      seenI.add(k.i);
      if (!Array.isArray(k.r) || k.r.length !== 4 || !k.r.every(isInt)) { err(slug, `${tag} r 必须为 int[4]`); continue; }
      const [l, t, r, b] = k.r;
      const isVirtual = l === 0 && t === 0 && r === 0 && b === 0;
      if (r > l) {
        visible++;
        if (b <= t) err(slug, `${tag} 可见键矩形退化（b 必须大于 t）`);
        if (j.img && (l < 0 || t < 0 || r > j.img.w || b > j.img.h)) err(slug, `${tag} 矩形越出底图边界 ${JSON.stringify(k.r)} vs ${j.img.w}x${j.img.h}`);
      } else if (!isVirtual) {
        err(slug, `${tag} 非可见键必须为旋钮虚键 [0,0,0,0]（当前 ${JSON.stringify(k.r)}）`);
      }
      if (!(k.vk === null || isInt(k.vk))) err(slug, `${tag} vk 必须为整数或 null`);
      if (!k.fn || !isInt(k.fn.type) || !isInt(k.fn.code) || !isInt(k.fn.param)) err(slug, `${tag} fn 必须为 {type,code,param} 整数`);
      if (!isInt(k.matrix) || k.matrix < 0) err(slug, `${tag} matrix 必须为非负整数`);
      else if (seenMatrix.has(k.matrix)) err(slug, `${tag} matrix ${k.matrix} 重复（灯光会下错物理灯）`);
      else seenMatrix.add(k.matrix);
    }
    // 约定 4：index.keys = 可见条目数
    if (isInt(m.keys) && visible !== m.keys) err(slug, `index.keys=${m.keys} 与可见键数 ${visible} 不符（旋钮虚键不计入）`);
    // fn1 / animations 引用的键必须存在
    if (j.fn1 && typeof j.fn1 === 'object' && !Array.isArray(j.fn1)) {
      for (const [ki, fn] of Object.entries(j.fn1)) {
        if (!/^\d+$/.test(ki) || !keyIds.has(+ki)) { err(slug, `fn1 引用了不存在的键索引 "${ki}"`); continue; }
        if (!fn || !isInt(fn.type) || !isInt(fn.code) || !isInt(fn.param)) err(slug, `fn1[${ki}] 必须为 {type,code,param} 整数`);
      }
    }
    if (j.animations && typeof j.animations === 'object') {
      for (const [name, frames] of Object.entries(j.animations)) {
        if (!Array.isArray(frames) || !frames.length) { err(slug, `animations["${name}"] 必须为非空帧数组`); continue; }
        for (const fr of frames) {
          if (!fr || !Array.isArray(fr.groups)) { err(slug, `animations["${name}"] 帧缺少 groups`); continue; }
          for (const g of fr.groups) {
            if (!Array.isArray(g) || !g.length || !g.every((x) => isInt(x) && keyIds.has(x))) {
              err(slug, `animations["${name}"] 帧组引用了不存在的键索引: ${JSON.stringify(g)}`);
              break;
            }
          }
          if (fr.color !== null && !(Array.isArray(fr.color) && fr.color.length === 3 && fr.color.every(isByte)))
            err(slug, `animations["${name}"] 帧 color 必须为 [r,g,b] 或 null`);
        }
      }
    }
    if (j.screen != null && (!isInt(j.screen.w) || !isInt(j.screen.h) || !isInt(j.screen.maxFrames) || j.screen.w <= 0 || j.screen.h <= 0 || j.screen.maxFrames <= 0))
      err(slug, 'model.screen 必须为 {w,h,maxFrames} 正整数');
    if (j.sleepTime !== undefined && !isInt(j.sleepTime)) err(slug, 'model.sleepTime 必须为整数');
    if (j.defLedIndex !== undefined && !isInt(j.defLedIndex)) err(slug, 'model.defLedIndex 必须为整数');
  }
}

// 孤儿目录：有 model.json 但不在 index 里 → 注册表不可达死数据
if (existsSync(MODELS)) {
  for (const d of readdirSync(MODELS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (!seenDir.has(d.name) && existsSync(resolve(MODELS, d.name, 'model.json')))
      err(d.name, '目录含 model.json 但未登记进 index.json（不可达）');
  }
}

// ---------- 汇总 ----------
for (const w of warns) console.log('WARN  ' + w);
for (const e of errors) console.error('ERROR ' + e);
console.log(`\n注册表校验：${idx.length} 个型号，${errors.length} 错误，${warns.length} 警告`);
process.exit(errors.length ? 1 : 0);
