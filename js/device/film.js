// 银雕 K65 屏幕（film）烧录 —— 2026-10 REA/IDA Pro 9.5 反汇编实证（K65 版 OemDrv.exe），
// 2026-10-18 真机回归通过。
// 传输：feat520 feature 通道（与灯光有线管线同一接口同一 report id；rid 按 fw 选，K65→9）。
//   旧版「独立 20B 0x15 输出报告管道」的假设已被反汇编证伪——屏幕命令全部走 520B feature 帧。
// 烧录序列（BurnScreenThread 0x497B30 + CDevG5KB::SetGIFParam 0x492830 + AccessData_Page 0x492490）：
//   1. SetGIFParam 开始：cmd 0x0D，载荷 {0|op=1<<6, 帧数 u16, 延时 u16ms}，GET 回读校验；
//      超时（无应答）重试 ≤3 次、间隔 200ms
//   2. Sleep 120ms
//   3. 每帧 i：RGB565 数据按 512B 分包连续发送（cmd 0x0C，[3]=帧序号、[4]=包序 0..N 连续），
//      整帧发完读一次应答；失败重发整帧（驱动 AccessData_Page 页级重试，间隔 25ms）
//   4. Sleep 50ms
//   5. SetGIFParam 收尾：op=0（用户取消时驱动用 op=2），帧数=已发数，延时=完整值
// 像素：行优先 RGB565 大端（0x497880 GDI+ 打包循环：R>>3<<11|G>>2<<5|B>>3 后 ROL16 字节序交换），
//   135×240 → 64800B/帧，无帧头（帧序号在报文头 [3]，不在像素流里）。
// 真机回归（2026-10-18）：开始/收尾命令延时字段统一用完整 UI 值（驱动开始时减去的
//   nDrawFrameTime 是其内部预览预算，固件侧不要求）——验证通过，无需再按首帧差值。
import * as P from './protocol.js';
import { feat520Rid, feat520Exchange, getFeat520Mode, hasFeatureReport } from './webhid.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const FILM_CHUNK = 512;                       // 每包数据上限（AccessData_Page 0x492490）
export const FILM_CMD_PAGE = P.FILM_CMD_PAGE;        // 0x0C 像素数据帧
export const FILM_CMD_PARAM = P.FILM_CMD_PARAM;      // 0x0D SetGIFParam

// ---------- 像素格式 ----------
// canvas ImageData(RGBA) → 大端 RGB565（0x497880 循环实证，行优先、无帧头）
export function rgb565Pack(imageData) {
  const { data } = imageData;
  const out = new Uint8Array((data.length / 4) * 2);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 2) {
    const r5 = data[i] >> 3, g6 = data[i + 1] >> 2, b5 = data[i + 2] >> 3;
    const px = ((r5 << 11) | (g6 << 5) | b5) & 0xffff;
    out[j] = px >> 8;          // 大端（ROL16 实证）
    out[j + 1] = px & 0xff;
  }
  return out;
}

// ---------- 接口选择 ----------
// 屏幕通道 = feat520 通道（反汇编实证：SetGIFParam/AccessData_Page 走有线接口的 feature 帧，
// 无独立 vendor 接口）。主接口可能是 2.4G 接收器（bestForLights 偏向声明 out[13] 的接口，
// 接收器无 feat520）——不能无脑复用，须按声明挑选；均未声明返回 null（上层报 no-iface）。
export function pickFilmIface(devs, log) {
  const list = (devs ?? []).filter((d) => d?.opened);
  if (!list.length) { log && log('er', '屏幕通道：没有已打开的设备'); return null; }
  const vp = (d) => `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
  const want = getFeat520Mode() === 'k65' ? [9] : [6, 9]; // legacy 与 feat520Rid 同序：6 优先 9 兜底
  for (const rid of want) {
    const hit = list.find((d) => hasFeatureReport(d, rid));
    if (hit) { log && log('in', `屏幕通道：选中声明 feat${rid} 的接口 ${vp(hit)}（与灯光有线管线同一通道）`); return hit; }
  }
  log && log('er', '屏幕通道：已打开接口均未声明 feat520（feature 6/9）——有线数据通道在键盘的有线接口上，不在 2.4G 接收器');
  return null;
}

// ---------- SetGIFParam（0x0D）：开始 / 收尾 / 取消收尾 ----------
// op: 1=开始 0=正常收尾 2=取消收尾。返回 1 成功 / -1 超时 / 0 应答不符（驱动同款返回值语义）。
export async function filmGifParam(dev, op, frameCount, delayMs, log, tries = 4) {
  const rid = feat520Rid(dev);
  const payload = P.buildGifParamPayload(0, op, frameCount, delayMs);
  let last = null;
  for (let t = 0; t < Math.max(1, tries); t++) {
    log && log('in', `SetGIFParam(op=${op}, 帧数=${frameCount}, 延时=${delayMs}ms) 第 ${t + 1} 次`);
    let resp;
    try { resp = await feat520Exchange(dev, P.FILM_CMD_PARAM, 0, 0, payload.length, payload, log, rid, 0x01); }
    catch (e) { last = e; log && log('er', `SetGIFParam 交换失败: ${e.message}`); await sleep(200); continue; }
    // 应答数据 @8（8B 回显）；驱动校验延时字段非零（respond unmatch）
    const echo = resp.slice(P.FEAT520_DATA_OFF, P.FEAT520_DATA_OFF + 8);
    const okDelay = (echo[3] | (echo[4] << 8));
    if (resp.length >= 12 && okDelay !== 0) return 1;
    log && log('warn', `SetGIFParam 应答异常（延时回显=${okDelay}）`);
    last = 0; await sleep(200);
  }
  return last instanceof Error ? 0 : -1;
}

// 单帧发送（AccessData_Page 0x492490 同构）：512B 连续分包，整帧后读应答，失败整帧重发。
async function sendFrame(dev, rid, frameIdx, data, log, shouldAbort) {
  const nPkgs = Math.ceil(data.length / FILM_CHUNK);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (shouldAbort?.()) return false;
    let fail = false;
    for (let c = 0; c < nPkgs && !fail; c++) {
      const chunk = data.subarray(c * FILM_CHUNK, Math.min((c + 1) * FILM_CHUNK, data.length));
      const f = P.buildFilmDataReport(rid, frameIdx, c, chunk);
      try { await dev.sendFeatureReport(rid, f.slice(1)); }
      catch (e) { log && log('er', `帧 ${frameIdx} 片 ${c} 发送失败: ${e.message}`); fail = true; break; }
      log && log('tx', `F${rid} film[${frameIdx}/${c}] ${P.hex(f.slice(0, 10))} …${chunk.length}B`);
      await sleep(5); // SET→固件节奏余量（feat520Exchange 同款间隙）
    }
    if (fail) { await sleep(25); continue; }
    // 整帧应答（驱动的页级事件等待 ≈ 一次 GET 轮询）
    try {
      const dv = await dev.receiveFeatureReport(rid);
      log && log('rx', `F${rid} 帧应答 ${P.hex(new Uint8Array(dv.buffer, dv.byteOffset, Math.min(dv.byteLength, 16)))}`);
      return true;
    } catch (e) {
      log && log('warn', `帧 ${frameIdx} 应答超时（${attempt + 1}/3），整帧重发`);
      await sleep(25);
    }
  }
  return false;
}

// ---------- 烧录（BurnScreenThread 0x497B30 同构） ----------
// frames: RGB565 Uint8Array[]；delays: 每帧 ms（协议只有一个全局延时——取首帧，差异时告警）。
export async function filmBurn(dev, frames, log, opts = {}) {
  const { onProgress, shouldAbort, delays } = opts;
  const rid = feat520Rid(dev);
  const total = frames.length;
  const delay = Math.max(0, Math.min(0xffff, Math.round(delays?.[0] ?? 500)));
  const uniq = [...new Set((delays ?? []).map(Math.round))];
  if (uniq.length > 1) log && log('warn', `协议仅支持统一帧延时（SetGIFParam 单值 u16），已取第 1 帧 ${delay}ms；各帧现值 ${uniq.join('/')}ms`);
  log && log('in', `屏幕烧录开始：${total} 帧 × ${frames[0]?.length ?? 0}B（feat520 rid=${rid}，帧延时 ${delay}ms）`);

  // 1. 开始命令（超时重试 ≤3，间隔 200ms）
  const start = await filmGifParam(dev, 1, total, delay, log, 4);
  if (start !== 1) {
    log && log('er', `SetGIFParam 开始失败（ret=${start}）——设备未应答，中止`);
    return { sent: false, error: 'no-ack', frames: 0, chunks: 0 };
  }
  await sleep(120); // 驱动 Sleep(0x78)

  // 2. 逐帧数据
  let chunks = 0, aborted = false;
  for (let i = 0; i < total; i++) {
    if (shouldAbort?.()) { aborted = true; break; }
    const ok = await sendFrame(dev, rid, i, frames[i], log, shouldAbort);
    if (!ok) {
      // 数据帧三次整帧重发仍无应答：按驱动语义取消收尾后中止
      await filmGifParam(dev, 2, i, delay, log, 1);
      log && log('er', `帧 ${i + 1}/${total} 发送失败，已发取消收尾并中止`);
      return { sent: false, error: 'frame-fail', frames: i, chunks, aborted };
    }
    chunks += Math.ceil(frames[i].length / FILM_CHUNK);
    onProgress?.(i + 1, total);
  }

  // 3. 收尾命令（op=0；帧数=已发数；延时=完整值）
  await sleep(50); // 驱动 Sleep(0x32)
  const sentCount = aborted ? 0 : total;
  const fin = aborted ? -1 : await filmGifParam(dev, 0, sentCount, delay, log, 1);
  if (aborted) log && log('warn', `烧录已取消（${chunks} 片已发）`);
  else log && log(fin === 1 ? 'ok' : 'er',
    `屏幕烧录结束：${total} 帧 / ${chunks} 片，收尾 ${fin === 1 ? '已确认' : `ret=${fin}`}——固件是否落盘以键盘实际显示为准`);
  return { sent: !aborted && fin === 1, frames: total, chunks, aborted };
}
