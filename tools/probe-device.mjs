// 真机只读探针：型号识别（PSD）+ 有线 520B 特征帧命令空间扫描（配置/键位）。
// node-hid 装在仓库外临时目录（与 find-psd.mjs 的 iced-x86 同模式，保持仓库零依赖）：
//   cd "$TEMP/reborg-re-deps" && npm i node-hid
// 用法：
//   node tools/probe-device.mjs                # 全量侦察：PSD + 命令扫描 + 键位层 dump
//   node tools/probe-device.mjs psd            # 只读 PSD
//   node tools/probe-device.mjs cfg            # 只扫配置/命令空间
//   node tools/probe-device.mjs matrix <sub>   # 读键位层 sub（层号），dump 前 32 dword
// 只发读族命令（0x82 GetPSD / 0x83-0x8A 块读，bit7=1），不发写侧命令。
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = join(process.env.TEMP || '/tmp', 'reborg-re-deps');
const require2 = createRequire(join(tmpDir, 'package.json'));
const HID = require2('node-hid');

const VID = 0x258a;
const FEAT_LEN = 520;
const hex = (b, n = b.length) => [...b.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');

// legacy 520B 帧（Fw==24 → report 6；无校验和，cmd@1）。node-hid 3.x：report id 须在缓冲区首字节
async function feat520(dev, rid, cmd, sub, len, payload = null, seq = 0) {
  const f = Buffer.alloc(FEAT_LEN);
  f[0] = rid; f[1] = cmd; f[2] = sub; f[3] = 0; f[4] = 0x01; f[5] = seq;
  f[6] = len & 0xff; f[7] = (len >> 8) & 0xff;
  if (payload) payload.copy(f, 8);
  await dev.sendFeatureReport(f);
  const resp = await dev.getFeatureReport(rid, FEAT_LEN);
  return Buffer.from(resp);
}

async function withDevice(path, fn) {
  const dev = new HID.HID(path);
  try { return await fn(dev); } finally { try { dev.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readPsd(dev, rid) {
  try {
    const resp = await feat520(dev, rid, 0x82, 0x01, 6);
    if (resp[0] !== rid) return { rid, ok: false, reason: `回显 report id ${resp[0]}≠${rid}` };
    return { rid, ok: true, psd: [...resp.subarray(8, 14)], head: hex(resp, 20) };
  } catch (e) { return { rid, ok: false, reason: e.message.slice(0, 80) }; }
}

async function readBlock(dev, rid, cmd, sub, len = 0x190) {
  const out = Buffer.alloc(len);
  let got = 0;
  for (let chunk = 0; chunk * 0x180 < len && chunk < 2; chunk++) {
    const want = Math.min(0x180, len - chunk * 0x180);
    const resp = await feat520(dev, rid, cmd, sub, want, null, chunk);
    if (resp[0] !== rid) throw new Error(`rid mismatch ${resp[0]}`);
    resp.copy(out, chunk * 0x180, 8, 8 + want);
    got += want;
  }
  return got === len ? out : out.subarray(0, got);
}

// 写键位层（cmd 03，驱动原生：sub=layer、帧[4]=总块数、512B 分块）
async function writeMatrix(dev, rid, layer, bytes) {
  const nChunks = Math.max(1, Math.ceil(bytes.length / 0x200));
  for (let i = 0; i < nChunks; i++) {
    const chunk = bytes.subarray(i * 0x200, Math.min((i + 1) * 0x200, bytes.length));
    const f = Buffer.alloc(FEAT_LEN);
    f[0] = rid; f[1] = 0x03; f[2] = layer; f[3] = 0; f[4] = nChunks; f[5] = i;
    f[6] = chunk.length & 0xff; f[7] = (chunk.length >> 8) & 0xff;
    chunk.copy(f, 8);
    await dev.sendFeatureReport(f);
    await dev.getFeatureReport(rid, FEAT_LEN); // 清应答
    if (i + 1 < nChunks) await sleep(70);
  }
  await sleep(60);
}

// wtest：键位写往返验证——改一键（默认 K17 '1'→'2'）→ 读回 → 还原 → 读回。
// 可传 slot:dword 覆盖测试目标（如 7:1f000000）。仅动一个 dword，始终还原。
async function wtest(dev, target) {
  const [slotStr, dstr] = (target ?? '7:1f000000').split(':');
  const slot = parseInt(slotStr, 10), testDw = parseInt(dstr, 16);
  const orig = await readBlock(dev, 6, 0x83, 0, 0x190);
  const origDw = orig.readUInt32LE(slot * 4);
  console.log(`  槽${slot} 原值 = 0x${origDw.toString(16).padStart(8, '0')}`);
  const modified = Buffer.from(orig);
  modified.writeUInt32LE(testDw >>> 0, slot * 4);
  console.log(`  写入 0x${(testDw >>> 0).toString(16).padStart(8, '0')} …`);
  await writeMatrix(dev, 6, 0, modified);
  const back1 = await readBlock(dev, 6, 0x83, 0, 0x190);
  const got = back1.readUInt32LE(slot * 4);
  console.log(`  读回 = 0x${got.toString(16).padStart(8, '0')}  ${got === (testDw >>> 0) ? '✓ 写入生效' : '✗ 未生效'}`);
  console.log(`  还原 …`);
  await writeMatrix(dev, 6, 0, orig);
  const back2 = await readBlock(dev, 6, 0x83, 0, 0x190);
  const got2 = back2.readUInt32LE(slot * 4);
  console.log(`  还原读回 = 0x${got2.toString(16).padStart(8, '0')}  ${got2 === origDw ? '✓ 已还原' : '✗ 还原失败！手动恢复：0x' + origDw.toString(16)}`);
  let diff = 0;
  for (let i = 0; i < 0x190; i++) if (back2[i] !== orig[i]) diff++;
  console.log(`  全表比对：${diff === 0 ? '逐字节一致 ✓' : diff + ' 字节差异 ✗'}`);
}

const mode = process.argv[2] ?? 'all';

const devices = HID.devices().filter((d) => d.vendorId === VID);
const vendorIfaces = devices.filter((d) => d.usagePage === 0xff00);

// dump：配置 blob + 4 层键位 → JSON（真机仲裁/编码比对用）
if (mode === 'wtest') {
  const d = vendorIfaces.find((x) => String(x.path).includes('Col06')) ?? vendorIfaces[vendorIfaces.length - 1];
  await withDevice(d.path, (dev) => wtest(dev, process.argv[3]));
} else if (mode === 'dump') {
  const d = vendorIfaces.find((x) => String(x.path).includes('Col06')) ?? vendorIfaces[vendorIfaces.length - 1];
  await withDevice(d.path, async (dev) => {
    const out = { ts: new Date().toISOString(), psd: null, config: null, layers: {} };
    const psd = await readPsd(dev, 6);
    if (psd.ok) out.psd = psd.psd;
    try { out.config = [...await readBlock(dev, 6, 0x84, 0, 0x190)]; } catch (e) { out.configErr = e.message; }
    for (let layer = 0; layer < 4; layer++) {
      try { out.layers[layer] = [...await readBlock(dev, 6, 0x83, layer, 0x190)]; } catch (e) { out.layers[layer] = { err: e.message }; }
      await sleep(30);
    }
    console.log(JSON.stringify(out));
  });
} else {

console.log(`vendor 接口 ${vendorIfaces.length} 个：`);
const vendorIfaces = devices.filter((d) => d.usagePage === 0xff00);
console.log(`vendor 接口 ${vendorIfaces.length} 个：`);
vendorIfaces.forEach((d, i) => console.log(`  [${i}] mi path …${String(d.path).replace(/^.*mi_(\d\d).*$/, 'mi_$1')} usage 0x${d.usage.toString(16)}`));

for (let i = 0; i < vendorIfaces.length; i++) {
  const d = vendorIfaces[i];
  const tag = String(d.path).replace(/^.*mi_(\d\d).*$/, 'mi_$1');
  console.log(`\n===== 接口 [${i}] ${tag} =====`);
  await withDevice(d.path, async (dev) => {
    if (mode === 'all' || mode === 'psd') {
      for (const rid of [6, 9, 5]) {
        const r = await readPsd(dev, rid);
        if (r.ok) { console.log(`  PSD (report ${r.rid}): ${r.psd.map((b) => b.toString(16).padStart(2, '0')).join(' ')}   [head] ${r.head}`); break; }
        console.log(`  PSD report ${rid}: ${r.reason}`);
      }
    }
    if (mode === 'all' || mode === 'cfg') {
      for (const rid of [6, 9]) {
        let any = false;
        try {
          for (const cmd of [0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a]) {
            for (const sub of [0, 1, 2]) {
              try {
                const blob = await readBlock(dev, rid, cmd, sub, 0x190);
                const a5 = blob[126] === 0x5a && blob[127] === 0xa5;
                const nz = [...blob.subarray(0, 40)].some((b) => b !== 0);
                if (!nz && !a5) continue;
                any = true;
                console.log(`  cmd ${cmd.toString(16)}/${sub} report ${rid}: a5=${a5 ? 'Y' : 'n'} head=${hex(blob, 24)}`);
              } catch { /* 该命令不存在 */ }
              await sleep(20);
            }
          }
        } catch (e) { console.log(`  扫描中断: ${e.message}`); }
        if (any) break;
      }
    }
    if (mode === 'matrix') {
      const sub = parseInt(process.argv[3] ?? '0', 10);
      for (const rid of [6, 9]) {
        try {
          const blob = await readBlock(dev, rid, 0x83, sub, 0x190);
          const words = [];
          for (let k = 0; k + 4 <= 128; k += 4) words.push(((blob[k + 3] << 24) | (blob[k + 2] << 16) | (blob[k + 1] << 8) | blob[k]) >>> 0);
          console.log(`  层${sub} (report ${rid}) 前 32 dword：`);
          for (let r2 = 0; r2 < 32; r2 += 8) console.log(`    [${String(r2).padStart(2)}] ${words.slice(r2, r2 + 8).map((w) => w.toString(16).padStart(8, '0')).join(' ')}`);
          break;
        } catch (e) { console.log(`  层${sub} report ${rid}: ${e.message.slice(0, 60)}`); }
      }
    }
  }).catch((e) => console.log(`  打开失败: ${e.message.slice(0, 80)}`));
}
}
