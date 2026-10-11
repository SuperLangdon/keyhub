// WebHID 低层 I/O 与高层操作（真机）
import * as P from './protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hidAvailable() {
  return !!navigator.hid && window.isSecureContext;
}

// 接口描述符摘要：遍历 collections 树，收集各类型声明的 report ID
// （Chrome 解析好 report descriptor 后挂在 device.collections 上，可直接诊断
//   「识别报告是否存在于该接口」这类问题，不必猜）
export function reportIds(dev) {
  const out = { input: [], output: [], feature: [] };
  const walk = (cs) => {
    for (const c of cs ?? []) {
      for (const r of c.inputReports ?? []) if (!out.input.includes(r.reportId)) out.input.push(r.reportId);
      for (const r of c.outputReports ?? []) if (!out.output.includes(r.reportId)) out.output.push(r.reportId);
      for (const r of c.featureReports ?? []) if (!out.feature.includes(r.reportId)) out.feature.push(r.reportId);
      walk(c.collections);
    }
  };
  walk(dev.collections);
  return out;
}
export const hasFeatureReport = (dev, id) => reportIds(dev).feature.includes(id);
export const hasOutputReport = (dev, id) => reportIds(dev).output.includes(id);

// channel: 'any' | 'wired' | 'wireless'（手动添加流程按用户选择的通道过滤）
// 返回**已打开的 HIDDevice 数组**（可能为多个 USB 接口——Chrome 授权按接口给，键盘的
// vendor 功能可能分散在不同接口上），取消返回 null。
export async function requestDevice(log, channel = 'any') {
  if (!hidAvailable()) throw new Error('WebHID 不可用：需要 Chrome/Edge 并通过 localhost 或 HTTPS 访问');
  const targets = channel === 'wired' ? [P.WIRED]
    : channel === 'wireless' ? [P.WIRELESS]
    : [P.WIRED, P.WIRELESS];
  const filters = [];
  for (let page = 0xff00; page <= 0xff04; page++) {
    for (const t of targets) filters.push({ vendorId: t.vid, productId: t.pid, usagePage: page });
  }
  for (const t of targets) filters.push({ vendorId: t.vid, productId: t.pid });
  log && log('in', '请求选择 HID 设备（' + targets.map((t) => `${t.vid.toString(16)}:${t.pid.toString(16)}`).join(' / ') + '）…');
  const granted = await navigator.hid.requestDevice({ filters });
  if (!granted?.length) return null;
  const opened = [];
  for (const dev of granted) {
    try {
      if (!dev.opened) await dev.open();
      const id = `${dev.vendorId.toString(16).padStart(4, '0')}:${dev.productId.toString(16).padStart(4, '0')}`;
      // 详细信息（collections/报告 ID）解析失败也不能丢掉这条基本日志
      let detail = '';
      try {
        const cols = dev.collections.map((c) => `${(c.usagePage ?? 0).toString(16)}:${(c.usage ?? 0).toString(16)}`).join(' ');
        const r = reportIds(dev);
        const fmt = (a) => a.map((x) => x.toString(16)).join(',') || '-';
        detail = ` collections[${cols}] 报文 in[${fmt(r.input)}] out[${fmt(r.output)}] feat[${fmt(r.feature)}]`;
      } catch { /* collections 结构异常则只记基本信息 */ }
      log && log('in', `已打开接口 ${dev.productName || 'Keyboard'} (${id})${detail}`);
      opened.push(dev);
    } catch (e) {
      log && log('er', `打开接口失败（${dev.productName || 'Keyboard'}）: ${e.message}`);
    }
  }
  return opened;
}

// ---------- 低层 ----------
export async function txRx(dev, frame, log, timeoutMs = 220) {
  await dev.sendReport(frame[0], frame.slice(1));
  log && log('tx', P.hex(frame));
  await sleep(4);
  const echo = await readReport(dev, timeoutMs);
  if (echo) log && log('rx', P.hex(echo));
  return echo;
}

export async function readReport(dev, timeoutMs = 220) {
  return new Promise((resolve) => {
    let done = false;
    const h = (e) => {
      if (done) return;
      done = true; dev.removeEventListener('inputreport', h);
      const full = new Uint8Array(e.data.buffer.byteLength + 1);
      full[0] = e.reportId;
      full.set(new Uint8Array(e.data.buffer), 1);
      resolve(full);
    };
    dev.addEventListener('inputreport', h);
    setTimeout(() => { if (!done) { done = true; dev.removeEventListener('inputreport', h); resolve(null); } }, timeoutMs);
  });
}

export async function txBulk(dev, frames, label, log) {
  let ok = 0;
  for (const f of frames) { const e = await txRx(dev, f, log); if (e) ok++; }
  log && log('in', `${label}: ${ok}/${frames.length}`);
  return ok;
}

// 读 10 片配置（带缓冲与重试）
export async function readConfig(dev, log, retries = 3) {
  const buf = [];
  const h = (e) => {
    const full = new Uint8Array(e.data.buffer.byteLength + 1);
    full[0] = e.reportId;
    full.set(new Uint8Array(e.data.buffer), 1);
    buf.push(full);
  };
  dev.addEventListener('inputreport', h);
  try {
    for (let a = 0; a < retries; a++) {
      if (a > 0) { log && log('in', `重读配置 (${a + 1}/${retries})…`); await sleep(150); buf.length = 0; }
      const req = P.buildFrame(P.CMD_READ, P.SUBCMD_CONFIRM, 0, new Uint8Array(15));
      await dev.sendReport(req[0], req.slice(1));
      log && log('tx', P.hex(req));
      const cfg = new Array(10).fill(null);
      const deadline = Date.now() + 1600;
      while (Date.now() < deadline) {
        while (buf.length) {
          const r = buf.shift();
          if (r.length >= 20 && r[0] === P.REPORT_ID && r[1] === P.CMD_READ && r[2] === P.SUBCMD_CONFIG) {
            const seq = r[3];
            if (seq >= 0 && seq < 10) { cfg[seq] = r; log && log('rx', P.hex(r)); }
          }
        }
        if (cfg.every((c) => c !== null)) return cfg;
        await sleep(20);
      }
    }
  } finally {
    dev.removeEventListener('inputreport', h);
  }
  return null;
}

// ---------- 高层 ----------
// 应用灯光效果（无线 0x13 协议）。effect: SW 槽位号（LedOpt 首列，1-18/21；0=关；与有线 520B 同域同存储）；
// opts: {color, colorful, brightness, speed}
// 返回 true=设备有回显（交互正常）；false=全程无回显（大概率 2.4G 休眠，需按键唤醒重试）
export async function hidApplyEffect(dev, effect, opts, log, baseFrames) {
  const isOff = effect === 0;
  const colorMode = opts.forceColorMode ?? ((opts.colorful || opts.color) ? 0x01 : 0x03);
  log && log('in', `写效果 SW#${effect} 亮度=${opts.brightness} 速度=${opts.speed} ${opts.colorful ? '炫彩' : (opts.color ? `RGB(${opts.color})` : '')}`);
  log && log('in', 'Phase1 读取配置…');
  const cfg = baseFrames ?? (await readConfig(dev, log));
  const got = !!cfg;
  if (!got) log && log('er', '读配置失败，使用出厂模板写入');
  log && log('in', 'Phase2 写配置…');
  const wr = P.buildConfigWrite(got ? cfg : null, {
    effect: isOff ? 0 : effect, // SW 槽位号（与有线 520B 配置同域同存储）
    colorMode,
    brightness: isOff ? 0 : opts.brightness,
    speed: opts.speed,
    colorful: !!opts.colorful,
    colorRgb: isOff ? null : (opts.colorful ? null : opts.color), // 自定义色 → 第9片 idx3-5
    clearColor: !isOff && !(opts.colorful || opts.color), // 无色效果清帧9残留色（花开富贵频闪根因之一）
    animMode: !!opts.anim, // 动画族效果（花开富贵）：blob[3]=02 表驱动渲染
  });
  // 顺序：配置 → 调色板（自定义色=整片灌色；无自定义色=默认彩虹表——花开富贵等
  // 无色效果读每键表，残留单色=单色频闪、零表=黑，均真机复现）→ 保存。
  log && log('in', 'Phase2 写调色板…');
  const palFrames = isOff ? P.buildPalette(null)
    : opts.anim ? P.buildPaletteAnim()
    : (!opts.colorful && opts.color) ? P.buildPalette(opts.color)
    : P.buildPaletteDefault();
  const okPal = await txBulk(dev, palFrames, '调色板', log);
  log && log('in', 'Phase3 写配置…');
  const okCfg = await txBulk(dev, wr, '配置', log);
  log && log('in', 'Phase4 保存…');
  await txRx(dev, P.buildSave(), log, 50);
  if (okCfg === 0 && okPal === 0) {
    log && log('er', '设备全程无回显——2.4G 键盘闲置休眠会如此：请按任意键唤醒键盘后重新下发');
    return false;
  }
  log && log('ok', '已下发光效');
  return true;
}

// 每键 RGB。keyColors: {ledIndex: [r,g,b]}；selfFw: 该型号自定义模式固件号
export async function hidApplyPerKey(dev, keyColors, selfFw, log) {
  log && log('in', `下发每键 RGB（${Object.keys(keyColors).length} 键，自定义模式 fw#${selfFw}）`);
  log && log('in', 'Phase1 读取配置…');
  const cfg = await readConfig(dev, log);
  log && log('in', 'Phase2 写配置（自定义模式）…');
  const wr = P.buildConfigWrite(cfg ?? null, { effect: selfFw, colorMode: 0x01 });
  await txBulk(dev, wr, '配置', log);
  log && log('in', 'Phase3 写每键颜色…');
  await txBulk(dev, P.buildPerKey(keyColors), '每键', log);
  log && log('in', 'Phase4 保存…');
  await txRx(dev, P.buildSave(), log, 50);
  log && log('ok', '每键颜色已下发');
}

export async function hidSetSleep(dev, minutes, log) {
  const idx = P.sleepIndexOf(minutes);
  log && log('in', `设置睡眠 ${minutes} 分钟（档位索引 ${idx}）`);
  const cfg = await readConfig(dev, log);
  if (!cfg) { log && log('er', '读配置失败'); return; }
  const wr = P.buildConfigWrite(cfg, { sleepIndex: idx });
  await txBulk(dev, wr, '配置', log);
  await txRx(dev, P.buildSave(), log, 50);
  log && log('ok', '睡眠时间已下发');
}

export async function hidSetDebounce(dev, level, log) {
  log && log('in', `设置按键去抖 ${level} 档`);
  const cfg = await readConfig(dev, log);
  const wr = P.buildConfigWrite(cfg ?? null, { debounce: level });
  await txBulk(dev, wr, '配置', log);
  await txRx(dev, P.buildSave(), log, 50);
  log && log('ok', '按键去抖已下发');
}

export async function hidSetTapSens(dev, level, log) {
  log && log('in', `设置 Tap 灵敏度 ${level} 档`);
  const cfg = await readConfig(dev, log);
  if (!cfg) { log && log('er', '读配置失败'); return; }
  const wr = P.buildConfigWrite(cfg, { tapSens: level });
  await txBulk(dev, wr, '配置', log);
  await txRx(dev, P.buildSave(), log, 50);
  log && log('ok', 'Tap 灵敏度已下发');
}

export async function hidFactoryReset(dev, log) {
  log && log('in', '恢复灯光出厂设置');
  const wr = P.buildConfigWrite(null, {});
  await txBulk(dev, wr, '配置', log);
  await txBulk(dev, P.buildPalette(null), '调色板', log);
  await txRx(dev, P.buildSave(), log, 50);
  log && log('ok', '已恢复出厂（灯光）');
}

// ---------- 宏与键位矩阵（逆向自 OemDrv.exe CDev3632，无线 0x13 通道）----------
// 收集一组 0x13 应答帧（按 cmd 匹配），拼出 payload 流（去掉每片 1B 标记）。
// 用于键位表读取（cmd 0x41）：请求 [13][41][01][00][(layer<<4)]，应答帧
// [13][41][总片数][seq][标记|len][数据×14]——与配置读（0x44）同构。
// 回显过滤：请求被原样回显（frame[2]=1、payload 全零），与 seq=0 的真应答同帧号，
// 以「frame[2]===1 且 payload 全零」排除（键位层 ≥29 帧，无冲突）。
export async function collectFrames13(dev, cmd, wantBytes, log, timeoutMs = 2500) {
  const got = new Map();
  let declared = 0, lastRx = Date.now();
  const h = (e) => {
    const full = new Uint8Array(e.data.buffer.byteLength + 1);
    full[0] = e.reportId;
    full.set(new Uint8Array(e.data.buffer), 1);
    lastRx = Date.now();
    if (full.length >= 20 && full[0] === P.REPORT_ID && full[1] === cmd) {
      let zeros = true;
      for (let i = 5; i < 19; i++) if (full[i] !== 0) { zeros = false; break; }
      if (full[2] === 1 && full[3] === 0 && zeros) return; // 请求回显
      const seq = full[3];
      if (!got.has(seq)) { got.set(seq, full); declared = full[2]; log && log('rx', P.hex(full)); }
    }
  };
  dev.addEventListener('inputreport', h);
  try {
    // 真机行为（0x43 实测 2026-10-12）：应答每帧 [2]=总帧数——收满即收；
    // 另加 600ms 无新帧提前退出（不必干等超时）。回显帧不影响（被上面过滤）。
    const maxFrames = Math.ceil(wantBytes / 14) + 1;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && got.size < maxFrames) {
      if (declared && (got.size >= declared || Date.now() - lastRx > 600)) break;
      await sleep(20);
    }
    const frames = [...got.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    if (!frames.length) return null;
    const out = [];
    for (const f of frames) for (let i = 1; i < 15; i++) out.push(f[4 + i]);
    return Uint8Array.from(out.slice(0, wantBytes));
  } finally { dev.removeEventListener('inputreport', h); }
}

// 读键位层（cmd 0x41）：返回 Uint8Array(byteLen)，失败 null。
// 层号进 marker 高 4 位（与写侧对称；读侧驱动帧 [2]=1 恒定——0x44 读真机同构验证）。
export async function readMatrix13(dev, layer, byteLen, log) {
  const req = P.buildFrame(P.CMD_MATRIX_R, 1, 0,
    Uint8Array.from([((layer << 4) & 0xf0), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  await dev.sendReport(req[0], req.slice(1));
  log && log('tx', P.hex(req));
  await sleep(4);
  return collectFrames13(dev, P.CMD_MATRIX_R, byteLen, log);
}

// 写键位层（cmd 0x01，tag=层号）：dword 数组 → 分片帧（驱动 SetMatrix 同构）
export async function writeMatrix13(dev, layer, dwords, log) {
  const bytes = new Uint8Array(dwords.length * 4);
  dwords.forEach((d, i) => { bytes[i * 4] = d & 0xff; bytes[i * 4 + 1] = (d >> 8) & 0xff; bytes[i * 4 + 2] = (d >> 16) & 0xff; bytes[i * 4 + 3] = (d >>> 24) & 0xff; });
  const frames = P.buildTaggedFrames(P.CMD_MATRIX_W, layer, bytes);
  let ok = 0;
  for (const f of frames) { const e = await txRx(dev, f, log); if (e) ok++; }
  log && log('in', `键位层${layer} 写入: ${ok}/${frames.length} 帧有回显`);
  return ok > 0;
}

// 下发宏（cmd 0x03）：512B 分块（块号进 marker 高 4 位），块间 100ms（驱动同款）。
// 返回 true=至少一块有回显。
export async function sendMacro13(dev, blob, log) {
  const nChunks = Math.max(1, Math.ceil(blob.length / P.MACRO_CHUNK));
  let echoAny = false;
  for (let c = 0; c < nChunks; c++) {
    const chunk = blob.subarray(c * P.MACRO_CHUNK, Math.min((c + 1) * P.MACRO_CHUNK, blob.length));
    const frames = P.buildTaggedFrames(P.CMD_MACRO_W, c, chunk);
    log && log('in', `宏块 ${c + 1}/${nChunks}（${chunk.length}B → ${frames.length} 帧）`);
    let ok = 0;
    for (const f of frames) {
      let e = null;
      // 逐帧重试 ≤2（驱动 Send13 同款逻辑 ≤5；真机实测偶发单帧回显丢失——21:44 日志 seq0）
      for (let a = 0; a < 3 && !e; a++) {
        if (a) { log && log('in', `帧 ${f[3]} 回显缺失，重试 ${a}/2`); await sleep(60); }
        e = await txRx(dev, f, log);
      }
      if (e) ok++;
    }
    if (ok) echoAny = true;
    if (c + 1 < nChunks) await sleep(100); // 驱动 WriteMacroData 的块间 Sleep(100)
  }
  return echoAny;
}

// 宏编排：① 全量宏内容（cmd 0x03）② 各层键位读改写（cmd 0x41 读 → 补丁宏键/命令键 → cmd 0x01 写）。
// macroKeysByLayer: {layer: {keyIndex: {macroId, repeat, loopCode}}}；cmdKeysByLayer: {layer: {keyIndex: hwDword}}
// 返回 {sent, assigned}；有线通道（无 0x13 输出端点）返回 {error:'wired'}。
export async function hidApplyMacros(dev, macros, macroKeysByLayer, keyCount, log, cmdKeysByLayer) {
  const { blob, count } = P.buildMacroBlob(macros);
  log && log('in', `宏打包：${count} 条 / ${blob.length}B（表 ${count * 4}B + 数据 ${blob.length - count * 4}B）`);
  log && log('tx', `blob 头 32B: ${P.hex(blob.subarray(0, 32))}`);
  const echoed = await sendMacro13(dev, blob, log);
  if (!echoed) { log && log('er', '宏内容全程无回显——键盘可能在休眠：按任意键唤醒后重试'); return { sent: false }; }
  let assigned = 0;
  const layers = new Set([...Object.keys(macroKeysByLayer ?? {}), ...Object.keys(cmdKeysByLayer ?? {})]);
  for (const layerStr of layers) {
    const layer = +layerStr;
    const mk = macroKeysByLayer?.[layerStr] ?? {};
    const ck = cmdKeysByLayer?.[layerStr] ?? {};
    if (!Object.keys(mk).length && !Object.keys(ck).length) continue;
    const byteLen = keyCount * 4;
    log && log('in', `层${layer}: 读回键位表（${keyCount} 键）…`);
    const cur = await readMatrix13(dev, layer, byteLen, log);
    if (!cur || cur.length < byteLen) {
      log && log('er', `层${layer} 键位表读取失败，跳过该层指派（宏内容已写入）`);
      continue;
    }
    const dwords = [];
    for (let i = 0; i < keyCount; i++) dwords.push((cur[i * 4] | (cur[i * 4 + 1] << 8) | (cur[i * 4 + 2] << 16) | (cur[i * 4 + 3] << 24)) >>> 0);
    for (const [kIdx, mkv] of Object.entries(mk)) {
      const mIdx = macros.findIndex((m) => m.id === mkv.macroId);
      if (mIdx < 0) continue;
      const i = +kIdx;
      if (i >= 0 && i < keyCount) { dwords[i] = P.macroKeyDword(mIdx, mkv.repeat ?? 1, mkv.loopCode ?? P.MACRO_LOOP_CODES.once); assigned++; }
    }
    let cmdN = 0;
    for (const [kIdx, hw] of Object.entries(ck)) {
      const i = +kIdx;
      if (i >= 0 && i < keyCount && Number.isInteger(hw)) { dwords[i] = hw >>> 0; cmdN++; }
    }
    log && log('in', `层${layer}: 补丁 ${Object.keys(mk).length} 宏键 + ${cmdN} 命令键后写回…`);
    await writeMatrix13(dev, layer, dwords, log);
    await sleep(50);
  }
  log && log('ok', `下发完成（宏 ${count} 条，指派 ${assigned} 键 + 命令键）——回放由键盘固件执行，无需本页保持打开`);
  return { sent: true, assigned };
}

// ---------- 有线宏与键位（CDevG5KB，逆向自 OemDrv.exe vtable 0x618A64，2026-10）----------
// 有线设备类的槽位：SetMatrix@+0x58=0x490ca0 / SetMacro@+0x60=0x490ef0 / DownloadMacro@+0x3C
// =宏打包器 0x493590 本身——与无线共用同一打包器，仅传输槽位不同。两者都汇入交换器
// 0x490a60：SetMatrix→(mode=1, cmd=3, sub=layer)、SetMacro→(mode=1, cmd=5, sub=0)，
// 数据缓冲在设备对象 +0x10（打包器写入；SetMatrix/SetMacro 形参里的 buf 只是签名一致性）。
// 交换器帧格式与 buildFeat520Frame 同构：[6][cmd][sub][00][总块数][seq][lenLo][lenHi][data…]，
// 按 512B 分块、seq 递增、重试 3 次、块间 ~70ms——webdrv feat520Exchange 的 flags 参数
// 即驱动帧[4]=总块数（单块读写=1 时与现有读侧调用恰好重合）。
// 读侧（真机已验证）：键位层 cmd 83 sub=layer（DWORD 键码，真机首测 83/0 返回键位表）；
// 宏读 cmd 85（真机扫描时为空 = 当时未存宏，bit-7 规则 85↔05 与写侧自洽）。
// 注意：与灯光一样无已知保存命令——写入即时生效，断电后是否保留未证实。

// 读键位层（有线）：cmd 83 sub=layer。≤512B 单块；>512B 需 seq 递增，但真机教训
// 「读命令 seq≠0 可能返回全零假数据」→ 调用方对 >512B 的读回结果只应信任首块。
export async function readMatrixWired(dev, layer, byteLen, log) {
  const nChunks = Math.max(1, Math.ceil(byteLen / 0x200));
  const out = new Uint8Array(byteLen);
  let got = 0;
  for (let i = 0; i < nChunks; i++) {
    const want = Math.min(0x200, byteLen - i * 0x200);
    const resp = await feat520Exchange(dev, 0x83, layer, i, want, null, log, 6, nChunks);
    const data = resp.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + want);
    if (data.length < want) { log && log('er', `有线键位层${layer} 读响应不足（${data.length}/${want}B）`); return i === 0 ? null : out; }
    out.set(data, i * 0x200);
    got += want;
  }
  return got === byteLen ? out : out.subarray(0, got);
}

// 写键位层（有线）：cmd 03。变体①=驱动原生（sub=layer、帧[4]=块数、len=byteLen）；
// 变体②=灯光写真机验证过的 d4/400/40 风格（sub=0xd4、len=0x400、flags=0x40）。
// 写后 83/layer 读回校验补丁键，命中即缓存变体（模块级）。
let wiredMatrixVariant = null;
export async function writeMatrixWired(dev, layer, dwords, log) {
  const byteLen = dwords.length * 4;
  const bytes = new Uint8Array(byteLen);
  dwords.forEach((d, i) => { bytes[i * 4] = d & 0xff; bytes[i * 4 + 1] = (d >> 8) & 0xff; bytes[i * 4 + 2] = (d >> 16) & 0xff; bytes[i * 4 + 3] = (d >>> 24) & 0xff; });
  const nChunks = Math.max(1, Math.ceil(byteLen / 0x200));
  const mkVariants = () => [
    { label: `驱动原生 sub=layer 块数=${nChunks}`, run: async () => {
      for (let i = 0; i < nChunks; i++) {
        const chunk = bytes.subarray(i * 0x200, Math.min((i + 1) * 0x200, byteLen));
        await feat520Exchange(dev, 0x03, layer, i, chunk.length, chunk, log, 6, nChunks);
        if (i + 1 < nChunks) await sleep(70);
      }
    } },
    { label: 'd4/400/40（灯光写同款）', run: async () => {
      const payload = new Uint8Array(0x400);
      payload.set(bytes.subarray(0, Math.min(0x200, byteLen)));
      await feat520Exchange(dev, 0x03, 0xd4, 0, 0x400, payload, log, 6, 0x40);
    } },
  ];
  const variants = wiredMatrixVariant ? [wiredMatrixVariant] : mkVariants();
  for (const v of variants) {
    log && log('in', `[有线] 写键位层${layer}（${v.label}）…`);
    try { await v.run(); } catch (e) { log && log('er', `[有线] 变体发送失败（${v.label}）: ${e.message}`); continue; }
    await sleep(50);
    // 读回校验：全部键位要与目标一致（404B 单块，无 seq≠0 假零风险）
    const back = await readMatrixWired(dev, layer, byteLen, log);
    if (!back) continue;
    let hit = 0, miss = 0;
    for (let i = 0; i < dwords.length; i++) {
      const now = (back[i * 4] | (back[i * 4 + 1] << 8) | (back[i * 4 + 2] << 16) | (back[i * 4 + 3] << 24)) >>> 0;
      if (now === (dwords[i] >>> 0)) hit++; else miss++;
    }
    log && log('in', `[有线] 键位层${layer} 读回校验：${hit} 键一致 / ${miss} 键不一致`);
    if (hit > 0 && miss === 0) {
      wiredMatrixVariant = v;
      log && log('ok', `[有线] 键位层${layer} 写入并读回验证通过`);
      return true;
    }
  }
  log && log('er', `[有线] 键位层${layer} 写入变体均未通过读回校验——请用调试台对照原驱动抓包`);
  return false;
}

// 写宏内容（有线）：cmd 05 sub=0，blob 按 512B 分块（帧[4]=总块数，驱动块间 ~70ms）。
// 写后 cmd 85 读回校验首块（blob>512B 时读侧 seq≠0 有假零风险，仅信任首块）。
// 85 读从未在真机证实过内容语义（扫描时为空）——校验不过只记警告不算失败。
let wiredMacroVariant = null;
export async function sendMacroWired(dev, blob, log) {
  const nChunks = Math.max(1, Math.ceil(blob.length / 0x200));
  const mkVariants = () => {
    const list = [{ label: `驱动原生 sub=0 块数=${nChunks}`, run: async () => {
      for (let i = 0; i < nChunks; i++) {
        const chunk = blob.subarray(i * 0x200, Math.min((i + 1) * 0x200, blob.length));
        await feat520Exchange(dev, 0x05, 0, i, chunk.length, chunk, log, 6, nChunks);
        if (i + 1 < nChunks) await sleep(70);
      }
    } }];
    if (blob.length <= 0x200) list.push({ label: 'd4/400/40（灯光写同款）', run: async () => {
      const payload = new Uint8Array(0x400);
      payload.set(blob);
      await feat520Exchange(dev, 0x05, 0xd4, 0, 0x400, payload, log, 6, 0x40);
    } });
    return list;
  };
  const variants = wiredMacroVariant ? [wiredMacroVariant] : mkVariants();
  for (const v of variants) {
    log && log('in', `[有线] 写宏内容 ${blob.length}B / ${nChunks} 块（${v.label}）…`);
    try { await v.run(); } catch (e) { log && log('er', `[有线] 宏变体发送失败（${v.label}）: ${e.message}`); continue; }
    await sleep(50);
    // 读回校验（首块）
    const want = Math.min(blob.length, 0x200);
    try {
      const chk = await feat520Exchange(dev, 0x85, 0, 0, want, null, log);
      const got = chk.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + want);
      if (got.length >= want) {
        let diff = 0;
        for (let i = 0; i < want; i++) if (got[i] !== blob[i]) diff++;
        log && log(diff === 0 ? 'ok' : 'in', `[有线] 宏读回（cmd 85）首块比对：${diff === 0 ? '逐字节一致 ✓' : `${diff} 字节不一致（85 读语义未经真机证实，不据此判失败）`}`);
        if (diff === 0) { wiredMacroVariant = v; return 'verified'; }
      } else {
        log && log('in', '[有线] 宏读回（cmd 85）响应不足，无法校验（写入可能已生效）');
      }
    } catch (e) { log && log('in', `[有线] 宏读回失败（${e.message}）——写入可能已生效，按指派键实测判断`); }
    wiredMacroVariant = v;
    return 'sent'; // 发送成功但读回未证实
  }
  return 'failed';
}

// 原驱动宏打包缓冲硬上限（keyinfo 打包器 cmp $0x2800 + "MacroBufferSize > sizeof(bMacro)"）。
// 固件真实容量不可观测（真机定论 2026-10-12：0x43/85 读回均为 0x13 收发暂存镜像，
// 宏存储无读回通道；驱动 hwParam 容量为内置静态值）——下发前按此上限拦截。
export const MACRO_DRIVER_LIMIT = 0x2800; // 10240B

// 有线宏编排：① 宏内容（cmd 05 分块）② 各层键位读改写（cmd 83 读 → 补丁宏键/命令键 → cmd 03 写）。
// 返回 { sent, assigned, macroState }；macroState: 'skipped'|'verified'|'sent'|'failed'。
export async function hidApplyMacrosWired(dev, macros, macroKeysByLayer, cmdKeysByLayer, keyCount, log) {
  let macroState = 'skipped';
  if (macros.length) {
    const { blob, count } = P.buildMacroBlob(macros);
    log && log('in', `[有线] 宏打包：${count} 条 / ${blob.length}B`);
    log && log('tx', `blob 头 32B: ${P.hex(blob.subarray(0, 32))}`);
    macroState = await sendMacroWired(dev, blob, log);
  }
  let assigned = 0;
  const layers = new Set([...Object.keys(macroKeysByLayer ?? {}), ...Object.keys(cmdKeysByLayer ?? {})]);
  for (const layerStr of layers) {
    const layer = +layerStr;
    const mk = macroKeysByLayer?.[layerStr] ?? {};
    const ck = cmdKeysByLayer?.[layerStr] ?? {};
    if (!Object.keys(mk).length && !Object.keys(ck).length) continue;
    const byteLen = keyCount * 4;
    log && log('in', `[有线] 层${layer}: 读键位表（cmd 83，${keyCount} 键）…`);
    const cur = await readMatrixWired(dev, layer, byteLen, log);
    if (!cur || cur.length < byteLen) { log && log('er', `[有线] 层${layer} 键位表读取失败，跳过该层指派`); continue; }
    const dwords = [];
    for (let i = 0; i < keyCount; i++) dwords.push((cur[i * 4] | (cur[i * 4 + 1] << 8) | (cur[i * 4 + 2] << 16) | (cur[i * 4 + 3] << 24)) >>> 0);
    for (const [kIdx, mkv] of Object.entries(mk)) {
      const mIdx = macros.findIndex((m) => m.id === mkv.macroId);
      if (mIdx < 0) continue;
      const i = +kIdx;
      if (i >= 0 && i < keyCount) { dwords[i] = P.macroKeyDword(mIdx, mkv.repeat ?? 1, mkv.loopCode ?? P.MACRO_LOOP_CODES.once); assigned++; }
    }
    for (const [kIdx, hw] of Object.entries(ck)) {
      const i = +kIdx;
      if (i >= 0 && i < keyCount && Number.isInteger(hw)) { dwords[i] = hw >>> 0; assigned++; }
    }
    const ok = await writeMatrixWired(dev, layer, dwords, log);
    if (!ok) log && log('warn', `[有线] 层${layer} 键位写未通过校验（指派可能未生效）`);
    await sleep(50);
  }
  const stateTxt = { skipped: '无宏内容', verified: '宏内容读回验证 ✓', sent: '宏内容已发送（读回未证实）', failed: '宏内容写入失败' }[macroState];
  log && log(assigned > 0 || macroState === 'verified' ? 'ok' : 'warn',
    `[有线] 完成：${stateTxt}，键位指派 ${assigned} 键（无已知保存命令，断电后是否保留未证实）`);
  return { sent: assigned > 0 || macroState === 'verified', assigned, macroState };
}
// 电量查询（0x4A，仅无线通道）。响应 [0x13][0x4A][npkg][idx][oper|len=0x02][百分比][状态标志]…
// 请求写入会先回一帧 echo（payload 全 0），以 byte[4]>0 或 byte[5]/byte[6]≠0 区分真实响应；
// 键盘 2.4G 闲置快睡后通常无响应（需按键唤醒）→ 超时返回 null。
export async function hidReadBattery(dev, log) {
  const req = P.buildFrame(P.CMD_BATTERY, 1, 0, new Uint8Array(15));
  await dev.sendReport(req[0], req.slice(1));
  log && log('tx', P.hex(req));
  for (let i = 0; i < 4; i++) {
    const r = await readReport(dev, 300);
    if (!r) break;
    log && log('rx', P.hex(r));
    if (r[0] === P.REPORT_ID && (r[1] & 0x7f) === P.CMD_BATTERY && (r[4] > 0 || r[5] !== 0 || r[6] !== 0)) {
      log && log('ok', `电量 ${r[5]}%（状态字节 0x${r[6].toString(16)}）`);
      return { percent: r[5], flags: r[6] };
    }
  }
  log && log('er', '电量查询无响应（键盘可能已休眠，按键唤醒后重试）');
  return null;
}

// 型号识别：GetPSD——按接口能力**直奔最可能的路径**（真机已验证各代硬件的专属通道），
// 未命中再走兼容兜底，全部只读。路径与格式详见 protocol.js 注释：
//   A. 有 out[13] → 0x13 协议 cmd 07/05（2.4G 接收器 / 命令接口，毫秒级）
//   B. 有 feat[6] → 520 字节 feature 帧（有线键盘，毫秒级）
//   C. 兜底：feature 5 / output 5 / 3632 TLV / 520B report 9（旧固件与其他代际）
// 返回 { psd, reason, blob }：psd 为 6 字节 PSD 或 null；blob 为带回的应答块
//（由调用方对 blob 滑窗匹配型号表）。
export async function readPsd(dev, log) {
  let last = null;
  // A. 0x13 协议（接收器）；探测无应答即快速失败（~0.5s），不拖后续路径
  if (hasOutputReport(dev, P.REPORT_ID)) {
    const via13 = await psdVia13(dev, log);
    if (via13.psd) return via13;
    last = via13;
  }
  // B. 520 字节 feature 帧（有线键盘主通道）
  if (hasFeatureReport(dev, 6)) {
    const via520b = await psdVia520(dev, log);
    if (via520b.psd) return via520b;
    if (via520b.blob) return via520b;
    last = last ?? via520b;
  }
  // C. 兼容兜底（依次，均快速失败）
  const viaFeature = await psdViaFeature(dev, log);
  if (viaFeature.psd) return viaFeature;
  last = last ?? viaFeature;
  if (viaFeature.reason === 'send-failed') {
    const viaOutput = await psdViaOutput(dev, log);
    if (viaOutput.psd) return viaOutput;
    last = viaOutput.reason === 'send-failed' ? last : viaOutput;
  }
  const via3632 = await psdViaFeat6(dev, log);
  if (via3632.psd) return via3632;
  if (via3632.blob) return via3632;
  const via520 = await psdViaFeat9(dev, log);
  if (via520.psd) return via520;
  return last ?? via520;
}

// 主路径：feature report。SetFeature(5, [05 81 00…00]) → GetFeature(5) 读回 [05][01][PSD×6]。
// GetFeature 返回的 DataView 首字节为 report ID（与 HidD_GetFeature 缓冲一致）；
// 兼容个别实现不带 ID 的情况。发送 ×3；读取 GET_REPORT 若被固件 STALL（真机有线即如此）
// 连续两次即放弃，不再空耗重试。
async function psdViaFeature(dev, log) {
  const req = Uint8Array.from(P.PSD_REQUEST);
  await sleep(30); // 原驱动打开句柄后先 Sleep 再查询
  let sent = false;
  for (let a = 0; a < 3 && !sent; a++) {
    try {
      await dev.sendFeatureReport(P.PSD_REPORT_ID, req);
      sent = true;
      log && log('tx', `F05 ${P.hex(req)}`);
    } catch (e) {
      if (a === 2) { log && log('er', `GetPSD SetFeature 失败（接口无 feature report 5）: ${e.message}`); return { psd: null, reason: 'send-failed' }; }
      await sleep(120);
    }
  }
  let stalls = 0;
  for (let a = 0; a < 3; a++) {
    try {
      const dv = await dev.receiveFeatureReport(P.PSD_REPORT_ID);
      const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      log && log('rx', `F05 ${P.hex(b)}`);
      if (b[0] === P.PSD_REPORT_ID && b[1] === 0x01 && b.length >= 8) {
        const psd = b.slice(2, 8);
        log && log('ok', `GetPSD = ${P.hex(psd)}`);
        return { psd, reason: 'ok' };
      }
      if (b[0] === 0x01 && b.length >= 7) { // 兼容不带 report ID 的返回
        const psd = b.slice(1, 7);
        log && log('ok', `GetPSD（无 ID 格式）= ${P.hex(psd)}`);
        return { psd, reason: 'ok-alt' };
      }
    } catch (e) {
      stalls++;
      log && log('er', `GetPSD GetFeature 失败: ${e.message}`);
      if (stalls >= 2) { log && log('in', 'GetFeature(5) 连续被拒（STALL），放弃该路径'); break; }
    }
    // 真机实测（有线）：SetFeature 成功但设备拒绝 GET_REPORT(feature 5)——
    // 这类固件可能把应答推到 input report 上，监听一小段兜底
    const r = await readReport(dev, 80);
    if (r) {
      log && log('rx', P.hex(r));
      if (r[1] === 0x01 && r.length >= 8) return { psd: r.slice(2, 8), reason: 'ok' };
      if (r[1] === 0x0a && r.length >= 8) return { psd: r.slice(2, 8), reason: 'ok' };
      if (r[0] === 0x0a && r.length >= 7) return { psd: r.slice(1, 7), reason: 'ok-alt' };
    }
    await sleep(100);
  }
  log && log('er', 'GetPSD（feature）无有效应答');
  return { psd: null, reason: 'timeout' };
}

// 兜底路径：output report（0x13 协议风格的收发；仅在 feature 路径被拒时尝试）。
// - 请求可能被设备按 0x13 协议习惯回一帧 echo（payload 05 81 …），跳过后继续等；
// - 主解析：payload = [01][PSD×6]；备选解析：report ID 0x01 直接带 [PSD×6]。
async function psdViaOutput(dev, log) {
  const req = Uint8Array.from(P.PSD_REQUEST);
  await sleep(30);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await dev.sendReport(P.PSD_REPORT_ID, req);
      log && log('tx', `${P.PSD_REPORT_ID.toString(16).padStart(2, '0')} ${P.hex(req)}`);
    } catch (e) {
      log && log('er', `GetPSD 发送失败（该接口不认识 report 5）: ${e.message}`);
      return { psd: null, reason: 'send-failed' };
    }
    for (let i = 0; i < 5; i++) {
      const r = await readReport(dev, 260);
      if (!r) break;
      log && log('rx', P.hex(r));
      if (r[0] === P.PSD_REPORT_ID && r[1] === 0x05 && r[2] === 0x81) continue; // 请求 echo
      if (r[0] === P.REPORT_ID) continue;                                       // 0x13 协议帧
      if (r[1] === 0x01 && r.length >= 8) {
        const psd = r.slice(2, 8);
        log && log('ok', `GetPSD = ${P.hex(psd)}`);
        return { psd, reason: 'ok' };
      }
      if (r[0] === 0x01 && r.length >= 7) { // 备选格式：report 1 直接带 PSD
        const psd = r.slice(1, 7);
        log && log('ok', `GetPSD（备选格式）= ${P.hex(psd)}`);
        return { psd, reason: 'ok-alt' };
      }
    }
    await sleep(150);
  }
  log && log('er', 'GetPSD（output）无有效应答');
  return { psd: null, reason: 'timeout' };
}

// 兜底路径 2：0x13 协议识别（2.4G 接收器仅声明 out[13]/in[13,5]，无 report 5）。
// 逆向自 OemDrv.exe Watcher_Thread_3632：先发 [13][07][01][seq][0…] 探测（原驱动校验
// 应答 payload[0]==0x0A 等，此处仅记录不硬校验），间隔约 200ms 后发 [13][05][01][seq][0…]
// 查询 PSD；应答预期 [01][PSD×6]（与 feature 路径同格式），也可能直接走 input report 5。
async function psdVia13(dev, log) {
  if (!hasOutputReport(dev, P.REPORT_ID)) {
    log && log('er', 'GetPSD(0x13)：该接口无 output report 13');
    return { psd: null, reason: 'send-failed' };
  }
  await sleep(30);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const probe = P.buildFrame(0x07, 0x01, attempt, new Uint8Array(15)); // [13][07][01][seq][0…]
      await dev.sendReport(probe[0], probe.slice(1));
      log && log('tx', `${P.hex(probe)} (cmd07 探测)`);
    } catch (e) {
      log && log('er', `GetPSD(0x13) cmd07 发送失败: ${e.message}`);
      return { psd: null, reason: 'send-failed' };
    }
    let seen = 0;
    for (let i = 0; i < 3; i++) { // 探测的 echo 与应答全部读掉并记录
      const r = await readReport(dev, 120);
      if (!r) break;
      seen++;
      log && log('rx', P.hex(r));
    }
    if (!seen && attempt === 0) { // 探测完全无应答：设备不 Speak 0x13，快速放弃
      log && log('in', 'GetPSD(0x13)：探测无应答，跳过该路径');
      return { psd: null, reason: 'timeout' };
    }
    await sleep(150); // 原驱动 Sleep(200)+Sleep(20)，实测可压缩
    try {
      const q = P.buildFrame(0x05, 0x01, attempt, new Uint8Array(15));     // [13][05][01][seq][0…]
      await dev.sendReport(q[0], q.slice(1));
      log && log('tx', `${P.hex(q)} (cmd05 GetPSD)`);
    } catch (e) {
      log && log('er', `GetPSD(0x13) cmd05 发送失败: ${e.message}`);
      return { psd: null, reason: 'send-failed' };
    }
    for (let i = 0; i < 5; i++) {
      const r = await readReport(dev, 200);
      if (!r) break;
      log && log('rx', P.hex(r));
      // 注意：应答帧与 echo 同头 [13][05][01]，须先判应答再跳 echo（echo payload 全 0）。
      // 真机实测（2.4G 接收器）应答 payload = [0A][PSD×6][01]…（0x0A 为标记，对应原驱动
      // Watcher_3632 校验的 0x0A / 01 两个字节）；保留 [01][PSD×6] 变体兼容。
      if (r[0] === P.REPORT_ID && (r[1] & 0x7f) === 0x05 && r[4] === 0x0a && r.length >= 11) {
        const psd = r.slice(5, 11); // [13][05][01][seq][0A][PSD×6][01]…
        log && log('ok', `GetPSD(0x13) = ${P.hex(psd)}`);
        return { psd, reason: 'ok' };
      }
      if (r[0] === P.REPORT_ID && (r[1] & 0x7f) === 0x05 && r[4] === 0x01 && r.length >= 11) {
        const psd = r.slice(5, 11); // [13][05][01][seq][01][PSD×6]…（变体）
        log && log('ok', `GetPSD(0x13) = ${P.hex(psd)}`);
        return { psd, reason: 'ok' };
      }
      if (r[0] === P.REPORT_ID && (r[1] === 0x07 || r[1] === 0x05) && r[2] === 0x01) continue; // echo / 探测应答
      if (r[0] === P.PSD_REPORT_ID && r[1] === 0x01 && r.length >= 8) { // input report 5: [01][PSD×6]
        const psd = r.slice(2, 8);
        log && log('ok', `GetPSD(in5) = ${P.hex(psd)}`);
        return { psd, reason: 'ok' };
      }
      if (r[0] === P.PSD_REPORT_ID && r.length >= 7) { // input report 5 直接带 PSD
        const psd = r.slice(1, 7);
        log && log('ok', `GetPSD(in5 裸格式) = ${P.hex(psd)}`);
        return { psd, reason: 'ok-alt' };
      }
    }
    await sleep(150);
  }
  log && log('er', 'GetPSD(0x13) 无有效应答');
  return { psd: null, reason: 'timeout' };
}

// 路径 ④（有线 3632 类）：feature 5 发 6 字节读命令 → feature 6 读应答。
// 逆向自 OemDrv.exe 的 3632 协议族：读类命令 [83 B6]=读配置 / [88 B8]=读数据块
//（写类 [03 B6]/[08 B8] 一律不发），交换模式 SetFeature(5,[cmd,sub,00×4],6) →
// Sleep → GetFeature(6, 0x407)。真机（有线 Hi98 3-Mode）实测：
// - feature 5 的 SET 与 feature 6 的 GET 均可用（分属同一 USB 接口上的两个 vendor collection）；
// - GetFeature(5) 被固件 STALL，故 GetPassword(05 81) 的应答也极可能走 report 6；
// - 应答为 TLV：[05][命令回显][lenLE][data×len]——data 长度 6 = PSD 尺寸（真机见过
//   6 字节宽字符片段 / 常量 ef 24 05 f5 82 e4，内容随设备状态变化）。
// TLV 数据作为候选 PSD 返回（上层对型号表校验，匹配不上无副作用）；
// 更长的应答整块带回由 connect.js 滑窗匹配。
async function psdViaFeat6(dev, log) {
  if (!hasFeatureReport(dev, 6)) return { psd: null, reason: 'send-failed', blob: null };
  const cmds = [
    [0x83, 0xb6], // 读配置
    [0x88, 0xb8], // 读数据块
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const [c, s] of cmds) {
      try {
        await dev.sendFeatureReport(5, Uint8Array.of(c, s, 0, 0, 0, 0));
        log && log('tx', `F05 ${c.toString(16).padStart(2, '0')} ${s.toString(16).padStart(2, '0')} 00 00 00 00 (3632 读命令)`);
      } catch (e) {
        log && log('er', `GetPSD(3632) SetFeature(5) 失败: ${e.message}`);
        return { psd: null, reason: 'send-failed', blob: null };
      }
      await sleep(100);
      try {
        const dv = await dev.receiveFeatureReport(6);
        const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        log && log('rx', `F06 ${P.hex(b.slice(0, 32))}${b.length > 32 ? ' …' : ''}`);
        // TLV 解析：[05][cmd×2][…][lenLE][data]——data 恰为 6 字节且形如 KB.ini 的 PSD
        //（9 型号 PSD 均为 03 00 00 00 xx yy）才作为候选返回，其余（如常量 ef 24…）继续尝试
        for (let off = 4; off + 8 <= Math.min(b.length, 24); off++) {
          const len = b[off] | (b[off + 1] << 8);
          if (len === 6 && b[off + 2] !== undefined) {
            const cand = b.slice(off + 2, off + 8);
            if (cand[0] === 0x03 && cand[1] === 0 && cand[2] === 0 && cand[3] === 0 && (cand[4] !== 0 || cand[5] !== 0)) {
              log && log('ok', `GetPSD(3632) TLV@${off} = ${P.hex(cand)}`);
              return { psd: cand, reason: 'ok', blob: null };
            }
          }
        }
        // 长应答（≥16B 且含非零）：整块带回滑窗匹配
        const nz = b.findIndex((x) => x !== 0);
        if (b.length >= 16 && nz >= 0) {
          log && log('in', `GetPSD(3632) 应答 ${b.length} 字节（首个非零@${nz}），转滑窗匹配`);
          return { psd: null, reason: 'timeout', blob: b.slice(0, 256) };
        }
      } catch (e) {
        log && log('er', `GetPSD(3632) GetFeature(6) 失败: ${e.message}`);
      }
      await sleep(80);
    }
  }
  return { psd: null, reason: 'timeout', blob: null };
}

// 路径 ⑥（有线 520 字节 feature 帧，识别主通道）：逆向自 OemDrv.exe 0x491AD0
//（其 FindHIDDevice 以 CreateFileW 打开设备后，与 KB.ini Psd 逐字节比对，即
//  "Psd unmatch: gVar.nPsd" 的第二处调用者）。交换：
//   SetFeature(report R, 520B: [R][82][01][00][01][seq][lenLo][lenHi][0…]) →
//   GetFeature(report R, 520B) → 应答 buf+8 处为 PSD×6（len=6 单块即整份）。
// R 由固件字段选择：cfg 字段==0x18（KB.ini Fw=24）用 6，否则用 9 —— 两种都试。
// 无校验和（与 0x8805 类不同）。真机键盘 feat[6] 在 Chrome 可见接口上存在 → 网页端可走。
async function psdVia520(dev, log) {
  for (const rid of [6, 9]) {
    if (!hasFeatureReport(dev, rid)) continue;
    for (let seq = 0; seq < 2; seq++) {
      const frame = new Uint8Array(520);
      frame[0] = rid; frame[1] = 0x82; frame[2] = 0x01; frame[3] = 0x00; frame[4] = 0x01;
      frame[5] = seq; frame[6] = 6; frame[7] = 0;
      try {
        await dev.sendFeatureReport(rid, frame.slice(1));
        log && log('tx', `F${rid} 520B GetPSD 帧 [${rid.toString(16)} 82 01 00 01 ${seq} 06 00 …]`);
      } catch (e) {
        log && log('er', `GetPSD(520B) F${rid} 发送失败: ${e.message}`);
        break; // 该 report 发不了 → 换下一个 rid
      }
      await sleep(50);
      try {
        const dv = await dev.receiveFeatureReport(rid);
        const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        log && log('rx', `F${rid} ${P.hex(b.slice(0, 24))}${b.length > 24 ? ' …' : ''}`);
        // PSD = Windows 应答 buf+8 → Chrome data+7；宽容按形状扫描（9 型号均为 03 00 00 00 xx yy）
        for (let off = 0; off + 6 <= Math.min(b.length, 24); off++) {
          if (b[off] === 0x03 && b[off + 1] === 0 && b[off + 2] === 0 && b[off + 3] === 0 && (b[off + 4] !== 0 || b[off + 5] !== 0)) {
            const psd = b.slice(off, off + 6);
            log && log('ok', `GetPSD(520B) = ${P.hex(psd)}`);
            return { psd, reason: 'ok', blob: null };
          }
        }
        // 非 PSD 形状但内容非全零 → 带回 blob 交上层滑窗
        const nz = b.findIndex((x) => x !== 0);
        if (b.length >= 8 && nz >= 0 && nz < 24) {
          log && log('in', `GetPSD(520B) 应答 ${b.length}B（非零@${nz}），转滑窗`);
          return { psd: null, reason: 'timeout', blob: b.slice(0, 256) };
        }
      } catch (e) {
        log && log('er', `GetPSD(520B) F${rid} GetFeature 失败: ${e.message}`);
      }
      await sleep(80);
    }
  }
  return { psd: null, reason: 'timeout', blob: null };
}

// 路径 ⑤（有线 520 字节 feature 9 协议）：逆向自 OemDrv.exe 的 0x8805 设备类
//（watcher 借键盘的鼠标 collection 发现设备；命令经 SetFeature(report 9) 下发）。
// 帧格式（520 字节 = 1 id + 519 数据）：[09][ck][cmd][sub][01][00][lenLo][lenHi][0…]
// ck = 字节 2..519 累加和；探测帧 cmd=07 sub=00 len=0x0200，GetPSD 帧 cmd=05 sub=01 len=6；
// 应答走中断 IN（input report），探测应答校验 [..][0A][02][01]。
// 注意：report 9 声明在被 Chrome 隐藏的 collection 上——sendFeatureReport(9) 是否放行
// 属平台行为，本路径即为实证（被拒则有线识别在浏览器端不可达，见 README）。
async function psdViaFeat9(dev, log) {
  const build = (cmd, sub, len) => {
    const f = new Uint8Array(520);
    f[0] = 0x09; f[2] = cmd; f[3] = sub; f[4] = 0x01;
    f[6] = len & 0xff; f[7] = (len >> 8) & 0xff;
    let ck = 0;
    for (let i = 2; i < 520; i++) ck += f[i];
    f[1] = ck & 0xff;
    return f;
  };
  // Chrome 对隐藏 collection 的 feature 报告可能直接拒绝——先探测能否发送
  try {
    await dev.sendFeatureReport(0x09, build(0x07, 0x00, 0x0200).slice(1));
    log && log('tx', 'F09 (520B 探测帧 cmd07) …');
  } catch (e) {
    log && log('er', `GetPSD(520B) 发送被拒（report 9 不可用）: ${e.message}`);
    return { psd: null, reason: 'send-failed', blob: null };
  }
  // 探测应答（中断 IN，校验 [..][0A][02][01]）
  for (let i = 0; i < 4; i++) {
    const r = await readReport(dev, 200);
    if (!r) break;
    log && log('rx', `${P.hex(r.slice(0, 24))} (input)`);
  }
  await sleep(220);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await dev.sendFeatureReport(0x09, build(0x05, 0x01, 6).slice(1));
      log && log('tx', 'F09 (520B GetPSD 帧 cmd05) …');
    } catch (e) {
      log && log('er', `GetPSD(520B) 发送失败: ${e.message}`);
      return { psd: null, reason: 'send-failed', blob: null };
    }
    for (let i = 0; i < 6; i++) {
      const r = await readReport(dev, 260);
      if (!r) break;
      log && log('rx', `${P.hex(r.slice(0, 24))} (input)`);
      // 应答解析（宽容）：[01]/[0A] 标记 + PSD×6，或 PSD 形状直配（03 00 00 00 xx yy）
      for (let off = 0; off + 7 <= Math.min(r.length, 24); off++) {
        if ((r[off] === 0x01 || r[off] === 0x0a) && r[off + 1] === 0x03 && r[off + 2] === 0 && r[off + 5] !== 0) {
          const psd = r.slice(off + 1, off + 7);
          log && log('ok', `GetPSD(520B) = ${P.hex(psd)}`);
          return { psd, reason: 'ok', blob: null };
        }
      }
    }
    await sleep(150);
  }
  return { psd: null, reason: 'timeout', blob: null };
}

// ---------- 520B feature 帧协议（有线键盘；格式见 protocol.js）----------
// 交换原语：发送帧 → 读应答 → 返回完整应答（数据在偏移 8）。真机已验证（GetPSD）。
// receiveFeatureReport 本身阻塞到设备应答；sleep 只是给固件的处理留余量——真机日志
// 显示多次交换在同一秒内完成，20ms 足够（旧值 80ms，一次完整下发 6 交换能省 ~0.4s）。
export async function feat520Exchange(dev, cmd, sub, seq, dataLen, payload, log, rid = 6, flags = 0x01) {
  const frame = P.buildFeat520Frame(rid, cmd, sub, seq, dataLen, payload, flags);
  await dev.sendFeatureReport(rid, frame.slice(1));
  log && log('tx', `F${rid} 520B [${rid.toString(16)} ${cmd.toString(16).padStart(2, '0')} ${sub.toString(16).padStart(2, '0')} 00 ${flags.toString(16).padStart(2, '0')} ${seq} ${dataLen.toString(16)} …]`);
  await sleep(20);
  const dv = await dev.receiveFeatureReport(rid);
  const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  log && log('rx', `F${rid} ${P.hex(b.slice(0, 24))}${b.length > 24 ? ' …' : ''}`);
  return b;
}

// 有线读配置探测（只读）：全命令×sub 扫描读 400 字节（SyncCfg 的 0x190），
// 记录所有非空应答（真机首测：83/0 返回 DWORD 键位表 `00 00 00 29 | 00 00 00 35…`，
// 灯光配置在其它组合）。返回 { blob, cmd, sub, all }：blob 为灯光配置签名命中的数据，
// all 为全部命中清单（供逆向映射）。0x13 配置签名：首字节 0e 且第 3/4 字节 03 03（效果/色彩模式）。
export async function hidReadConfigWired(dev, log) {
  const cmds = [0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x8a];
  const all = [];
  let best = null;
  outer:
  for (const cmd of cmds) {
    for (const sub of [0, 1, 2]) {
      let resp;
      try { resp = await feat520Exchange(dev, cmd, sub, 0, 0x190, null, log); }
      catch (e) { log && log('er', `读配置 0x${cmd.toString(16)}/${sub} 失败: ${e.message}`); continue; }
      if (resp.length < 16) continue; // 状态残留（如 1B 06）
      const blob = resp.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 0x190);
      const nz = blob.findIndex((x) => x !== 0);
      if (nz < 0 || nz >= 64) continue;
      const head = blob.slice(0, 16);
      const looksCfg = head[0] === 0x0e && head[2] === 0x03 && head[3] === 0x03;
      all.push({ cmd, sub, len: resp.length, head: [...head], looksCfg });
      log && log('in', `有线读配置命中 0x${cmd.toString(16)}/${sub}：${resp.length}B，数据@8 首 16B = ${P.hex(head)}${looksCfg ? ' ★疑似灯光配置' : ''}`);
      if (looksCfg) { best = { blob, cmd, sub }; break outer; }
    }
  }
  if (!best && all.length) {
    // 无签名命中：返回数据量最大的一个作代表（真机映射用）
    const top = all.sort((a, b) => b.len - a.len)[0];
    log && log('in', `未发现灯光配置签名；以 0x${top.cmd.toString(16)}/${top.sub}（最大应答）为代表`);
    best = { blob: null, cmd: top.cmd, sub: top.sub };
  }
  if (!all.length) log && log('er', '有线读配置：所有候选命令均无有效应答');
  return best ? { ...best, all } : null;
}

// 有线写色（v4，2026-10-12 真机校准）：调色板 = cmd 86 仓库（512B 全量，自定义色在深层槽位），
// 写侧与配置写 84→04 同构：cmd 06 feat520 写 + 86 读回校验。
// 槽位校准方法：无线模式设纯绿（00 ff 00，链路已验证）→ 有线读 cmd 86 全 512B 差分
// → 绿色出现在 8 个 RGB 三元组槽位 + 4 个青色伴随位（固件把自定义色分发到各效果组）。
// 历史教训（全真机证伪）：①配置帧9 blob[128..130] 死区；②report 5 [03 B6] 大帧 Chrome 发不进；
// ③wcmd 09 隧道帧被回显处理（灯闪）但不写本仓库（41 发前后逐字节一致）→ 显示固件默认红色。
const WIRED_RGB_SLOTS = [21, 24]; // cmd 8a 表自定义色三元组（SetLedRgbTab 模板 +0x15 起两槽，真机绿校准）
let wiredPaletteVariant = null; // 命中的写变体
// rgb=null → 默认彩虹表（无自定义色效果：花开富贵等读每键表，残留单色=单色频闪）
export async function hidSetColorWired(dev, rgb, log, anim = false) {
  const isDefault = !rgb;
  log && log('in', `[有线] 写色${isDefault ? '（默认彩虹表）' : ` RGB(${rgb.join(',')})`}: 读 LED RGB 表（cmd 8a，512B）…`);
  // Phase1：读 cmd 8a 表（布局：[0..15] 头 + [21..23]/[24..26] 自定义色 + … + [506..507]=5a a5）
  const rd = await feat520Exchange(dev, 0x8a, 0, 0, 0x200, null, log);
  if (rd.length < 24) { log && log('er', '[有线] 读 RGB 表失败'); return false; }
  const orig = rd.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 0x200);
  log && log('in', `[有线] 表头16=${P.hex(orig.subarray(0, 16))} 槽21=${P.hex(orig.subarray(21, 24))} 槽24=${P.hex(orig.subarray(24, 27))} 尾=${P.hex(orig.subarray(506, 508))}`);
  // Phase2：整片每键区 [21..505]（5a a5 尾@506 前）。早前只填 [21..293]（按 91 键误算），
  // 真机读表证实 [294..] 残留旧色——花开富贵等读全表。161 键色相渐变与无线同源。
  const tab = new Uint8Array(orig);
  if (isDefault && anim) {
    for (let s = 21; s <= 504; s++) tab[s] = P.FLOWER_PATTERN[s - 21]; // 真机捕获的官方花色模板
  } else if (isDefault) {
    for (let s = 21; s <= 505; s++) {
      const k = Math.floor((s - 21) / 3);
      tab[s] = P.hsvRgb(k * 360 / 161)[(s - 21) % 3];
    }
  } else {
    for (let s = 21; s <= 505; s++) tab[s] = rgb[(s - 21) % 3];
  }
  const wantAt = (s) => {
    if (!isDefault) return [rgb[0], rgb[1], rgb[2]];
    if (anim) return [P.FLOWER_PATTERN[s - 21], P.FLOWER_PATTERN[s + 1 - 21], P.FLOWER_PATTERN[s + 2 - 21]];
    const w = [];
    for (let d = 0; d < 3; d++) {
      const ss = s + d, k = Math.floor((ss - 21) / 3);
      w.push(P.hsvRgb(k * 360 / 161)[(ss - 21) % 3]);
    }
    return w;
  };
  // Phase3：cmd 0a（bit-7 规则 8a→0a）变体写 + 8a 读回校验。
  // 同色切效果等场景表内容不变 → 跳过写入（省 2-4 次交换）
  let tabDiff = 0;
  for (let s = 21; s <= 505; s++) if (tab[s] !== orig[s]) tabDiff++;
  const mkVariants = () => [
    { label: 'cmd0a 单帧 d4/400/40', v: [0x0a, 0xd4, 0x400, 0x40] },
    { label: 'cmd0a 单帧 00/200/01', v: [0x0a, 0x00, 0x200, 0x01] },
    { label: 'cmd0a 单帧 d4/200/40', v: [0x0a, 0xd4, 0x200, 0x40] },
    { label: 'cmd0a 分块 flags=1', v: [0x0a, 0x00, 0x200, 0x01, true] },
    { label: 'cmd06 兜底 00/200/01', v: [0x06, 0x00, 0x200, 0x01] },
  ];
  if (!tabDiff) {
    log && log('ok', '[有线] 每键表已是目标状态，跳过 8a 写入');
    // bank 段仍需保证一致（默认/自定义两模式都可能需要）
    await ensureWiredBanks(dev, isDefault, rgb, log);
    return true;
  }
  const variants = wiredPaletteVariant ? [wiredPaletteVariant] : mkVariants();
  for (const variant of variants) {
    const { label } = variant;
    const [cmd, sub, len, flags] = variant.v;
    const payload = new Uint8Array(len);
    payload.set(tab.subarray(0, Math.min(0x200, len)));
    log && log('in', `[有线] 写 RGB 表（${label}）…`);
    try {
      await feat520Exchange(dev, cmd, sub, 0, len, payload, log, 6, flags);
    } catch (e) { log && log('er', `[有线] 变体发送失败（${label}）: ${e.message}`); continue; }
    await sleep(50);
    const chk = await feat520Exchange(dev, 0x8a, 0, 0, 0x200, null, log);
    if (chk.length >= 24) {
      const now = chk.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 0x200);
      const hit = WIRED_RGB_SLOTS.filter((s) => { const w = wantAt(s); return now[s] === w[0] && now[s + 1] === w[1] && now[s + 2] === w[2]; }).length;
      log && log('in', `[有线] ${label} → 槽命中 ${hit}/2（槽21=${P.hex(now.subarray(21, 24))} 槽24=${P.hex(now.subarray(24, 27))}）`);
      if (hit >= 1) {
        wiredPaletteVariant = variant;
        if (anim) { log && log('ok', '[有线] 动画模板表已写入（花开富贵；跳过 bank——官方对照 86 无变化）'); return true; }
        await ensureWiredBanks(dev, isDefault, rgb, log);
        log && log('ok', `[有线] 写色完成（8a 表 + 86 bank-1${isDefault ? '，6 槽色相展开' : ''}）`);
        return true;
      }
    }
  }
  log && log('er', '[有线] 调色板写变体均未生效——若灯异常请拔线重插恢复');
  return false;
}

// 86 bank-1 六槽效果调色板：默认=色相展开（花开富贵等炫彩观感），自定义色=同色。
// 内容一致时跳过写入（同色切效果场景）。真机教训：呼吸等效果读 bank，残留单色=频闪。
async function ensureWiredBanks(dev, isDefault, rgb, log) {
  const rd2 = await feat520Exchange(dev, 0x86, 0, 0, 0x200, null, log);
  if (rd2.length < 24) return;
  const BANKS = [260, 265, 272, 334, 339, 346];
  const bankWant = BANKS.map((_, idx) => isDefault ? P.hsvRgb(idx * 60) : rgb);
  const orig2 = rd2.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 0x200);
  const pal = new Uint8Array(orig2);
  BANKS.forEach((s, idx) => { const c = bankWant[idx]; pal[s] = c[0]; pal[s + 1] = c[1]; pal[s + 2] = c[2]; });
  let same = 0;
  for (let i = 0; i < 0x200; i++) if (pal[i] === orig2[i]) same++;
  if (same === 0x200) { log && log('ok', '[有线] bank 已是目标状态，跳过 86 写入'); return; }
  const pl2 = new Uint8Array(0x400);
  pl2.set(pal);
  await feat520Exchange(dev, 0x06, 0xd4, 0, 0x400, pl2, log, 6, 0x40);
  await sleep(50);
  const chk2 = await feat520Exchange(dev, 0x86, 0, 0, 0x200, null, log);
  if (chk2.length >= 24) {
    const n2 = chk2.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 0x200);
    const hit2 = BANKS.filter((s, idx) => { const w = bankWant[idx]; return n2[s] === w[0] && n2[s + 1] === w[1] && n2[s + 2] === w[2]; }).length;
    log && log(hit2 >= 5 ? 'ok' : 'warn', `[有线] 效果调色板 bank-1 ${hit2}/6 槽命中（槽260=${P.hex(n2.subarray(260, 263))}；未保存，断电恢复）`);
  }
}

// 有线每键涂色（自定义模式）：读 8a 表 → 按矩阵号填 [21+3m] 三元组 → cmd 0a 写回。
// ledMap 为空 = 清除涂色（每键区整片清零）。矩阵号 = 固件 LED 索引（KB.ini matrix 列，
// 全型号最大 112 < 表容量）。使用已验证的写变体（d4/400/40），失败回退 00/200/01。
export async function hidSetPerKeyWired(dev, ledMap, log) {
  const entries = Object.entries(ledMap);
  log && log('in', '[有线] 每键涂色：' + entries.length + ' 键' + (entries.length ? '' : '（清除整片）'));
  const rd = await feat520Exchange(dev, 0x8a, 0, 0, 0x200, null, log);
  if (rd.length < 24) { log && log('er', '[有线] 读 RGB 表失败'); return false; }
  const tab = new Uint8Array(rd.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 0x200));
  const want = new Map();
  if (!entries.length) {
    for (let s2 = 21; s2 <= 505; s2++) tab[s2] = 0;
  } else {
    for (const [m, rgb] of entries) {
      const off = 21 + 3 * (+m);
      if (off + 2 > 505) continue;
      tab[off] = rgb[0]; tab[off + 1] = rgb[1]; tab[off + 2] = rgb[2];
      want.set(+m, rgb);
    }
  }
  for (const [sub, len, flags] of [[0xd4, 0x400, 0x40], [0x00, 0x200, 0x01]]) {
    const payload = new Uint8Array(len);
    payload.set(tab.subarray(0, Math.min(0x200, len)));
    try { await feat520Exchange(dev, 0x0a, sub, 0, len, payload, log, 6, flags); }
    catch (e) { log && log('er', '[有线] 涂色写发送失败: ' + e.message); continue; }
    await sleep(50);
    const chk = await feat520Exchange(dev, 0x8a, 0, 0, 0x200, null, log);
    if (chk.length >= 24) {
      const now = chk.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 0x200);
      const hit = entries.length
        ? [...want.entries()].filter(([m, c]) => now[21 + 3 * m] === c[0] && now[22 + 3 * m] === c[1] && now[23 + 3 * m] === c[2]).length
        : (now[21] === 0 && now[22] === 0 && now[23] === 0 ? 1 : 0);
      const pass = entries.length ? hit >= Math.max(1, want.size - 2) : hit === 1;
      if (pass) { log && log('ok', '✓ [有线] 每键涂色已写入（' + (entries.length ? hit + '/' + want.size + ' 键命中' : '已清空') + '；未保存，断电恢复）'); return true; }
      log && log('in', '[有线] 变体不符（命中 ' + hit + '），尝试下一个…');
    }
  }
  log && log('er', '[有线] 每键涂色写未生效——若灯异常请拔线重插恢复');
  return false;
}

// 有线灯光下发（520B feature 帧）。真机首测教训：cmd 04 sub 0 会把配置清零（非保存写，
// 掉电即恢复）。驱动反汇编显示写帧参数为 [04][D4][00][40] + 1024B——因此按「变体搜索」
// 实现：依次尝试 (sub, len, flags) 组合，每次写后读回 84 校验，命中即缓存变体后续直用；
// 全部失败则提示重插恢复。不落盘（保存命令未逆向），断电还原。
let wiredWriteVariant = null; // 命中的写参数 [sub, len, flags]
export async function hidApplyEffectWired(dev, effectByte, opts, log) {
  // effectByte：UI 槽位号（1-19，真机校准）；0 = 关闭
  const isOff = effectByte === 0;
  const colorMode = (opts.colorful || opts.color) ? 0x01 : 0x03;
  log && log('in', `[有线] 写效果 ui#${effectByte} 亮度=${opts.brightness} 速度=${opts.speed}${opts.colorful ? ' 炫彩' : opts.color ? ' RGB(' + opts.color.join(',') + ')' : ''}`);
  // Phase1：读配置（84）
  log && log('in', '[有线] Phase1 读配置（cmd 84）…');
  const rd = await feat520Exchange(dev, 0x84, 0, 0, 0x190, null, log);
  if (rd.length < 24) { log && log('er', '[有线] 读配置失败（' + rd.length + 'B）'); return false; }
  const orig = rd.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 0x190);
  log && log('in', `[有线] 配置 blob[0..15]=${P.hex(orig.slice(0, 16))} 帧9区=${P.hex(orig.slice(126, 140))}`);
  // Phase2：改配置（blob → 0x13 帧 → buildConfigWrite → blob）
  const frames = P.blobToFrames(orig);
  const wr = P.buildConfigWrite(frames, {
    effect: isOff ? 0 : effectByte, // 有线=UI槽位号；效果槽表按同号索引
    colorMode,
    brightness: isOff ? 0 : opts.brightness,
    speed: opts.speed,
    colorful: !!opts.colorful,
    colorRgb: isOff ? null : (opts.colorful ? null : opts.color), // 自定义色 → 第9片 idx3-5
    clearColor: !isOff && !(opts.colorful || opts.color), // 无色效果清帧9残留色（花开富贵频闪根因之一）
    animMode: !!opts.anim, // 动画族效果（花开富贵）：blob[3]=02 表驱动渲染
  });
  const blob = P.framesToBlob(wr);
  // 写入内容与当前配置无差异：改的只是颜色（调色板域，有线写侧未实现）——提示并跳过写入
  let diff = 0;
  for (let i = 0; i < 140; i++) if (blob[i] !== orig[i]) diff++; // 140 含第9片自定义色（blob[128..130] = 帧9字节7-9 = payload idx3-5）
  if (!diff) {
    log && log('in', '[有线] 配置无变化（颜色走调色板仓库，由后续写色步骤处理）');
    return false;
  }
  // Phase3：写变体搜索。已知：sub0/len190/flags01 会清零（真机）。驱动反汇编：D4/400/40。
  const variants = wiredWriteVariant
    ? [wiredWriteVariant]
    : [[0xd4, 0x400, 0x40], [0xd4, 0x190, 0x40], [0x00, 0x400, 0x40], [0xd4, 0x190, 0x01], [0x01, 0x190, 0x01]];
  for (const [sub, len, flags] of variants) {
    // 数据按 len 补零到对应长度（写帧数据区从偏移 8 起，≤512 单块；0x400 超出单块——先按整块试）
    const payload = new Uint8Array(len);
    payload.set(blob.subarray(0, Math.min(0x190, len)));
    // 写色实验：cmd 04/D4 帧长 0x400，前 400B=配置；其后 624B 未知区疑似每键 RGB 三平面
    //（原驱动 0x48D136 同帧结构）——颜色存在时三平面纯色填充（纯色常亮的等价表达）
    if (opts.color && !isOff && len >= 0x190 + 378) {
      for (let i = 0; i < 126; i++) {
        payload[0x190 + i] = opts.color[0];
        payload[0x190 + 126 + i] = opts.color[1];
        payload[0x190 + 252 + i] = opts.color[2];
      }
    }
    log && log('in', `[有线] Phase3 写配置（cmd 04 sub=${sub.toString(16)} len=${len.toString(16)} flags=${flags.toString(16)}，效果字节=${blob[10]} 原 ${orig[10]}）…`);
    try {
      await feat520Exchange(dev, 0x04, sub, 0, len, payload, log, 6, flags);
    } catch (e) {
      log && log('er', `[有线] 该变体发送失败: ${e.message}`);
      continue;
    }
    // 读回校验（已知域前 16 字节即可判定写入是否生效）
    await sleep(50);
    const chk = await feat520Exchange(dev, 0x84, 0, 0, 0x190, null, log); // 校验读必须 seq=0（真机：seq≠0 返回假零）
    if (chk.length >= 24) {
      const now = chk.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 0x190);
      let same = 0;
      for (let i = 0; i < 140; i++) if (now[i] === blob[i]) same++;
      if (same >= 138) { // 允许个别字节由固件自行修正
        wiredWriteVariant = [sub, len, flags];
        log && log('ok', `[有线] 配置已生效（${same}/140 一致；变体已缓存；未保存，断电恢复）`);
        log && log('in', `[有线] 读回帧9区 blob[126..139] = ${P.hex(now.slice(126, 140))}（写入期望色 ${P.hex(blob.slice(128, 131))}，读回色 ${P.hex(now.slice(128, 131))}）`);
        return true;
      }
      log && log('in', `[有线] 变体不符（${same}/128），尝试下一个…`);
    }
  }
  log && log('er', '[有线] 所有写变体均未生效——请拔线重插键盘恢复配置，并把日志反馈');
  return false;
}
