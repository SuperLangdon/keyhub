// AULA/LEOBOG 同源 SINO WEALTH 固件的 HID 报文协议（逆向自同 VID/PID 硬件的开源实现）
// 20 字节 output report：[0]=0x13 [1]=cmd [2]=subcmd [3]=seq [4..18]=payload [19]=校验和
export const REPORT_ID = 0x13;
export const CMD_READ = 0x44;
export const CMD_WRITE = 0x04;
export const CMD_COLOR = 0x09;
export const CMD_PERKEY = 0x02;
export const CMD_SAVE = 0x0A;
export const CMD_BATTERY = 0x4A; // 电量（只读，无线通道）：响应 payload[0]=oper|len(=0x02) payload[1]=百分比 payload[2]=状态标志
export const SUBCMD_CONFIG = 0x0A;
export const SUBCMD_PALETTE = 0x25;
export const SUBCMD_PERKEY = 0x1C;
export const SUBCMD_CONFIRM = 0x01;

export const WIRED = { vid: 0x258a, pid: 0x010c };
export const WIRELESS = { vid: 0x3554, pid: 0xfa09 };

// ---------- 型号识别（PSD / 密码查询；逆向自原驱动 OemDrv.exe）----------
// 三条查询路径（webhid.readPsd 按接口能力依次尝试，均只读）：
// ① 有线键盘（ff00 接口）：feature report 5 —— SetFeature(5,[05 81 00×6]) → GetFeature(5)
//   读回 [05][01][PSD×6]（GetPassword 的发送/读取 helper → HID.DLL!HidD_SetFeature/GetFeature，
//   导入表反汇编验证；早先误判为 WriteFile/ReadFile，真机实测 sendReport(5) 被拒后修正）。
// ② output report 5 → input 应答（个别固件兜底，未在原驱动见到）。
// ③ 2.4G 接收器（3554:fa09，仅 out[13]/in[13,5]）：0x13 协议两步（逆向 Watcher_Thread_3632）——
//   [13][07][01][seq][0…] 探测（应答 [01 01 00…]）→ 约 200ms 后 [13][05][01][seq][0…] 查询，
//   应答 [13][05][01][00][**0A**][PSD×6][01]…（0x0A 标记 + PSD + 01 标志，真机已验证；
//   对应原驱动 Watcher 校验的 0x0A/01 两字节），另会跟一帧 [13][0A][01][00][04 05 64 01]（状态通知）。
// ④ 3632 类读命令（有线键盘无 OUT 端点时的通道，逆向自 OemDrv.exe 的 3632 协议族）：
//   SetFeature(5, [83 B6 00×4], 6)（读配置）/ [88 B8 …]（读数据块）→ GetFeature(6) 应答 blob；
//   写类命令 [03 B6]（SetProfile）/ [08 B8] 一律不发。真机（有线 Hi98 3-Mode）拓扑：
//   MI_01 上 7 个 collection（含被 Chrome 隐藏的键盘/鼠标/系统控制 TLC），feature 5 的 SET
//   与 feature 6 的 GET 分属两个 vendor collection、同一 USB 接口——网页端两个操作都可用。
//   GetFeature(5) 被固件 STALL（Chrome/Windows 均拒），故路径 ① 在有线键盘上必然超时。
//   应答 blob 中 PSD 的确切偏移未抓包确定 → webhid 返回 blob，由 connect.js 对型号表滑窗匹配。
// ⑥ 520 字节 feature 帧协议（有线识别主通道，逆向自 0x491AD0/"Psd unmatch: gVar.nPsd"
//   的第二调用类）：SetFeature(report R, [R][82][01][00][01][seq][lenLo][lenHi][0…]×520) →
//   GetFeature(report R, 520B) → 应答 buf+8 = PSD×6（len=6 单块）；R 由固件字段选择
//（KB.ini Fw==24/0x18 → report 6，否则 9），无校验和。真机键盘 feat[6] 可见 → 网页端可走。
// ⑤ 520 字节 feature 9 协议（0x8805 鼠标类；真机键盘无 report 9，保留快速失败兼容）：
//   SetFeature(report 9, 520B帧)——[09][ck][cmd][sub][01][00][lenLo][lenHi][0…]，
//   ck=字节2..519 累加；探测 cmd=07 sub=00 len=0x200，GetPSD cmd=05 sub=01 len=6；
//   应答走中断 IN（探测应答校验 [..][0A][02][01]）。
// PSD 与各型号 KB.ini 的 Psd=（十六进制）逐字节相等即命中型号；Psd2 为第二组密码（未使用，恒 0）。
// Chrome 按 USB 接口授权，识别命令可能只存在于其中一个接口 → webhid.readPsd 对授权接口逐个查询。
export const PSD_REPORT_ID = 0x05;
export const PSD_REQUEST = [0x05, 0x81, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

// ---------- 520 字节 feature 帧协议（0x49 类，有线键盘；识别/读配置共用）----------
// 帧格式（520 字节，帧[0]=report id）：[R][cmd][sub][00][01][seq][lenLo][lenHi][data…][补零]
// 应答（真机验证）：[R][帧头回显×7][数据@偏移 8]，按 len 分块（块 ≤512）。
// 已知命令：82 01=GetPSD（✓真机）；83/86=块读（sub 为调用方参数，SyncCfg 读 400B 配置）；
// 84/85/87 02/88/8A 语义待定（静态逆向未见数据写入拷贝，写侧命令未确认——不盲发）。
export const FEAT520_LEN = 520;
export const FEAT520_DATA_OFF = 8;
export function buildFeat520Frame(rid, cmd, sub, seq, dataLen, payload, flags = 0x01) {
  const f = new Uint8Array(FEAT520_LEN);
  f[0] = rid; f[1] = cmd; f[2] = sub; f[3] = 0x00; f[4] = flags; f[5] = seq & 0xff;
  f[6] = dataLen & 0xff; f[7] = (dataLen >> 8) & 0xff;
  if (payload) for (let i = 0; i < 512 && i < payload.length; i++) f[FEAT520_DATA_OFF + i] = payload[i];
  return f;
}

// ---------- 有线隧道帧（逆向自 OemDrv.exe CDevG5KB::AccessData_Page 隧道族）----------
// 有线键盘没有 0x13 输出端点，原驱动把无线命令集封装进 520B feature 帧发送：
// [6][ck][wcmd][01][01][00][lenLo][lenHi][data ≤0x200][补零]
//   [3]=1 区分隧道帧与 feat520 命令帧（[3]=0）；ck = 帧[2..519] 累加和（回显逐字节验证）
//   wcmd 沿用无线 0x13 命令域：0x09=调色板 0x05=SetLED 0x44=读配置 0x88=每键RGB
// 设备按固件版本选 report 6 或 9（驱动 [版本==0x18→6]）；本机无 report 9 → 走 6（真机验证）。
// 数据 >0x200 按 0x200 分块续发（驱动侧分块循环）。
export function buildTunnel6(wcmd, data) {
  const f = new Uint8Array(FEAT520_LEN);
  f[0] = 6; f[2] = wcmd; f[3] = 1; f[4] = 1; f[5] = 0;
  const n = Math.min(data.length, 0x200);
  f[6] = n & 0xff; f[7] = (n >> 8) & 0xff;
  for (let i = 0; i < n; i++) f[FEAT520_DATA_OFF + i] = data[i];
  let ck = 0;
  for (let i = 2; i < FEAT520_LEN; i++) ck = (ck + f[i]) & 0xff;
  f[1] = ck;
  return f;
}

// ---------- 有线配置 blob ↔ 0x13 十片帧 互转 ----------
// 真机实测：84 读回的 400B blob = 0x13 配置 10 片去掉每片 payload[0] 标记字节后的顺序拼接
//（seq0 payload `0e 00 03 03 01…` ↔ blob `00 03 03 01…` 逐字节吻合）；seq9 为 `02`+2字节+5a a5 尾。
export function blobToFrames(blob) {
  const frames = [];
  for (let s = 0; s < 9; s++) {
    const p = new Uint8Array(15);
    p[0] = 0x0e;
    for (let i = 0; i < 14; i++) p[1 + i] = blob[s * 14 + i] ?? 0;
    frames.push(buildFrame(CMD_READ, SUBCMD_CONFIG, s, p)); // 用 0x44 头，写侧 buildConfigWrite 会改
  }
  // 第 9 片：payload[0]=02 标记，[1..14]=blob[126..139]（含 5a a5 与自定义色 RGB@blob[128..130]）
  const p9 = new Uint8Array(15);
  p9[0] = 0x02;
  for (let i = 0; i < 14; i++) p9[1 + i] = blob[126 + i] ?? 0;
  frames.push(buildFrame(CMD_READ, SUBCMD_CONFIG, 9, p9));
  return frames;
}

export function framesToBlob(frames) {
  const blob = new Uint8Array(0x190);
  for (let s = 0; s < 9; s++) for (let i = 0; i < 14; i++) blob[s * 14 + i] = frames[s][4 + 1 + i];
  for (let i = 0; i < 14; i++) blob[126 + i] = frames[9][4 + 1 + i]; // 含 5a a5 + 自定义色
  return blob;
}

export function checksum(f) {
  let s = 0;
  for (let i = 0; i < 19; i++) s += f[i];
  return s & 0xff;
}

export function buildFrame(cmd, subcmd, seq, payload) {
  const f = new Uint8Array(20);
  f[0] = REPORT_ID; f[1] = cmd; f[2] = subcmd; f[3] = seq & 0xff;
  for (let i = 0; i < 15 && i < payload.length; i++) f[4 + i] = payload[i];
  f[19] = checksum(f);
  return f;
}

export function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

// ---------- 调试台：0x13 帧注解 ----------
// cmd → 语义名（读写两侧共用一个命令域；写 = 读 & 0x7F 的位 7 清零规律）
export const CMD13_NAMES = {
  0x01: 'SetMatrix 键位写', 0x02: '每键RGB写', 0x03: 'SetMacro 宏写',
  0x04: '写配置', 0x05: 'GetPSD', 0x07: '链路探测', 0x09: '调色板写',
  0x0a: '保存', 0x41: 'GetMatrix 键位读', 0x43: 'GetMacroData 宏读',
  0x44: '读配置', 0x4a: '电量查询',
};

// 20 字节 0x13 帧 → 结构化字段（Send13 语义：[2]=本块总帧数 [3]=帧号 [4]=(tag<<4)|片长）。
// 非 0x13 帧（长度 ≠20 或首字节 ≠0x13）返回 null；sumOk = 校验和是否自洽。
export function decodeFrame(f) {
  if (!f || f.length !== 20 || f[0] !== REPORT_ID) return null;
  let s = 0;
  for (let i = 0; i < 19; i++) s += f[i];
  return {
    cmd: f[1],
    name: CMD13_NAMES[f[1] & 0x7f] ?? null,
    nFrames: f[2],
    seq: f[3],
    tag: f[4] >> 4,
    len: f[4] & 0x0f,
    payload: f.slice(5, 19),
    sumOk: (s & 0xff) === f[19],
  };
}

// ---------- 宏与键位矩阵（逆向自 OemDrv.exe，2026-10）----------
// 命令族（CDev3632 vtable 0x616454；写 = 读 & 0x7F 的位 7 清零规律）：
//   SetMatrix @0x48bb90 = Send13(cmd=0x01, tag=层号)    GetMatrix = cmd 0x41
//   SetMacro  @0x48bca0 = WriteMacroData @0x48bc00：数据按 **512B 分块**，
//     每块走 Send13(cmd=0x03, tag=块号)，块间 Sleep(100ms)   GetMacroData = cmd 0x43
//   下载编排：CDev3632::ApplySetting(0x48c6a0) → DownloadMacro(0x493590)
//     → BuildMacroBlob(0x492a40) → StMacro_To_HdMacro(0x492670)
// Send13(0x48b4f0) 帧规则（本文件 buildTaggedFrames 复刻）：
//   [0]=0x13 [1]=cmd [2]=本块总帧数 [3]=帧号(块内 0 起) [4]=(tag<<4)|本片数据长
//   [5..]=数据(≤14B) [19]=校验和 —— tag 即 SetMatrix 的层号 / SetMacro 的块号
export const CMD_MATRIX_W = 0x01;
export const CMD_MACRO_W = 0x03;
export const CMD_MATRIX_R = 0x41;
export const CMD_MACRO_R = 0x43;
export const MACRO_CHUNK = 0x200; // SetMacro 分块 512B（驱动 0x48bc13 idiv 0x200）

// 通用分片帧：把任意数据按 tag 打包成 0x13 帧（对应驱动 Send13 的循环体）
export function buildTaggedFrames(cmd, tag, data) {
  const total = Math.max(1, Math.ceil(data.length / 14));
  const frames = [];
  for (let i = 0; i < total; i++) {
    const chunk = data.subarray(i * 14, Math.min(i * 14 + 14, data.length));
    const p = new Uint8Array(15);
    p[0] = ((tag << 4) | chunk.length) & 0xff;
    p.set(chunk, 1);
    frames.push(buildFrame(cmd, total & 0xff, i, p));
  }
  return frames;
}

// Windows VK → HID usage（键盘页标准 USB HID usage 表；输出域与驱动
// StMacro_To_HdMacro 的 usage 编码一致——其输入侧是驱动内部键码域，
// 0x60ED78 线性表 + 0x492940/0x4928F8 两级跳转表殊途同归落到同一组 usage）
export const VK2HID = new Map([
  [0x08, 0x2a], [0x09, 0x2b], [0x0d, 0x28], [0x13, 0x48], [0x14, 0x39], [0x1b, 0x29],
  [0x20, 0x2c], [0x21, 0x4b], [0x22, 0x4e], [0x23, 0x4d], [0x24, 0x4a], [0x25, 0x50],
  [0x26, 0x52], [0x27, 0x4f], [0x28, 0x51], [0x2d, 0x49], [0x2e, 0x4c], [0x2c, 0x46],
  [0x90, 0x53], [0x91, 0x47], [0x5d, 0x65],
  [0xba, 0x33], [0xbb, 0x2e], [0xbc, 0x36], [0xbd, 0x2d], [0xbe, 0x37], [0xbf, 0x38],
  [0xc0, 0x35], [0xdb, 0x2f], [0xdc, 0x31], [0xdd, 0x30], [0xde, 0x34],
  // 修饰键 0xE0-0xE7
  [0xa0, 0xe1], [0xa1, 0xe5], [0xa2, 0xe0], [0xa3, 0xe4], [0xa4, 0xe2], [0xa5, 0xe6],
  [0x5b, 0xe3], [0x5c, 0xe7],
  // 小键盘
  [0x6a, 0x55], [0x6b, 0x57], [0x6d, 0x56], [0x6e, 0x63], [0x6f, 0x54],
  [0x60, 0x62], [0x61, 0x59], [0x62, 0x5a], [0x63, 0x5b], [0x64, 0x5c],
  [0x65, 0x5d], [0x66, 0x5e], [0x67, 0x5f], [0x68, 0x60], [0x69, 0x61],
]);
for (let i = 0; i < 10; i++) VK2HID.set(0x30 + i, 0x1e + i);        // 1-0 → 0x1E-0x27
for (let i = 0; i < 26; i++) VK2HID.set(0x41 + i, 0x04 + i);        // A-Z → 0x04-0x1D
for (let i = 0; i < 12; i++) VK2HID.set(0x70 + i, 0x3a + i);        // F1-F12 → 0x3A-0x45
for (let i = 0; i < 12; i++) VK2HID.set(0x7c + i, 0x68 + i);        // F13-F24 → 0x68-0x73

// 事件类型（byte0 高 4 位；逆向自 StMacro_To_HdMacro 的 case 分支）
export const MAC_EV_KEY = 0x0;     // 普通键（usage = VK2HID）
export const MAC_EV_MOD = 0x1;     // 修饰键 0xE0-0xE7
export const MAC_EV_MBTN = 0x2;    // 鼠标键（usage = 位图 1/2/4/8/0x10）
export const MAC_EV_WHEEL = 0x3;   // 滚轮（usage = 参数）
export const MAC_EV_CONSUMER = 0x4;// 多媒体（usage = consumer usage）
export const MAC_EV_MOVE = 0x5;    // 鼠标移动（usage = 距离，1-255）

// 事件 4 字节编码：[类型<<4|延时高4位|0x80(按下)] [延时>>8] [延时&0xff] [usage]
// 语义（逆向推断，待真机校准）：0x80 = 按下事件（延时 = 按住时长）；无 0x80 = 释放
//（延时 = 释放后的等待）。滚轮/移动类无按下/释放二义，恒不带 0x80（驱动同款跳过）。
export function encodeMacroEvent(type, usage, delayMs, press = false) {
  const d = Math.max(0, Math.min(0xfffff, Math.round(delayMs)));
  const b0 = ((type << 4) | ((d >> 16) & 0x0f) | (press ? 0x80 : 0)) & 0xff;
  return [(b0), (d >> 8) & 0xff, d & 0xff, usage & 0xff];
}

// 录制的宏事件序列（{at, kind:'dn'|'up', code:VK}）→ 固件 4B 事件流。
// dn 的延时 = 按住时长（配对 up 的时间差）；up 的延时 = 距下一个 dn 的等待；
// 未配对的 up 视为按下后立即释放（延时 0）。返回 Uint8Array。
export function macroEventsToBytes(events) {
  const evs = [...events].sort((a, b) => a.at - b.at);
  const out = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const vk = e.code | 0;
    let type = MAC_EV_KEY, usage = VK2HID.get(vk);
    if (usage == null) continue; // 无 HID 映射（FN 等本机键）——驱动同样丢弃
    if (usage >= 0xe0 && usage <= 0xe7) type = MAC_EV_MOD;
    if (e.kind === 'dn') {
      // 按住时长：向后找同键 up
      let hold = 0;
      for (let j = i + 1; j < evs.length; j++) {
        if (evs[j].kind === 'up' && (evs[j].code | 0) === vk) { hold = Math.max(0, evs[j].at - e.at); break; }
      }
      out.push(...encodeMacroEvent(type, usage, hold, true));
    } else {
      // 释放后等待：距下一个任意按下事件的时间
      let wait = 0;
      for (let j = i + 1; j < evs.length; j++) {
        if (evs[j].kind === 'dn') { wait = Math.max(0, evs[j].at - e.at); break; }
      }
      out.push(...encodeMacroEvent(type, usage, wait, false));
    }
  }
  return Uint8Array.from(out);
}

// 宏下载 blob（逆向自 BuildMacroBlob 0x492a40 / 打包器 0x493590）：
//   [索引表 n×4B：{u16 addr(相对数据区), u16 size(含名长)}][数据区]
//   数据区每条宏 = [名字节数 1B][名字 UTF-16LE][事件流 4B×k]
//   表在 blob 头部（驱动总装时 addr 统一 +表长重定位），count 由调用方另行记录
export function buildMacroBlob(macros) {
  const datas = [];
  let dataLen = 0;
  const table = [];
  for (const m of macros) {
    const nameBytes = Uint8Array.from(
      [...String(m.name ?? '').slice(0, 120)].flatMap((ch) => {
        const c = ch.charCodeAt(0);
        return [c & 0xff, (c >> 8) & 0xff];
      }));
    const ev = macroEventsToBytes(m.events ?? []);
    const rec = new Uint8Array(1 + nameBytes.length + ev.length);
    rec[0] = nameBytes.length & 0xff;
    rec.set(nameBytes, 1);
    rec.set(ev, 1 + nameBytes.length);
    table.push({ addr: dataLen, size: rec.length & 0xffff });
    datas.push(rec);
    dataLen += rec.length;
  }
  const tableLen = table.length * 4;
  const blob = new Uint8Array(tableLen + dataLen);
  table.forEach((t, i) => {
    const o = i * 4;
    const addr = (t.addr + tableLen) & 0xffff; // 重定位到 blob 绝对偏移
    blob[o] = addr & 0xff; blob[o + 1] = (addr >> 8) & 0xff;
    blob[o + 2] = t.size & 0xff; blob[o + 3] = (t.size >> 8) & 0xff;
  });
  let p = tableLen;
  for (const rec of datas) { blob.set(rec, p); p += rec.length; }
  return { blob, count: macros.length };
}

// 宏键的键位表 dword（逆向自 keyinfo_to_hardware_code type-5 + BuildMacroBlob 键位补丁）：
//   (宏序号<<24) | (重复次数<<16) | (循环码<<8) | 0x03
// 循环码：1=播放一次 2=按住期间循环 4=循环直到任意键（原驱动 tc_macro_msg17-19）
export const MACRO_LOOP_CODES = { once: 1, hold: 2, anyKey: 4 };
export function macroKeyDword(macroIndex, repeat = 1, loopCode = MACRO_LOOP_CODES.once) {
  return (((macroIndex & 0xff) << 24) | ((repeat & 0xff) << 16) | ((loopCode & 0xff) << 8) | 0x03) >>> 0;
}

// ---------- 配置块（10 片 × 15 字节 payload） ----------
// 出厂模板（同源固件默认值）
export const CFG_TEMPLATE = [
  [0x0e, 0x00, 0x03, 0x03, 0x01, 0x00, 0x00, 0x04, 0x04, 0x07, 0x00, 0x00, 0x20, 0x03, 0x00],
  [0x0e, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x01, 0x00, 0xff, 0x0a, 0x00, 0x00, 0x00],
  [0x0e, 0x01, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x0e, 0xff, 0xff, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47],
  [0x0e, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47],
  [0x0e, 0x04, 0x47, 0x04, 0x47, 0x04, 0x47, 0x04, 0x37, 0x04, 0x37, 0x04, 0x37, 0x04, 0x37],
  [0x0e, 0x07, 0x47, 0x07, 0x47, 0x07, 0x44, 0x07, 0x44, 0x07, 0x44, 0x07, 0x44, 0x07, 0x44],
  [0x0e, 0x07, 0x44, 0x07, 0x44, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  [0x02, 0x5a, 0xa5, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
];

// 睡眠档位表（分钟）：板载配置 payload[9] 存的是档位索引而非分钟数
// （原驱动 FillCfg 反汇编显示 Cfg[9]=Sleep 为查表值：Cfg[2]=Debounce、Cfg[8]=Tap、
//  Cfg[9]=Sleep，Cfg 即各片 payload 顺序拼接；出厂模板 payload[9]=0x07=索引 7=60 分，
//  KB.ini SleepTime=120 对应索引 8。档位表本身由固件定义，未经真机实测，
//  可用 HID 调试台以原驱动对照校准）
export const SLEEP_LEVELS = [0, 1, 5, 10, 15, 20, 30, 60, 120];
export const sleepIndexOf = (minutes) => {
  let best = 0;
  for (let i = 0; i < SLEEP_LEVELS.length; i++) {
    if (Math.abs(SLEEP_LEVELS[i] - minutes) < Math.abs(SLEEP_LEVELS[best] - minutes)) best = i;
  }
  return best;
};

// 效果 N 的 [片序号, 报文内偏移]（亮度字节；其后一字节为速度字节）
export function effectTableLoc(n) {
  if (n >= 1 && n <= 6) return [4, 7 + (n - 1) * 2];
  if (n >= 7 && n <= 13) return [5, 5 + (n - 7) * 2];
  if (n >= 14 && n <= 18) return [6, 5 + (n - 14) * 2];
  return [4, 7];
}

export const encodeSpeedByte = (speed, colorful) => ((speed & 0xf) << 4) | (colorful ? 0x07 : 0x00);
export const decodeSpeedByte = (b) => ({ speed: (b >> 4) & 0xf, colorful: (b & 0xf) === 0x7 });

// 从 10 片读取结果中解析当前配置（frames 为 20 字节完整报文）
export function parseConfig(frames) {
  try {
    const s0 = frames[0];
    const db = s0[6];                      // payload[2] = 去抖档（0 起）
    const sleepIdx = s0[13];               // payload[9] = 睡眠档位索引
    return {
      effect: s0[15],
      colorMode: s0[17],
      debounce: db <= 4 ? db + 1 : null,
      tapSens: s0[12],                     // payload[8] = Tap 灵敏度档
      sleepMin: sleepIdx >= 0 && sleepIdx < SLEEP_LEVELS.length ? SLEEP_LEVELS[sleepIdx] : null,
      frames,
    };
  } catch { return null; }
}

// 调色板（37 片）模板
export const PAL_TEMPLATE = [
  [0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00],
  [0x0e, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff],
  [0x0e, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00],
  [0x0e, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00],
  [0x0e, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff],
  [0x0e, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00],
  [0x0e, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00],
  [0x0e, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff],
  [0x0e, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00],
  [0x0e, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00],
  [0x0e, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff],
  [0x0e, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00],
  [0x0e, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00],
  [0x0e, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff],
  [0x0e, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00],
  [0x0e, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00],
  [0x0e, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff],
  [0x0e, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00],
  [0x0e, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00],
  [0x0e, 0x00, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff],
];
export const PAL_ZEROS = [0x0e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
export const PAL_LAST = [0x08, 0, 0, 0x5a, 0xa5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// 调色板（37 片）。真机确认：本固件的自定义色不在调色板而在配置第 9 片（见 buildConfigWrite
// colorRgb），调色板模板（AULA 逆向，首帧即 ff 00 00 红色轮）反而会把固件实际读取的
// 调色板槽位污染成红色——因此除自定义槽与结尾帧外全部写零。
// HSV（h∈[0,360)）→ RGB 三字节。用于无自定义色效果的默认每键彩虹表。
export function hsvRgb(h) {
  h = ((h % 360) + 360) % 360;
  const s = Math.floor(h / 60) % 6, f = h / 60 - Math.floor(h / 60);
  const q = Math.round(255 * (1 - f)), t = Math.round(255 * f);
  return [[255, t, 0], [q, 255, 0], [0, 255, t], [0, q, 255], [t, 0, 255], [255, 0, q]][s];
}

// 花开富贵表模板（真机捕获）：官方驱动选中花开富贵时写入 cmd 8a 表 [21..504] 的
// 花色循环（蓝绿蓝黄品青白黑 + 红青品青白黑 循环，尾部约 150B 零区）。配置需带
// blob[3]=02（animMode）固件才会用表渲染，否则蓝色兜底（真机对照确证）。
// 花开富贵表模板（真机捕获）：官方驱动选中花开富贵时写入 cmd 8a 表 [21..504] 的
// 花色循环（蓝绿蓝黄品青白黑 + 红青品青白黑 循环，尾部约 150B 零区）。配置需带
// blob[3]=02（animMode）固件才会用表渲染，否则蓝色兜底（真机对照确证）。
export const FLOWER_PATTERN = new Uint8Array([0,0,255,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255,255,255,255,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);

// 动画模式调色板（无线侧）：流 [21..504] = FLOWER_PATTERN，结构同 buildPalette 流映射
export function buildPaletteAnim() {
  const frames = [];
  for (let i = 0; i < 37; i++) {
    const p = [...(i === 36 ? PAL_LAST : PAL_ZEROS)];
    if (i < 36) {
      for (let j = 1; j <= 14; j++) {
        const s = i * 14 + (j - 1);
        if (s >= 21 && s <= 504) p[j] = FLOWER_PATTERN[s - 21];
      }
    }
    frames.push(buildFrame(CMD_COLOR, SUBCMD_PALETTE, i, p));
  }
  return frames;
}

// 默认调色板：每键区 [21..293] 填 91 键色相渐变（花开富贵/梦幻彩虹/旋转风车/七彩瀑布等
// 无自定义色效果读每键表——残留单色表 = 单色频闪（真机复现），零表 = 黑）。
// 流结构与 buildPalette 相同（帧 i p[j] = 流偏移 i*14+j-1，帧36 尾不变）。
export function buildPaletteDefault() {
  const frames = [];
  for (let i = 0; i < 37; i++) {
    const p = [...(i === 36 ? PAL_LAST : PAL_ZEROS)];
    if (i < 36) {
      for (let j = 1; j <= 14; j++) {
        const s = i * 14 + (j - 1);
        if (s >= 21) {
          const k = Math.floor((s - 21) / 3);
          p[j] = hsvRgb(k * 360 / 161)[(s - 21) % 3];
        }
      }
    }
    frames.push(buildFrame(CMD_COLOR, SUBCMD_PALETTE, i, p));
  }
  return frames;
}

// 调色板 37 片：payload 流（帧 i 的 p[1..14] = 流偏移 i*14 + j-1）线性映射到固件
// 8a 每键表——帧1 p8 = 流 21 = 表[21]（全局自定义色槽 R，真机校准）。因此自定义色
// 必须**从流偏移 21 起整片灌 RGB 连续模式**（表[21..293] 每键区），否则清零模板会把
// 每键区清空 → 呼吸等读每键区的效果全灭（.7-.10 三轮真机复现）。帧1 p12=0xff 为
// 自定义色启用标志（AULA 逆向，03:44 真机 steady 验证沿用）。
export function buildPalette(colorRgb) {
  const frames = [];
  for (let i = 0; i < 37; i++) {
    const p = [...(i === 36 ? PAL_LAST : PAL_ZEROS)];
    if (colorRgb && i < 36) {
      for (let j = 1; j <= 14; j++) {
        const s = i * 14 + (j - 1);
        if (s >= 21) p[j] = colorRgb[s % 3];
      }
      if (i === 1) p[12] = 0xff;
    }
    frames.push(buildFrame(CMD_COLOR, SUBCMD_PALETTE, i, p));
  }
  return frames;
}

// 每键 RGB（28 片：R/G/B 三平面 × 9 + 尾片）。keyColors: {ledIndex: [r,g,b]}
export function buildPerKey(keyColors, maxLed = 126) {
  const R = new Uint8Array(maxLed), G = new Uint8Array(maxLed), B = new Uint8Array(maxLed);
  for (const [idx, rgb] of Object.entries(keyColors)) {
    const i = +idx;
    if (i >= 0 && i < maxLed) { R[i] = rgb[0]; G[i] = rgb[1]; B[i] = rgb[2]; }
  }
  const frames = [];
  let seq = 0;
  for (const plane of [R, G, B]) {
    for (let s = 0; s < 9; s++) {
      const p = new Uint8Array(15);
      p[0] = 0x0e;
      for (let j = 0; j < 14; j++) p[1 + j] = plane[s * 14 + j];
      frames.push(buildFrame(CMD_PERKEY, SUBCMD_PERKEY, seq++, p));
    }
  }
  const t = new Uint8Array(15);
  t[0] = 0x06; t[3] = 0x5a; t[4] = 0xa5;
  frames.push(buildFrame(CMD_PERKEY, SUBCMD_PERKEY, seq, t));
  return frames;
}

export function buildSave() {
  return buildFrame(CMD_SAVE, SUBCMD_CONFIRM, 0, [0x04, 0x07]);
}

// 写配置 10 片：base=读取到的 10 片（或模板），patch 见下
// seq0 payload 布局（依据原驱动 FillCfg 反汇编）：[2]/[3]=去抖档(原驱动两处写同值) [4]=确认位(报文[8], 须 0x01)
//   [8]=Tap 灵敏度档(原驱动按键页 Tap 页签下的「灵敏度」tc_kb12, 出厂模板 0x04, 档位范围未证实)
//   [9]=睡眠档位索引(报文[13]) [11]=效果号(报文[15]) [13]=色彩模式(报文[17], 1自定义/3默认)
export function buildConfigWrite(baseFrames, { effect, colorMode, brightness, speed, colorful, debounce, sleepIndex, tapSens, colorRgb, clearColor, animMode, selfFwNote }) {
  const frames = [];
  const [tgtSeq, tgtOff] = effect != null ? effectTableLoc(effect) : [null, null];
  for (let s = 0; s < 10; s++) {
    let f;
    if (baseFrames) {
      f = Uint8Array.from(baseFrames[s]);
      f[1] = CMD_WRITE;
    } else {
      const p = [...CFG_TEMPLATE[s]];
      if (s === 0) { p[4] = animMode ? 0x02 : 0x01; p[10] = 0x00; }
      if (s === 9) { p[3] = 0; p[4] = 0; p[5] = 0xff; }  // 模板第9片给默认蓝（真值由 colorRgb 覆盖）
      f = buildFrame(CMD_WRITE, SUBCMD_CONFIG, s, p);
    }
    if (s === 0) {
      if (debounce != null) { f[6] = debounce - 1; f[7] = debounce - 1; }  // payload[2]/[3] = 去抖档
      if (sleepIndex != null) f[13] = sleepIndex;                          // payload[9] = 睡眠档位
      if (tapSens != null) f[12] = tapSens;                                // payload[8] = Tap 灵敏度档
      // blob[3]（帧字节 8）= 渲染模式：01=普通效果，02=动画模式。真机对照：官方驱动
      // 选花开富贵时 blob[3] 01→02 且表写入花色才正常；带 01 时固件走普通渲染 → 蓝色兜底
      f[8] = animMode ? 0x02 : 0x01;
      f[14] = 0x00;                                                        // apply 标志必须写 0
      if (effect != null) f[15] = effect;
      if (colorMode != null) f[17] = colorMode;
    }
    // 第 9 片 payload idx3-5（帧字节 7-9）= 自定义色 RGB——真机确证：
    // 原驱动设纯蓝后 0x44 读回第 9 片为 [02 5a a5 00 00 ff …]，00 00 ff 即纯蓝。
    // clearColor：无自定义色效果主动清零（保留原值会让残留色跟着配置走——
    // 花开富贵读它 → 残留蓝全盘频闪，真机复现）
    if (s === 9) {
      if (colorRgb) { f[7] = colorRgb[0]; f[8] = colorRgb[1]; f[9] = colorRgb[2]; }
      else if (clearColor) { f[7] = 0; f[8] = 0; f[9] = 0; }
    }
    if (tgtSeq === s && brightness != null) {
      f[tgtOff] = brightness;
      const cur = decodeSpeedByte(f[tgtOff + 1]);
      f[tgtOff + 1] = encodeSpeedByte(speed ?? cur.speed, colorful ?? cur.colorful);
    }
    // 动画模式参数补丁（真机对照官方驱动）：帧6 载 blob[84..97]，花开富贵需
    // [87..91] = 47 04 47 04 47（官方完整参数向量；须在亮度/速度写之后、校验和之前——
    // 否则会被 effectTableLoc 的写入覆盖）
    if (animMode && s === 6) { f[8] = 0x47; f[9] = 0x04; f[10] = 0x47; f[11] = 0x04; f[12] = 0x47; }
    f[19] = checksum(f);
    frames.push(f);
  }
  void selfFwNote;
  return frames;
}
