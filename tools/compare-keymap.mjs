// 真机键位 ↔ fnToDword(型号默认) 比对工具（配 probe-device.mjs dump 使用）。
// 用法：node tools/probe-device.mjs dump > %TEMP%/dump.json
//       node tools/compare-keymap.mjs <dump.json> [modelSlug]
// 退出码 0=全一致（含空槽），1=存在差异（差异明细见输出）
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (await import(`file:///${(ROOT + '/js/device/protocol.js').replace(/\\/g, '/')}`));

const dumpPath = process.argv[2];
if (!dumpPath) { console.error('用法：node tools/compare-keymap.mjs <dump.json> [modelSlug]'); process.exit(2); }
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));

// 型号：显式参数 > 按 PSD 匹配注册表
const index = JSON.parse(fs.readFileSync(join(ROOT, 'assets/models/index.json'), 'utf8'));
let slug = process.argv[3];
if (!slug) {
  const hit = index.find((m) => m.psd.length === dump.psd.length && m.psd.every((b, i) => b === dump.psd[i]));
  if (!hit) { console.error('PSD 未匹配注册表，请传 modelSlug'); process.exit(2); }
  slug = hit.slug;
}
const model = JSON.parse(fs.readFileSync(join(ROOT, 'assets/models', slug, 'model.json'), 'utf8'));
console.log(`型号 ${slug}（${model.name}）：${model.keys.length} 键，maxSlot=${Math.max(...model.keys.map((k) => k.matrix))}`);

const words = (arr) => { const b = Buffer.from(arr); const w = []; for (let k = 0; k + 4 <= b.length; k += 4) w.push(b.readUInt32LE(k)); return w; };
const hex8 = (w) => (w >>> 0).toString(16).padStart(8, '0');
let totalMiss = 0;

for (let l = 0; l < 4; l++) {
  const raw = dump.layers[l];
  if (!Array.isArray(raw)) { console.log(`层${l}: 读取失败`); continue; }
  const dev = words(raw);
  let match = 0, miss = 0, empty = 0, skip = 0;
  const misses = [];
  for (const k of model.keys) {
    const dw = dev[k.matrix] ?? 0;
    const fn = l === 0 ? k.fn : (l === 1 ? model.fn1?.[k.i] : null);
    if (!fn) { if (dw === 0) empty++; else { misses.push(`  槽${k.matrix}(K${k.i} vk=${k.vk?.toString(16) ?? '?'}) 设备=${hex8(dw)} 默认=无`); miss++; } continue; }
    const exp = P.fnToDword(fn, { macroOrder: [] });
    if (exp == null) { skip++; continue; }
    if (exp === (dw >>> 0)) match++;
    else { miss++; misses.push(`  槽${k.matrix}(K${k.i} vk=${k.vk?.toString(16) ?? '?'}) 设备=${hex8(dw)} 期望=${hex8(exp)} fn=${JSON.stringify(fn)}`); }
  }
  totalMiss += miss;
  console.log(`层${l}: 一致 ${match} / 不一致 ${miss} / 双空 ${empty} / 无编码跳过 ${skip}（设备非零 dword ${dev.filter((w) => w).length}）`);
  for (const m of misses) console.log(m);
}

// 配置 blob 摘要（Tap/Sleep/去抖仲裁证据）
if (Array.isArray(dump.config)) {
  const c = dump.config;
  const pair = (i, j) => `${c[i].toString(16)}${c[i] === c[j] ? '=' : '≠'}${c[j].toString(16)}`;
  console.log(`\n配置 blob：去抖对 blob[1,2]=${pair(1, 2)}  blob[2,3]=${pair(2, 3)} · blob[6]=${c[6].toString(16)} blob[7]=${c[7].toString(16)} blob[8]=${c[8].toString(16)} blob[9]=${c[9].toString(16)} · 尾=${c[126].toString(16)} ${c[127].toString(16)}`);
}
process.exit(totalMiss ? 1 : 0);
