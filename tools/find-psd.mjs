// OemDrv.exe 逆向分析工具（型号识别/PSD 协议研究用，仓库常驻）
// 依赖：npm 无（iced-x86 按需装到临时目录，见 ensureDeps）
// 用法：
//   node tools/find-psd.mjs refs <子串>        # 含该子串的宽字符串及其代码引用位置
//   node tools/find-psd.mjs dis <vaHex> <len>  # 反汇编（注释字符串/IAT API/thunk）
//   node tools/find-psd.mjs callers <vaHex>    # 某函数的所有 call 调用者
//   node tools/find-psd.mjs dump <vaHex> <len> # 原始字节
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(ROOT, '..', 'origin_installer', 'LEOBOG ONE Setup v2.0 20250527', 'OemDrv.exe');

// iced-x86 放临时目录，不进仓库
const tmpDir = join(process.env.TEMP || '/tmp', 'reborg-re-deps');
if (!existsSync(join(tmpDir, 'node_modules', 'iced-x86'))) {
  mkdirSync(tmpDir, { recursive: true });
  if (!existsSync(join(tmpDir, 'package.json'))) {
    const { execSync } = await import('node:child_process');
    execSync('npm init -y', { cwd: tmpDir, stdio: 'ignore' });
    execSync('npm install --no-audit --no-fund iced-x86', { cwd: tmpDir, stdio: 'ignore' });
  }
}
const require2 = createRequire(join(tmpDir, 'package.json'));
const iced = require2('iced-x86');
const { Decoder, DecoderOptions, Mnemonic } = iced;

const exe = readFileSync(EXE);
const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
const peOff = dv.getUint32(0x3c, true);
const nSec = dv.getUint16(peOff + 6, true), optSize = dv.getUint16(peOff + 20, true);
const imageBase = dv.getUint32(peOff + 0x34, true);
const secs = [];
for (let i = 0; i < nSec; i++) {
  const s = peOff + 24 + optSize + i * 40;
  secs.push({ vsize: dv.getUint32(s + 8, true), va: dv.getUint32(s + 12, true), rawSize: dv.getUint32(s + 16, true), raw: dv.getUint32(s + 20, true) });
}
const text = secs.find((s) => s.raw === 0x400);
const vaToOff = (va) => { for (const s of secs) if (va >= imageBase + s.va && va < imageBase + s.va + s.vsize) return s.raw + (va - imageBase - s.va); };
const offToVa = (off) => { for (const s of secs) if (off >= s.raw && off < s.raw + s.rawSize) return imageBase + s.va + off - s.raw; };

// IAT 名字表（call [iat] 直接调用解析用）
const impRVA = dv.getUint32(peOff + 24 + 96 + 8, true);
const iatName = new Map();
{
  let desc = vaToOff(imageBase + impRVA);
  for (;;) {
    const nameRva = dv.getUint32(desc + 12, true), iat = dv.getUint32(desc + 16, true);
    if (!nameRva) break;
    const dll = exe.subarray(vaToOff(imageBase + nameRva)).toString('ascii').split('\0')[0];
    for (let i = 0; ; i++) {
      const e = dv.getUint32(vaToOff(imageBase + iat) + i * 4, true);
      if (!e) break;
      if (!(e & 0x80000000)) iatName.set(imageBase + iat + i * 4, `${dll}!${exe.subarray(vaToOff(imageBase + e) + 2).toString('ascii').split('\0')[0]}`);
    }
    desc += 20;
  }
}
// thunk → API（jmp [iat] 中转调用解析用）
const thunkApi = new Map();
for (let va = 0x5bf000; va < 0x5c2000; va++) {
  const o = vaToOff(va);
  if (o != null && exe[o] === 0xff && exe[o + 1] === 0x25 && iatName.has(dv.getUint32(o + 2, true))) thunkApi.set(va, iatName.get(dv.getUint32(o + 2, true)));
}
// 宽字符串表
const wstr = new Map();
let pos = 0;
while (pos + 1 < exe.length) {
  let i = pos, s = '';
  while (i + 1 < exe.length && exe[i + 1] === 0 && exe[i] >= 0x20 && exe[i] < 0x7f) { s += String.fromCharCode(exe[i]); i += 2; }
  if (s.length >= 5) { wstr.set(offToVa(pos), s.slice(0, 100)); pos = i; } else pos += 2;
}

const mode = process.argv[2];
const hex = (n) => '0x' + (n >>> 0).toString(16);

if (mode === 'refs') {
  const sub = process.argv[3].toLowerCase();
  for (const [va, s] of wstr) {
    if (!s.toLowerCase().includes(sub)) continue;
    const needle = Buffer.alloc(4); needle.writeUInt32LE(va);
    let p = text.raw;
    for (;;) {
      const at = exe.indexOf(needle, p);
      if (at < 0 || at >= text.raw + text.rawSize) break;
      console.log(`"${s.slice(0, 60)}" @str ${hex(va)}  ref ${hex(offToVa(at))}`);
      p = at + 1;
    }
  }
} else if (mode === 'dis') {
  const start = parseInt(process.argv[3], 16), len = parseInt(process.argv[4], 16);
  const d = new Decoder(32, new Uint8Array(exe.subarray(vaToOff(start), vaToOff(start) + len)), DecoderOptions.NONE);
  for (;;) {
    const insn = d.decode();
    if (d.lastError !== 0 || d.position >= len) break;
    const va = start + Number(insn.ip);
    let line = insn.toString();
    let note = '';
    if (insn.mnemonic === Mnemonic.Call || insn.mnemonic === Mnemonic.Jmp) {
      const mIat = line.match(/\[([0-9A-F]{6})h\]/i);
      if (mIat && iatName.has(parseInt(mIat[1], 16))) note = `  ; ${iatName.get(parseInt(mIat[1], 16))}`;
      else {
        const t = line.match(/0x([0-9a-f]+)/i);
        if (t) {
          const tv = start + (parseInt(t[1], 16) - Number(insn.ip));
          if (thunkApi.has(tv)) note = `  ; ${thunkApi.get(tv)}`;
          else if (wstr.has(tv)) note = `  ; "${wstr.get(tv).slice(0, 60)}"`;
          else note = `  ; → ${hex(tv)}`;
        }
      }
    } else {
      const t = line.match(/0x([0-9a-f]{6})/i);
      if (t && wstr.has(parseInt(t[1], 16))) note = `  ; "${wstr.get(parseInt(t[1], 16)).slice(0, 60)}"`;
    }
    console.log(`${hex(va)}: ${line}${note}`);
  }
} else if (mode === 'callers') {
  const target = parseInt(process.argv[3], 16);
  const hits = [];
  for (let off = text.raw; off < text.raw + text.rawSize - 5; off++) {
    if (exe[off] !== 0xe8) continue;
    const disp = exe.readInt32LE(off + 1);
    const va = offToVa(off);
    if (va + 5 + disp === target) hits.push(va);
  }
  console.log(hits.length ? hits.map(hex).join('\n') : '(无调用者)');
} else if (mode === 'dump') {
  const start = parseInt(process.argv[3], 16), len = parseInt(process.argv[4], 16);
  const o = vaToOff(start);
  for (let i = 0; i < len; i += 16) console.log(`${hex(start + i)}: ${exe.subarray(o + i, o + i + 16).toString('hex').replace(/(..)/g, '$1 ')}`);
} else {
  console.log('用法: refs <子串> | dis <va> <len> | callers <va> | dump <va> <len>');
}
