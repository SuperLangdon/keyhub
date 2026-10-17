// AULA/LEOBOG 同源 SINO WEALTH 固件的 HID 报文协议（逆向自同 VID/PID 硬件的开源实现）
// 20 字节 output report：[0]=0x13 [1]=cmd [2]=总帧数 [3]=帧号 [4..18]=payload [19]=校验和（Send13 语义，f[2] 非"子命令"）
export const REPORT_ID = 0x13;
export const CMD_READ = 0x44;
export const CMD_WRITE = 0x04;
export const CMD_COLOR = 0x09;
export const CMD_PERKEY = 0x02;
export const CMD_SAVE = 0x0A;
export const CMD_BATTERY = 0x4A; // 电量（只读，无线通道）：响应 payload[0]=oper|len(=0x02) payload[1]=百分比 payload[2]=状态标志
// 帧[2] 的值 = 本块总帧数（旧名 SUBCMD_* 有误导性，2026-10 更名）：配置 10 片 / 调色板 37 片 / 每键 28 片 / 保存 1 片
export const NFRAMES_CONFIG = 10;
export const NFRAMES_PALETTE = 37;
export const NFRAMES_PERKEY = 28;
export const NFRAMES_CONFIRM = 1;

export const WIRED = { vid: 0x258a, pid: 0x010c };
export const WIRELESS = { vid: 0x3554, pid: 0xfa09 };

// ---------- 设备族：各代硬件的 VID/PID（来自各驱动 KB.ini 的 VID/PID(_Wireless)）----------
// LEOBOG 全系共用一对（有线 258a:010c + 2.4G 接收器 3554:fa09）；
// 银雕 K65（BYCOMBO 同平台）有线 258a:019d，2.4G 是键盘本体 258a:0150（无独立接收器 PID）。
// requestDevice 过滤、channelOf 通道判别、knownDevices 收编都以这张表为准。
// 这是**内置兜底表**：connect.js 的 modelIndex() 加载注册表后会调 rebuildDeviceFamilies()
// 按各型号 index 条目的 wired/wireless 原地重建本表——社区贡献新 VID/PID 型号合并后
// 即插即连，无需改任何代码。
export const DEVICE_FAMILIES = [
  { name: 'LEOBOG', wired: WIRED, wireless: WIRELESS },
  { name: 'YINDIAO K65', wired: { vid: 0x258a, pid: 0x019d }, wireless: { vid: 0x258a, pid: 0x0150 } },
];

// 注册表 → 设备族表：有线或无线任一侧 VID/PID 与既有族相同即并入（纯有线型号如
// hi98 与三模同族），name 取族内型号 slug 列表（仅调试/文案展示）。
// 返回 false 表示数据不可用（保留内置表兜底）。
export function rebuildDeviceFamilies(models) {
  if (!Array.isArray(models) || !models.length) return false;
  const same = (a, b) => !!a && !!b && a.vid === b.vid && a.pid === b.pid;
  const fams = [];
  for (const m of models) {
    if (!m?.wired && !m?.wireless) continue;
    let fam = fams.find((f) => same(f.wired, m.wired) || same(f.wireless, m.wireless));
    if (!fam) { fam = { names: [], wired: m.wired ?? null, wireless: m.wireless ?? null }; fams.push(fam); }
    else {
      // 并族时补齐缺失侧：纯有线型号先入族、后续同 VID/PID 三模型号并入时，
      // 无线 PID 必须带上——否则 requestDevice 过滤会漏掉 2.4G 接收器
      if (!fam.wired && m.wired) fam.wired = m.wired;
      if (!fam.wireless && m.wireless) fam.wireless = m.wireless;
    }
    fam.names.push(m.slug ?? m.short ?? '?');
  }
  if (!fams.length) return false;
  DEVICE_FAMILIES.length = 0;
  for (const f of fams) DEVICE_FAMILIES.push({ name: f.names.join('+'), wired: f.wired, wireless: f.wireless });
  return true;
}
// 通道 → VID/PID 候选列表（wired/wireless 只取对应列，any 两者都给）
export function idsForChannel(channel) {
  const all = [];
  for (const fam of DEVICE_FAMILIES) {
    if (channel !== 'wireless' && fam.wired) all.push(fam.wired);
    if (channel !== 'wired' && fam.wireless) all.push(fam.wireless);
  }
  return all;
}

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

// ---------- K65 变体 520B 帧（银雕 fw26；逆向自 K65 版 OemDrv 0x493360）----------
// 驱动里存在这套 cmd@2 + 校验和的 exchanger：[9][ck][cmd][sub][块数][seq][lenLo][lenHi][data@8]，
// ck = 字节 2..519 累加。但真机实证（2026-10 日志）：灯光/识别通道**不走它**——固件按
// legacy 布局（cmd@1、无校验）在 report 9 上应答，GetPSD 用 legacy 格式成功取回
// PSD = 06 00 00 00 00 37。此构造器保留作驱动行为记录，网页端发帧一律用 legacy 布局。
export function feat520ChecksumK65(frame) {
  let ck = 0;
  for (let i = 2; i < FEAT520_LEN; i++) ck = (ck + frame[i]) & 0xff;
  return ck;
}
export function buildFeat520FrameK65(cmd, sub, seq, dataLen, payload, chunks = 1) {
  const f = new Uint8Array(FEAT520_LEN);
  f[0] = 9; f[2] = cmd; f[3] = sub; f[4] = chunks; f[5] = seq & 0xff;
  f[6] = dataLen & 0xff; f[7] = (dataLen >> 8) & 0xff;
  if (payload) for (let i = 0; i < 512 && i < payload.length; i++) f[FEAT520_DATA_OFF + i] = payload[i];
  f[1] = feat520ChecksumK65(f);
  return f;
}

// ---------- film 屏幕烧录（2026-10 REA/IDA Pro 实证：K65 版 OemDrv.exe，sha256 635587cf…）----------
// 屏幕走 feat520 通道（与灯光有线管线同一接口、同一 report id；驱动 AccessData 0x48EF20 /
// AccessData_Page 0x492490 均 HidD_SetFeature/GetFeature 520B，无校验字节）。
// 像素数据帧（cmd 0x0C，AccessData_Page 0x492490）：[rid][0C][00][帧序号][包序][00][len16LE][≤512B]
//   —— 帧序号在 [3]、包序号在 [4]（与通用帧的 [3]=sub/[4]=nPkgs 槽位复用，布局不同！）
// GIF 参数帧（cmd 0x0D，CDevG5KB::SetGIFParam 0x492830）：通用布局，载荷 8 字节 =
//   [0]=gifIndex|op<<6（op: 1=开始 2=取消收尾 0=正常收尾）[1..2]=帧数 u16LE [3..4]=延时 u16LE(ms)
//   [5..6]=0 u16 [7]=0；发送后 GET 回读校验（应答数据 @8）。
export const FILM_CMD_PAGE = 0x0C;   // 像素数据
export const FILM_CMD_PARAM = 0x0D;  // SetGIFParam
export function buildFilmDataReport(rid, frameIdx, pkgSeq, chunk) {
  const f = new Uint8Array(FEAT520_LEN);
  f[0] = rid; f[1] = FILM_CMD_PAGE; f[2] = 0;
  f[3] = frameIdx & 0xff; f[4] = pkgSeq & 0xff; f[5] = 0;
  f[6] = chunk.length & 0xff; f[7] = (chunk.length >> 8) & 0xff;
  f.set(chunk, FEAT520_DATA_OFF);
  return f;
}
export function buildGifParamPayload(gifIndex, op, frameCount, delayMs) {
  const p = new Uint8Array(8);
  p[0] = (gifIndex & 0x3f) | ((op & 0x03) << 6);
  p[1] = frameCount & 0xff; p[2] = (frameCount >> 8) & 0xff;
  p[3] = delayMs & 0xff; p[4] = (delayMs >> 8) & 0xff;
  return p;
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
    frames.push(buildFrame(CMD_READ, NFRAMES_CONFIG, s, p)); // 用 0x44 头，写侧 buildConfigWrite 会改
  }
  // 第 9 片：payload[0]=02 标记，[1..14]=blob[126..139]（含 5a a5 与自定义色 RGB@blob[128..130]）
  const p9 = new Uint8Array(15);
  p9[0] = 0x02;
  for (let i = 0; i < 14; i++) p9[1 + i] = blob[126 + i] ?? 0;
  frames.push(buildFrame(CMD_READ, NFRAMES_CONFIG, 9, p9));
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

export function buildFrame(cmd, nFrames, seq, payload) {
  const f = new Uint8Array(20);
  f[0] = REPORT_ID; f[1] = cmd; f[2] = nFrames & 0xff; f[3] = seq & 0xff;
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

// 键位层下发长度与末槽标记（2026-10 K65 版 OemDrv FillMatrix 0x490D10 实证）：
//   每层缓冲 = 4×MatrixLen 字节（KB.ini MatrixLen，缺省 128——不是 max(matrix)+1！）；
//   CRC=1 的型号（K65）每层最后一个 dword 强制 0xA5A5A5A5（`*(尾-4) = 0xA5A5A5A5`）。
//   槽数不足时补零读回值（调用方先读回再补丁，保真未指派槽）。
export const MATRIX_DEFAULT_LEN = 128;
export function padMatrixDwords(dwords, matrixLen, crc) {
  const n = Math.max(dwords.length, matrixLen | 0);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = (dwords[i] ?? 0) >>> 0;
  if (crc) out[n - 1] = 0xa5a5a5a5;
  return out;
}

// ---------- 电量查询（K65 版 OemDrv 2026-10 REA 实证）----------
// CDevG5MS::GetPower @0x4946E0：feat520 **report 9 + 校验和布局**（cmd@2 + ck=Σ字节2..519，
// 即 buildFeat520FrameK65）：[09][ck][cmd=0x09][sub=0x01][块数=01][seq=00][len=01][00]。
// 应答 HidD_GetFeature(9)：数据@偏移 8 共 1 字节 = 电量百分比，应答 buf[2] 须回显 cmd 0x09；
// ×3 重试，间隔 60ms。仅无线连接时驱动调用（SyncCfg 通道==2；有线恒显 100%）。
// 走 usagePage 0xFF02/usage 2 的 vendor collection（与灯光 feat520 同一 520B feature 能力）。
// 注意：0x13 cmd 0x4A 在本代驱动是 GetOnBoard（板载配置档号，CDev3632::GetOnBoard @0x48a310
// SendCMD(74,0,&v,1)），不是电量——LEOBOG 世代的 0x4A 电量结论不能平移到 K65。
export const BATTERY_CMD_K65 = 0x09;
export const BATTERY_SUB_K65 = 0x01;

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
// 数字行（真机仲裁 2026-10-17 Hi98 Pro 有线键位 dump）：'1'-'9'→0x1E-0x26，'0'→0x27
// （旧表 0x30+i→0x1e+i 整体错位一键，把 '0' 映到了 '1' 的 usage）
for (let i = 0; i < 9; i++) VK2HID.set(0x31 + i, 0x1e + i);         // 1-9 → 0x1E-0x26
VK2HID.set(0x30, 0x27);                                              // 0 → 0x27
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

// 事件 4 字节编码：[类型<<4|延时高4位|0x80(仅延时==0)] [延时>>8] [延时&0xff] [usage]
// 0x80 语义（2026-10 K65 版驱动 StMacro_To_HdMacro 0x490940 实证修正，替换早前"0x80=按下"的推断）：
//   0x80 ⟺ 延时==0 且 类型∉{滚轮,多媒体,移动}（0x490940: `if (v12!=3 && v12!=4 && v12!=5 && delay==0) b0|=0x80`），
//   即"零延时的即发事件"标志；滚轮/多媒体/移动类恒不带。延时 = 录制事件自带的毫秒
//（按下=按住时长，释放=距下一事件的等待），超 0xFFFFF 钳到 0xFFFFF。
export function encodeMacroEvent(type, usage, delayMs, press = false) {
  void press; // 兼容旧签名：0x80 不再由按下/释放决定（见上）；调用方不必传
  const d = Math.max(0, Math.min(0xfffff, Math.round(delayMs)));
  const instant = d === 0 && type !== MAC_EV_WHEEL && type !== MAC_EV_CONSUMER && type !== MAC_EV_MOVE;
  const b0 = ((type << 4) | ((d >> 16) & 0x0f) | (instant ? 0x80 : 0)) & 0xff;
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
      out.push(...encodeMacroEvent(type, usage, hold));
    } else {
      // 释放后等待：距下一个任意按下事件的时间
      let wait = 0;
      for (let j = i + 1; j < evs.length; j++) {
        if (evs[j].kind === 'dn') { wait = Math.max(0, evs[j].at - e.at); break; }
      }
      out.push(...encodeMacroEvent(type, usage, wait));
    }
  }
  return Uint8Array.from(out);
}

// 宏下载 blob（逆向自 BuildMacroBlob 0x492a40 / 打包器 0x493590；K65 版复核 0x490D10）：
//   [索引表 n×4B：{u16 addr(相对数据区), u16 size(含名长)}][数据区]
//   数据区每条宏 = [名字节数 1B][名字 UTF-16LE][事件流 4B×k]
//   表在 blob 头部（驱动总装时 addr 统一 +表长重定位），count 由调用方另行记录
//   名字上限 30 字符（驱动 wcsnlen(…, 0x1E) 截断，2026-10 K65 版实证）
export function buildMacroBlob(macros) {
  const datas = [];
  let dataLen = 0;
  const table = [];
  for (const m of macros) {
    const nameBytes = Uint8Array.from(
      [...String(m.name ?? '').slice(0, 30)].flatMap((ch) => {
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

// ---------- 改键 dword 全量编码（逆向自 OemDrv.exe keyinfo_to_hardware_code@0x491f90，2026-10 REA 复核）----------
// 键位矩阵每键 4 字节。UI 功能 {type, code, param} → 固件 dword。规则三重实证（反汇编 +
// KB.ini 默认值 + 2026-10-17 Hi98 Pro 有线真机 4 层键位 dump 逐槽比对）：
//   type-1 常用命令：查表 CMD_HW；0x14/0x15 部分型号互换（驱动按 KB.ini 能力位 0x492021 特判，此处取默认）
//   type-2 普通键：dword = hid(code)<<24（真机：A→0x04000000、'1'→0x1E000000、'0'→0x27000000）
//   type-2 修饰键（hid 0xE0-0xE7）：dword = 位图<<8（真机：LShift→0x0200、RShift→0x2000、LCtrl→0x0100、
//     LAlt→0x0400、LWin→0x0800、RCtrl→0x1000 —— 即 HID 修饰键位图 bit0-5，非 usage<<24）
//   type-2 组合键：hid<<24 | mods<<8（mods 为 HID 修饰位图；我们 UI 只有单键+修饰，驱动双键位 vk2 恒 0）
//   FN(0xFA)→0x0D、0xFB→0x10D
//   type-2 鼠标(1-5)：直接透传 param（驱动 case-2 同款；A75 KB.ini K65 实证鼠标左=0x05000000）
//   type-9 多媒体/灯光：param 字节序反转 [b0][b1][b2][b3]（sub_465EF0@0x465ef0；真机 FN 层 27 键实证：
//     0x020000B6→0xB6000002、0x08030200→0x00020308、0x07000004→0x04000007）
//   type-0x0A 宏：macroKeyDword（下载序号 = ctx.macroOrder 数组下标，与 BuildMacroBlob 的 id-1 同基）
// 无编码返回 null（调用方跳过并计数）：复位键盘(0x1d)是主机侧全局操作；鼠标 6-9（前进/后退/
// 下滚/双击）在驱动 case-2 无 1-5 外的透传路径且值域无样本——待真机校准后放开。
// 已知型号数据边界（Hi98 Pro 实测）：小键盘簇/Home/End 不在线键位表（numpad usage 全表无踪，
// 槽 100+ 全零），KB.ini 第 8 列对这批键给出的槽位（97-110）实为 Esc/'/'/Tab/CapsLock 的重复
// 映射区——改键下发会写这些槽但可能不生效，属型号数据局限而非编码错误。
export const CMD_HW = {
  0x11: 0x00010101, 0x13: 0x00010201, 0x12: 0x00010301, 0x14: 0x00010401, 0x15: 0x00010501,
  0x19: 0x00000801, 0x1a: 0x00000901, 0x16: 0x32020101, 0x17: 0x32030101,
  0x1b: 0x32ff0701, // 锁Win键
  0x1c: 0x32ff0601, // 锁键盘
};

export function fnToDword(fn, ctx = {}) {
  if (!fn || typeof fn.type !== 'number') return null;
  const { type, code } = fn;
  const p = (fn.param ?? 0) >>> 0;
  if (type === 0x0A) {
    if (!Array.isArray(ctx.macroOrder)) return null;
    const idx = ctx.macroOrder.findIndex((m, i) => (m?.id ?? i) === fn.param);
    if (idx < 0) return null;
    return macroKeyDword(idx, fn.rep ?? 1, fn.loopCode ?? MACRO_LOOP_CODES.once);
  }
  if (type === 0x01) {
    const hw = CMD_HW[code];
    return Number.isInteger(hw) ? hw >>> 0 : null;
  }
  if (type === 0x02) {
    if (code === 0x00 && p === 0x01) return 0xffffffff; // 「无功能」（驱动 0x18 禁用 → -1）
    let mods = (p >>> 8) & 0xff;
    if (!mods && code === 0xfa) return 0x0000000d; // FN
    if (!mods && code === 0xfb) return 0x0000010d;
    if (code >= 1 && code <= 5 && p) return p; // 鼠标 L/R/M/上滚：驱动透传 param
    if (code >= 6 && code <= 9 && p) return null; // 值域未证实，跳过待校准
    const hid = VK2HID.get(code);
    if (hid == null) return null;
    if (hid >= 0xe0 && hid <= 0xe7) {
      // 修饰键作主键：HID 修饰位图 bit0-5 落 byte[1]（真机六键实证），可与组合键 mods 合并
      mods |= 1 << (hid - 0xe0);
      return (mods << 8) >>> 0;
    }
    return ((hid << 24) | (mods << 8)) >>> 0;
  }
  if (type === 0x09) {
    const b0 = p & 0xff, b1 = (p >>> 8) & 0xff, b2 = (p >>> 16) & 0xff, b3 = (p >>> 24) & 0xff;
    return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  }
  return null;
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

// 睡眠档位表（分钟）：fw24 世代（LEOBOG）按"索引"写入 payload[9]（blob[8]）——本表沿用早前
// 逆向结论，档位→分钟数值未经逐档实测。fw26 世代（K65 版 OemDrv 2026-10 REA）实证不同：
// FillCfg 0x491430 写 a1[24]（= blob[24]，slice1 payload[11]），值 = SleepHW 映射——KB.ini 无
// SleepUI/SleepHW 行时驱动内置 UI=[30..1200] 分钟、HW=分钟/30。旧定位 blob[8]=07 实为出厂
// 模板常量（模板 slice0 固定 07），并非睡眠档。
export const SLEEP_LEVELS = [0, 1, 5, 10, 15, 20, 30, 60, 120];
export const SLEEP_DEFAULT_UI = [30, 60, 90, 120, 180, 240, 300, 600, 900, 1200];
export const SLEEP_DEFAULT_HW = SLEEP_DEFAULT_UI.map((m) => m / 30);
export const sleepIndexOf = (minutes) => {
  let best = 0;
  for (let i = 0; i < SLEEP_LEVELS.length; i++) {
    if (Math.abs(SLEEP_LEVELS[i] - minutes) < Math.abs(SLEEP_LEVELS[best] - minutes)) best = i;
  }
  return best;
};
// 型号睡眠表：优先 model.sleepUI/sleepHW（KB.ini 转换产物），否则按固件代际取内置表
export function modelSleepTable(model) {
  if (Array.isArray(model?.sleepUI) && model.sleepUI.length) {
    const hw = Array.isArray(model.sleepHW) && model.sleepHW.length === model.sleepUI.length
      ? model.sleepHW : model.sleepUI.map((_, i) => i); // 缺 HW 行 → 索引（与 fw24 写索引行为一致）
    return { ui: model.sleepUI, hw };
  }
  return model?.fw === 24
    ? { ui: SLEEP_LEVELS, hw: SLEEP_LEVELS.map((_, i) => i) }
    : { ui: SLEEP_DEFAULT_UI, hw: SLEEP_DEFAULT_HW };
}
// 就近匹配分钟 → 档位索引（对 modelSleepTable 的 ui 表）
export function sleepUiIndexOf(table, minutes) {
  const ui = table?.ui ?? SLEEP_LEVELS;
  let best = 0;
  for (let i = 0; i < ui.length; i++) {
    if (Math.abs(ui[i] - minutes) < Math.abs(ui[best] - minutes)) best = i;
  }
  return best;
}
// 型号亮度映射：UI 档 → LightHW 硬件值。K65 = Light[0,1,2,3,4] → LightHW[1,5,10,15,20]
//（驱动 FillCfg 写 *(LightHW + UI档)，直写 UI 档会让灯近乎最暗——2026-10 REA 修正）；
// fw24 无 LightHW 行 → 驱动回退恒等（直写 UI 档即正确，LEOBOG 真机验证一致）。
export function modelLightHw(model) {
  return Array.isArray(model?.brightnessHw) && model.brightnessHw.length ? model.brightnessHw : null;
}
export const lightHwOf = (model, level) => {
  const tab = modelLightHw(model);
  if (!tab) return level;
  return tab[Math.max(0, Math.min(tab.length - 1, level))] ?? level;
};
// 配置代际：fw24（LEOBOG，本文件历史字段布局）| fw26（K65 版 OemDrv FillCfg 实证布局）。
// 未知/无型号默认 fw24（历史行为），仅明确非 24 的已知固件走 fw26。
export const cfgGenOf = (model) => (model?.fw != null && model.fw !== 24 ? 'fw26' : 'fw24');

// 效果 N 的 [片序号, 报文内偏移]（亮度字节；其后一字节为速度字节）
export function effectTableLoc(n) {
  if (n >= 1 && n <= 6) return [4, 7 + (n - 1) * 2];
  if (n >= 7 && n <= 13) return [5, 5 + (n - 7) * 2];
  if (n >= 14 && n <= 18) return [6, 5 + (n - 14) * 2];
  return [4, 7];
}

export const encodeSpeedByte = (speed, colorful) => ((speed & 0xf) << 4) | (colorful ? 0x07 : 0x00);
export const decodeSpeedByte = (b) => ({ speed: (b >> 4) & 0xf, colorful: (b & 0xf) === 0x7 });

// 从 10 片读取结果中解析当前配置（frames 为 20 字节完整报文）。
// gen='fw26'（K65 版驱动实证）：去抖=blob[3]（单字节 UI 值）、Tap=blob[22]、睡眠=blob[24]
//（SleepHW 值，经 modelSleepTable 反查分钟）；fw24 维持历史布局（blob[1,2]/blob[7]/blob[8]）。
export function parseConfig(frames, model = null) {
  try {
    const s0 = frames[0];
    const gen = cfgGenOf(model);
    const effect = s0[15]; // 效果字节 = UI 号（两代同域；§11.5 的 fw 号判断系偏移误读，已回滚）
    const blob = (s) => frames[s].slice(5, 19); // payload[1..14] = blob[s*14 .. s*14+13]
    let db = s0[6], tapSens = s0[12], sleepIdx = s0[13], sleepMin = null;
    if (gen === 'fw26') {
      const b1 = blob(1); // blob[14..27]
      db = s0[8];                 // blob[3] = 去抖 UI 值（单字节）
      tapSens = b1[8];            // blob[22]
      const sleepHw = b1[10];     // blob[24]
      const tbl = modelSleepTable(model);
      let best = 0;
      for (let i = 0; i < tbl.hw.length; i++) {
        if (Math.abs(tbl.hw[i] - sleepHw) < Math.abs(tbl.hw[best] - sleepHw)) best = i;
      }
      sleepIdx = best;
      sleepMin = tbl.ui[best] ?? null;
    } else {
      sleepMin = sleepIdx >= 0 && sleepIdx < SLEEP_LEVELS.length ? SLEEP_LEVELS[sleepIdx] : null;
    }
    return {
      effect,
      colorMode: s0[17],
      debounce: db <= 4 ? db + (gen === 'fw26' ? 0 : 1) : db, // fw24 存档-1；fw26 存 UI 值原值
      tapSens,
      sleepIdx,
      sleepMin,
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
    frames.push(buildFrame(CMD_COLOR, NFRAMES_PALETTE, i, p));
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
    frames.push(buildFrame(CMD_COLOR, NFRAMES_PALETTE, i, p));
  }
  return frames;
}

// 调色板 37 片：payload 流（帧 i 的 p[1..14] = 流偏移 i*14 + j-1）线性映射到固件
// 8a 每键表——帧1 p8 = 流 21 = 表[21]（全局自定义色槽 R，真机校准）。因此自定义色
// 必须**从流偏移 21 起整片灌 RGB 连续模式**（表[21..293] 每键区），否则清零模板会把
// 每键区清空 → 呼吸等读每键区的效果全灭（.7-.10 三轮真机复现）。帧1 p12=0xff 为
// 自定义色启用标志（AULA 逆向，03:44 真机 steady 验证沿用）——**K65 同样必需**：
// 2026-10-18 曾按"官方 SetLedRgbTab 无此字节"推测去掉，真机立即出现全效果选色失效，
// 当日回滚（固件对该字节的实际语义未明，按实证保留）。
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
    frames.push(buildFrame(CMD_COLOR, NFRAMES_PALETTE, i, p));
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
      frames.push(buildFrame(CMD_PERKEY, NFRAMES_PERKEY, seq++, p));
    }
  }
  const t = new Uint8Array(15);
  t[0] = 0x06; t[3] = 0x5a; t[4] = 0xa5;
  frames.push(buildFrame(CMD_PERKEY, NFRAMES_PERKEY, seq, t));
  return frames;
}

// 与驱动的已知差异（有意保留）：SetOnBoard@0x48bd80 只发 1 字节载荷（帧 [13 0a 01 00 01 <byte>]，
// byte 值经纯虚调用未能定位）；本实现发 [04 07]——f[5]=0x07 与驱动语义位一致，仅 f[4] 长度
// 指针不同（0x04 vs 0x01）。真机验证保存可用（多轮回归），改成单字节形反而要对 byte 值瞎猜，不动。
export function buildSave() {
  return buildFrame(CMD_SAVE, NFRAMES_CONFIRM, 0, [0x04, 0x07]);
}

// 写配置 10 片：base=读取到的 10 片（或模板），patch 见下
// seq0 payload 布局（依据原驱动 FillCfg 反汇编）：[2]/[3]=去抖档(原驱动两处写同值) [4]=确认位(报文[8], 须 0x01)
//   [8]=Tap 灵敏度档(原驱动按键页 Tap 页签下的「灵敏度」tc_kb12, 出厂模板 0x04, 档位范围未证实)
//   [9]=睡眠档位索引(报文[13]) [11]=效果号(报文[15]) [13]=色彩模式(报文[17], 1自定义/3默认)
// gen='fw26'（K65 版 OemDrv FillCfg 0x491430 实证, 2026-10 REA）字段布局不同：
//   效果字节 blob[10] = **UI 号**（两代同域。§11.5 曾误判为 fw 固件号——LedOpt 行布局实为
//   [使能,fw,ui,...]，FillCfgB 取行+2=ui 列，解析器偏移读错一位；真机写 fw 号后全乱已回滚）
//   去抖 = blob[3]（单字节 UI 值；blob[1,2] 为出厂常量对，读改写保持不动）
//   Tap = blob[22]（slice1 payload[9]）  睡眠 = blob[24]（slice1 payload[11]）值 = sleepHw 直写
//   animMode 的 blob[3]=02 不写（该字节在 fw26 是去抖域；K65 花开富贵走表驱动，帧6 参数照旧）
// lightHw：UI 亮度档 → 硬件值映射表（K65 [1,5,10,15,20]）；缺省恒等（fw24 真机验证直写 UI 档正确）
// knobCustom：旋钮模式（仅 wheel.mode>0 型号；驱动 FillCfg 变体 B 的 Cfg[26]=nWheelMode——
//   旋钮键被改键→6=自定义（固件当普通键），否则 0。Cfg[k]=帧字节 5+k，切片≥1 时与
//   payload[k-14s+1] 同字节（无 slice-0 的一字节歧义）：Cfg[26]=slice1 payload[13]
// 侧灯不做：驱动确有 SideLED 配置分支（"SideLED: mode=%d…" 日志串），但全 9 个 KB.ini 均无
//   侧灯键（仅 Hi75 有 ShowLED=0 显式关）——官方未对任何型号开放，实物侧灯条若存在则由
//   主 RGB 矩阵驱动（每型号矩阵槽 > 可见键数，槽 83/85-89 未占），现有每键 RGB 已可达。
export function buildConfigWrite(baseFrames, { effect, colorMode, brightness, speed, colorful, debounce, sleepIndex, sleepHw, tapSens, colorRgb, clearColor, animMode, knobCustom, selfFwNote, gen = 'fw24', lightHw = null }) {
  const frames = [];
  // 效果字节(blob[10])与参数槽索引(blob[58+2i], i=ui-1)都用 **UI 号**——2026-10-18 真机
  // 大规模回归确证：固件效果域 = UI 1-18(LedMask 隐藏的 6/14/18 固件没有)+21 自定义+0 关。
  //（曾误判为 fw 固件号：LedOpt 行布局实为 [使能,fw,ui,...]，FillCfgB 取行+2=ui 列——
  //  解析器偏移读错一位所致；写 fw 号后 ui8→16 渲染成瀑布、ui12→17 渲染成花开富贵等全乱，
  //  已回滚并在真机逐效果验证 UI 号正确。）
  const [tgtSeq, tgtOff] = effect != null ? effectTableLoc(effect) : [null, null];
  const fw26 = gen === 'fw26';
  for (let s = 0; s < 10; s++) {
    let f;
    if (baseFrames) {
      f = Uint8Array.from(baseFrames[s]);
      f[1] = CMD_WRITE;
    } else {
      const p = [...CFG_TEMPLATE[s]];
      if (s === 0) { p[4] = animMode && !fw26 ? 0x02 : 0x01; p[10] = 0x00; }
      if (s === 9) { p[3] = 0; p[4] = 0; p[5] = 0xff; }  // 模板第9片给默认蓝（真值由 colorRgb 覆盖）
      f = buildFrame(CMD_WRITE, NFRAMES_CONFIG, s, p);
    }
    if (s === 0) {
      if (debounce != null) {
        if (fw26) {
          f[8] = debounce;                    // blob[3] = 去抖 UI 值（驱动同款单字节）
        } else {
          f[6] = debounce - 1; f[7] = debounce - 1;  // payload[2]/[3] = 去抖档
        }
      }
      if (!fw26 && sleepIndex != null) f[13] = sleepIndex;               // payload[9] = 睡眠档位
      if (!fw26 && tapSens != null) f[12] = tapSens;                     // payload[8] = Tap 灵敏度档
      // blob[3]（帧字节 8）= 渲染模式：01=普通效果，02=动画模式（仅 fw24）。真机对照：官方驱动
      // 选花开富贵时 blob[3] 01→02 且表写入花色才正常；带 01 时固件走普通渲染 → 蓝色兜底
      if (!fw26) f[8] = animMode ? 0x02 : 0x01;
      f[14] = 0x00;                                                        // apply 标志必须写 0
      if (effect != null) f[15] = effect;
      // 色彩模式（blob[12]，1 自定义/3 默认）——两代都写（真机回归教训：fw26 停写会让设备
      // 卡在历史值（如旧写入的 1）且无法自愈，2026-10-18 回滚为始终写，恢复最初可用行为）。
      if (colorMode != null) f[17] = colorMode;
    }
    if (fw26 && s === 1) { // slice1 = blob[14..27]：Tap=blob[22]、睡眠=blob[24]（驱动实证）
      if (tapSens != null) f[13] = tapSens;   // blob[22] = slice1 payload[9]
      if (sleepHw != null) f[15] = sleepHw;   // blob[24] = slice1 payload[11]
    }
    // 第 9 片 payload idx3-5（帧字节 7-9）= 自定义色 RGB——fw24 真机确证：
    // 原驱动设纯蓝后 0x44 读回第 9 片为 [02 5a a5 00 00 ff …]，00 00 ff 即纯蓝。
    // clearColor：无自定义色效果主动清零（保留原值会让残留色跟着配置走——
    // 花开富贵读它 → 残留蓝全盘频闪，真机复现）
    if (s === 9) {
      if (colorRgb) { f[7] = colorRgb[0]; f[8] = colorRgb[1]; f[9] = colorRgb[2]; }
      else if (clearColor) { f[7] = 0; f[8] = 0; f[9] = 0; }
    }
    if (tgtSeq === s && brightness != null) {
      const lvl = Array.isArray(lightHw) && lightHw.length
        ? lightHw[Math.max(0, Math.min(lightHw.length - 1, brightness))] ?? brightness
        : brightness;
      f[tgtOff] = lvl;
      // 速度字节低 nibble：炫彩=7(RandomVal)、非炫彩=0——两代一致（真机最初可用行为；
      // nibble=2 的"颜色号"实验已随 §11.6 一并回滚，颜色号语义待官方驱动抓包定案后再动）。
      const cur = decodeSpeedByte(f[tgtOff + 1]);
      f[tgtOff + 1] = encodeSpeedByte(speed ?? cur.speed, colorful ?? cur.colorful);
    }
    // 动画模式参数补丁（真机对照官方驱动）：帧6 载 blob[84..97]，花开富贵需
    // [87..91] = 47 04 47 04 47（官方完整参数向量；须在亮度/速度写之后、校验和之前——
    // 否则会被 effectTableLoc 的写入覆盖）
    if (animMode && s === 6) { f[8] = 0x47; f[9] = 0x04; f[10] = 0x47; f[11] = 0x04; f[12] = 0x47; }
    // 旋钮模式：Cfg[26] = knobCustom ? 6 : 0（slice1 payload[13]=f[17]）
    if (knobCustom != null && s === 1) f[4 + 13] = knobCustom ? 6 : 0;
    f[19] = checksum(f);
    frames.push(f);
  }
  void selfFwNote;
  return frames;
}
