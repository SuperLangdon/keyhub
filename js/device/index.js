// 设备管理：模拟器 / WebHID 真机的统一接口
import * as P from './protocol.js';
import * as H from './webhid.js';
import * as i18n from '../i18n.js';
import { state, emit } from '../store.js';
import { COMMON_CMDS } from '../vk.js';

// ---------- 调试日志 ----------
// kind 六级：tx 发送 / rx 接收 / in 过程信息 / ok 成功 / warn 警告 / er 失败。
// 调试台（panel.js）与连接向导的日志气泡（connect.js）共用同一条管道。
const LOG_CAP = 800;
const logBuf = [];
const logListeners = new Set();
export function devLog(kind, msg) {
  const d = new Date();
  const time = d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  const entry = { time, kind, msg };
  logBuf.push(entry);
  if (logBuf.length > LOG_CAP) logBuf.shift();
  logListeners.forEach((fn) => fn(entry));
}
export function onDevLog(fn) { logListeners.add(fn); }
export function getLogs() { return [...logBuf]; }
export function clearLogs() { logBuf.length = 0; logListeners.forEach((fn) => fn(null)); }

// ---------- 效果槽 → 固件号 ----------
// 花开富贵的 UI 槽位（各型号 LedOpt 第 17 行均未掩藏）。是否走表驱动动画路径
// 由 model.animations['cartoon/flower'] 是否存在决定（动画代固件才有该文件）。
const ANIM_EFFECT_UI = 17;

export function fwOfUi(model, ui) {
  const o = model.ledopts.find((x) => x.ui === ui);
  if (o) return o.fw;
  if (ui === 19) return selfDefineFw(model); // 模型缺少自定义槽位时按协议默认 21
  return 0;
}
export function selfDefineFw(model) {
  return model.ledopts.find((o) => o.ui === 19)?.fw ?? 21;
}
export function hasCustomUi(model) {
  return model.ledopts.some((o) => o.ui === 19);
}
export function isOffUi(model, ui) {
  const o = model.ledopts.find((x) => x.ui === ui);
  return !o || o.fw === 0;
}

// ---------- 设备接口 ----------
export function hidReady() {
  return H.hidAvailable();
}

export const device = {
  mode: 'sim',
  dev: null,
  hidDevs: [],

  get label() {
    return this.mode === 'hid'
      ? `HID ${this.dev?.vendorId?.toString(16).padStart(4, '0')}:${this.dev?.productId?.toString(16).padStart(4, '0')}`
      : '演示模式';
  },

  // 请求浏览器选择并打开设备（主页「添加新设备」/ 手动向导共用）。
  // 返回**已打开的 HIDDevice 数组**（键盘的 vendor 功能可能分布在多个 USB 接口上，
  // Chrome 按接口授权，用户可能一次选中多个）；取消返回 null。
  async requestConnect(channel = 'any') {
    return H.requestDevice(devLog, channel);
  },

  // 收编一个已打开的 HIDDevice 为真机模式（灯光等操作走 this.dev；
  // 其余已打开接口存 hidDevs 备用，识别时逐个尝试）
  attach(dev, rest = []) {
    this.dev = dev;
    this.hidDevs = [dev, ...rest.filter((d) => d !== dev)];
    this.mode = 'hid';
    dev.addEventListener('disconnect', () => this.disconnect());
    devLog('in', `真机模式已启用（${dev.productName || 'Keyboard'}，${this.hidDevs.length} 个接口）`);
    emit('device', this.mode);
  },

  // 通道判别：按 VID/PID 区分有线 / 2.4G 无线（「自动」连接后由此识别实际通道）
  channelOf(dev) {
    if (dev?.vendorId === P.WIRED.vid && dev?.productId === P.WIRED.pid) return 'wired';
    if (dev?.vendorId === P.WIRELESS.vid && dev?.productId === P.WIRELESS.pid) return 'wireless';
    return null;
  },

  // 固件版本（只读，逆向确证）：官方驱动的「固件版本 V20.0.8」= USB **bcdDevice** ——
  // OemDrv 各 FindHIDDevice 调 HidD_GetAttributes 取 VersionNumber(WORD) 存 m_nVer，
  // 显示格式 "%s V%X.%X.%X"（>>8 整字节 / (>>4)&0xF / &0xF，bcdDevice 0x2008 → V20.0.8）。
  // WebHID 不暴露 bcdDevice → 走 WebUSB deviceVersionMajor/Minor/Subminor（同一字段的
  // 三段拆分，open() 后即可读，无需 claim 接口；与 WebHID 的授权相互独立）。
  // interactive=false：仅用已授权设备静默查询（getDevices 免弹窗），查不到返回 null。
  async readFwVersion(interactive = true) {
    if (!navigator.usb) {
      if (interactive) devLog('er', '固件版本查询需要 WebUSB（Chrome/Edge + localhost/HTTPS）');
      return null;
    }
    const filters = [
      { vendorId: P.WIRED.vid, productId: P.WIRED.pid },
      { vendorId: P.WIRELESS.vid, productId: P.WIRELESS.pid },
    ];
    try {
      let dev = (await navigator.usb.getDevices())
        .find((d) => filters.some((f) => d.vendorId === f.vendorId && d.productId === f.productId));
      if (!dev && interactive) {
        devLog('in', '固件版本：WebUSB 尚未授权，请在弹窗中选中键盘（与 WebHID 授权相互独立）…');
        dev = await navigator.usb.requestDevice({ filters });
      }
      if (!dev) return null;
      if (!dev.opened) await dev.open();
      const segs = [dev.deviceVersionMajor ?? 0, dev.deviceVersionMinor ?? 0, dev.deviceVersionSubminor ?? 0];
      const name = dev.productName || 'USB device';
      const raw = dev.deviceVersion;
      try { await dev.close(); } catch { /* ignore */ }
      // 段按驱动同款 %X 十六进制展示（0x2008 的 major 段 = 0x20 → "20"）
      const text = `V${segs[0].toString(16).toUpperCase()}.${segs[1].toString(16)}.${segs[2].toString(16)}`;
      devLog('ok', `固件版本 ${text}（bcdDevice=${raw}，${name}）`);
      return text;
    } catch (e) {
      if (interactive) devLog('er', '固件版本查询失败: ' + e.message);
      return null;
    }
  },

  // 电量（无线 only，0x4A）：返回 {percent, flags}；未连接 / 有线 / 休眠无响应返回 null
  async readBattery() {
    if (this.mode !== 'hid' || !this.dev?.opened) return null;
    if (this.channelOf(this.dev) !== 'wireless') return null;
    try { return await H.hidReadBattery(this.dev, devLog); } catch { return null; }
  },

  // 型号识别（GetPSD，report ID 0x05），单个接口。返回 { psd, reason }，见 webhid.js readPsd。
  async readPsd(dev) {
    const d = dev ?? this.dev;
    if (!d?.opened) return { psd: null, reason: 'no-dev' };
    try { return await H.readPsd(d, devLog); } catch (e) { devLog('er', 'GetPSD: ' + e.message); return { psd: null, reason: 'error' }; }
  },

  // 型号识别：对一组已打开接口逐个查询（识别命令可能只存在于其中某个接口）。
  // 声明了 report 5 的接口优先；全部发送被拒且无任何接口声明 report 5 → reason 'no-report'
  // （识别通道不在已授权接口上，或所在接口被浏览器屏蔽）。
  // 返回 { psd, dev, reason, blob }：blob 为 3632 路径带回的应答块（psd 为空时上层滑窗匹配）。
  async readPsdAny(devs) {
    const list = (devs && devs.length ? devs : this.hidDevs ?? [this.dev]).filter((d) => d?.opened);
    // 排序 = readPsd 的路径优先级：out[13]（0x13 协议，接收器）> feat[6]（520B 帧，有线）> feat[5]
    const rank = (d) => H.hasOutputReport(d, P.REPORT_ID) ? 3 : H.hasFeatureReport(d, 6) ? 2 : H.hasFeatureReport(d, P.PSD_REPORT_ID) ? 1 : 0;
    const sorted = [...list].sort((a, b) => rank(b) - rank(a));
    let lastReason = sorted.length ? 'timeout' : 'no-dev';
    for (const d of sorted) {
      const { psd, reason, blob } = await this.readPsd(d);
      if (psd || blob) return { psd, dev: d, reason, blob: blob ?? null };
      lastReason = reason;
    }
    if (lastReason === 'send-failed' && !sorted.some((d) => rank(d) > 0)) {
      devLog('er', `已授权的 ${sorted.length} 个接口均未声明识别报告（feature/output report 5），已尝试 0x13/3632 路径`);
      return { psd: null, dev: null, reason: 'no-report', blob: null };
    }
    return { psd: null, dev: null, reason: lastReason, blob: null };
  },

  // 灯光/0x13 写操作的主接口：优先声明了 output report 0x13 的接口
  // （有线键盘的某接口只有 feature/in 报文时，0x13 帧发不出去）
  bestForLights(devs) {
    const list = devs?.length ? devs : (this.hidDevs ?? []);
    return list.find((d) => d?.opened && H.hasOutputReport(d, P.REPORT_ID)) ?? list[0] ?? null;
  },

  // 当前主接口能否发送 0x13 帧（灯光/配置下发的前提；有线个别接口无任何 output 报文）
  canSend13(dev = this.dev) {
    return !!dev?.opened && H.hasOutputReport(dev, P.REPORT_ID);
  },

  // 接口能力摘要（调试台发送目标选择器的标签）：各方向声明的 report ID
  ifaceSummary(d) {
    const r = H.reportIds(d);
    const f = (a) => a.map((x) => x.toString(16)).join(',');
    return `in[${f(r.input) || '-'}] out[${f(r.output) || '-'}] feat[${f(r.feature) || '-'}]`;
  },

  // 此前授权过、仍插着的匹配设备（WebHID 持久授权），点设备卡片 / 添加设备时用于免弹窗合并。
  // 注意 getDevices() 返回 Promise：同步 .filter 会抛 TypeError 被 catch 吞掉，永远返回空表
  async knownDevices() {
    if (!H.hidAvailable()) return [];
    try {
      const devs = await navigator.hid.getDevices();
      return devs.filter((d) =>
        [P.WIRED, P.WIRELESS].some(({ vid, pid }) => d.vendorId === vid && d.productId === pid));
    } catch { return []; }
  },

  async toggle() {
    if (this.mode === 'hid') { this.disconnect(); return; }
    try {
      const devs = await this.requestConnect('any');
      if (!devs?.length) { devLog('in', '未选择设备'); return; }
      this.attach(devs[0], devs.slice(1));
    } catch (e) {
      devLog('er', '连接失败: ' + e.message);
    }
    emit('device', this.mode);
  },

  disconnect() {
    for (const d of this.hidDevs ?? []) { try { d?.close(); } catch { /* ignore */ } }
    try { this.dev?.close(); } catch { /* ignore */ }
    this.dev = null;
    this.hidDevs = [];
    this.mode = 'sim';
    devLog('in', '已断开，回到演示模式');
    emit('device', this.mode);
  },

  // 应用灯光（效果/颜色/亮度/速度）到设备。配置效果字节 = KB.ini LedOpt 首列 SW 槽位号
  //（1-18 效果、21=自定义、0=关），**两条通道同域**（真机验证：存储同一份 400B 配置——
  // 有线读回的 blob 与无线 0x44 十片逐字节同构；有线以 SW 写入已被真机确认各效果正确；
  // 早先「无线用 hw 次列」的判断源于休眠键盘 + LedMask 隐藏效果的污染数据，已废弃）。
  async applyLight(cfg, model) {
    const fw = fwOfUi(model, cfg.effectUi); // hw 次列：仅供 per-key 自定义固件号等使用
    const isCustom = cfg.effectUi === 19;   // FX_CUSTOM_UI（注入的自定义槽）
    const isOff = cfg.effectUi === 21;      // 原生 LedOpt19 行（首列 21/fw 0），UI 呈现为关闭
    const sw = isOff ? 0 : isCustom ? 21 : cfg.effectUi; // SW 效果字节
    const opts = {
      // 颜色按效果能力过滤：花开富贵等无色效果（LedOpt color=0）只隐藏了控件，
      // cfg.color 仍残留上次选色——带着它下发会灌单色表 → 单色频闪（真机复现）。
      // 无行（自定义槽等）视为支持。这里不清 store，切回支持颜色的效果仍可用。
      color: (cfg.colorful || !(model.ledopts.find((x) => x.ui === cfg.effectUi)?.color ?? true)) ? null : cfg.color,
      colorful: cfg.colorful,
      anim: cfg.effectUi === ANIM_EFFECT_UI && !!(model.animations && model.animations['cartoon/flower']), // 花开富贵：仅动画代固件（有 cartoon/flower 定义文件：Hi98/Hi98 3-Mode/Hi86）走表驱动三件套；其他代际固件原生渲染，走普通路径
      brightness: cfg.brightness,
      speed: cfg.speed,
    };
    if (this._applying) return; // 防重入：上一次下发进行中（快速连点会导致应答串线）
    this._applying = true;
    try {
    if (this.mode === 'hid' && this.dev?.opened) {
      if (!this.canSend13()) {
        // 有线键盘：无 0x13 输出通道。效果/亮度/速度走 520B 配置帧（cmd 84/04）；
        // 颜色走 report 6 隧道帧复用无线命令集（wcmd 0x09 调色板，逆向自 CDevG5KB 隧道族）
        try {
          await H.hidApplyEffectWired(this.dev, sw, opts, devLog);
          if (!isOff) {
            // 自定义色=灌色；无自定义色（炫彩/无色效果）=默认彩虹表——
            // 花开富贵等读每键表，残留单色=单色频闪（真机复现）
            const rgb = (!opts.colorful && opts.color) ? opts.color : null;
            await H.hidSetColorWired(this.dev, rgb, devLog, !!opts.anim);
          }
        }
        catch (e) { devLog('er', '有线下发失败: ' + e.message); }
        if (isCustom && Object.keys(cfg.perKey || {}).length) {
          await this.applyPerKey(cfg.perKey || {}, model, cfg); // 自定义模式：主下发连带每键/动画图案
        }
        return;
      }
      try { await H.hidApplyEffect(this.dev, sw, opts, devLog); }
      catch (e) { devLog('er', '下发失败: ' + e.message); }
      if (isCustom && Object.keys(cfg.perKey || {}).length) {
        await this.applyPerKey(cfg.perKey || {}, model, cfg); // 自定义模式：主下发连带每键/动画图案
      }
    } else {
      devLog('in', `[模拟] 下发效果 ui#${cfg.effectUi}(SW#${sw}) 亮度=${opts.brightness} 速度=${opts.speed}${opts.colorful ? ' 炫彩' : ' RGB(' + opts.color.join(',') + ')'}`);
      const frames = P.buildConfigWrite(null, {
        effect: sw, colorMode: (opts.colorful || opts.color) ? 1 : 3,
        brightness: opts.brightness, speed: opts.speed, colorful: opts.colorful,
      });
      devLog('tx', `config×10 首片: ${P.hex(frames[0])}`);
      devLog('tx', `palette×37 perkey×28 save×1（可在真机模式下查看全部报文）`);
    }
    } finally { this._applying = false; }
  },

  async applyPerKey(perKey, model, cfg = {}) {
    // perKey: {keyId: [r,g,b]} → led 索引 = 矩阵号。
    // 动画编译：选中动画（自定义模式）时先铺动画图案（行色锚点间线性插值，
    // 无锚点按行号色相渐变——原驱动同款语义），手涂颜色叠加其上覆盖
    const merged = perKey; // 原版驱动的自定义模式无动画——只有调色盘+涂色
    const ledMap = {};
    for (const [id, rgb] of Object.entries(merged)) {
      const k = model.keys.find((x) => x.i === +id);
      if (k) ledMap[k.matrix] = rgb;
    }
    const selfFw = selfDefineFw(model);
    if (this.mode === 'hid' && this.dev?.opened) {
      if (!this.canSend13()) {
        // 有线：配置置自定义 SW21（colorMode=1，镜像无线 hidApplyPerKey）+ 8a 表按矩阵填色
        try {
          await H.hidApplyEffectWired(this.dev, 21, {
            brightness: cfg.brightness ?? 3, speed: cfg.speed ?? 2,
            forceColorMode: 0x01,
          }, devLog);
          await H.hidSetPerKeyWired(this.dev, ledMap, devLog);
        }
        catch (e) { devLog('er', '有线下发失败: ' + e.message); }
        return;
      }
      try { await H.hidApplyPerKey(this.dev, ledMap, selfFw, devLog); }
      catch (e) { devLog('er', '下发失败: ' + e.message); }
    } else {
      devLog('in', `[模拟] 下发每键 RGB ${Object.keys(ledMap).length} 键（自定义模式 fw#${selfFw}）`);
      devLog('tx', `config×10 perkey×28 save×1`);
    }
  },

  // 下发宏（内容 + 各层宏键/常用命令键指派）。逆向自原驱动 CDev3632（SetMacro cmd 0x03 /
  // SetMatrix cmd 0x01）；回放由键盘固件执行，关掉网页不影响使用。
  // cfg.layers 里的宏键（type 0x0A）与常用命令键（type 0x01，如锁屏）都会收集；
  // 键位层走读改写——只替换这两类键，其余功能类型的全量编码未逆向、不动。
  async applyMacros() {
    const { model, cfg } = state;
    const macros = state.macros;
    if (!model || !cfg) return { error: 'no-model' };
    // 收集各层指派：宏 {layer: {keyIndex: {macroId, repeat, loopCode}}}；命令 {layer: {keyIndex: hwDword}}
    const byLayer = {};
    const cmdByLayer = {};
    const skippedCmds = [];
    let any = false;
    for (let l = 0; l < (model.layerNum ?? 4); l++) {
      const m = {};
      const c = {};
      for (const [kIdx, fn] of Object.entries(cfg.layers?.[l] ?? {})) {
        if (fn?.type === 0x0A) {
          m[kIdx] = { macroId: fn.param, repeat: fn.rep ?? 1, loopCode: fn.loopCode ?? P.MACRO_LOOP_CODES.once };
          any = true;
        } else if (fn?.type === 0x01) {
          const def = COMMON_CMDS.find((x) => x.code === fn.code);
          if (def?.hw != null) { c[kIdx] = def.hw; any = true; }
          else if (def) skippedCmds.push(`K${kIdx} 0x${fn.code.toString(16)}`);
        }
      }
      if (Object.keys(m).length) byLayer[l] = m;
      if (Object.keys(c).length) cmdByLayer[l] = c;
    }
    if (this.mode === 'hid' && this.dev?.opened) {
      if (!this.canSend13() && !H.hasFeatureReport(this.dev, 6) && !H.hasFeatureReport(this.dev, 9)) {
        devLog('er', '当前接口既无 0x13 输出报文（2.4G）也无 520B 特征帧（有线 report 6/9）——请重新连接设备');
        return { error: 'no-channel' };
      }
      if (!macros.length && !any) {
        devLog('in', skippedCmds.length
          ? `仅有无固件编码的指派（${skippedCmds.join('、')}＝复位键盘：原驱动中为主机侧全局操作，非固件键位功能），无内容可写入`
          : '没有宏/命令指派，无事可做');
        return { sent: false };
      }
      if (this._applying) return { error: 'busy' };
      // 容量拦截（原驱动同款）：打包 blob 超驱动硬上限 0x2800 直接拒绝，别让固件截断
      if (macros.length) {
        const { blob } = P.buildMacroBlob(macros);
        if (blob.length > H.MACRO_DRIVER_LIMIT) {
          devLog('er', `宏打包 ${blob.length}B 超过原驱动上限 ${H.MACRO_DRIVER_LIMIT}B（10240）——请删减宏/事件后重试`);
          return { error: 'too-big', size: blob.length };
        }
        devLog('in', `容量检查：打包 ${blob.length}B ≤ ${H.MACRO_DRIVER_LIMIT}B ✓`);
      }
      this._applying = true;
      try {
        if (skippedCmds.length) devLog('in', `[提示] ${skippedCmds.join('、')} 指派的「复位键盘」无固件键位编码（原驱动仅作为全局设置操作），已跳过写入`);
        if (this.canSend13()) {
          // 2.4G 无线通道：0x13 协议（宏内容 cmd 0x03 + 键位 0x41/0x01）
          return await H.hidApplyMacros(this.dev, macros, byLayer, model.keys.length, devLog, cmdByLayer);
        }
        // 有线通道：520B 特征帧（键位读 cmd 83 / 写 cmd 03，宏写 cmd 05——逆向自 CDevG5KB）
        return await H.hidApplyMacrosWired(this.dev, macros, byLayer, cmdByLayer, model.keys.length, devLog);
      } catch (e) {
        devLog('er', '宏下发失败: ' + e.message);
        return { error: e.message };
      } finally { this._applying = false; }
    }
    // 模拟模式：演示打包结果
    const { blob, count } = P.buildMacroBlob(macros);
    devLog('in', `[模拟] 宏下发：${count} 条 / ${blob.length}B（cmd 0x03 ×${Math.ceil(blob.length / P.MACRO_CHUNK)} 块）`);
    const parts = [];
    if (Object.keys(byLayer).length) parts.push(Object.entries(byLayer).map(([l, k]) => `层${l}×${Object.keys(k).length}宏键`).join(' '));
    if (Object.keys(cmdByLayer).length) parts.push(Object.entries(cmdByLayer).map(([l, k]) => `层${l}×${Object.keys(k).length}命令键`).join(' '));
    if (parts.length) devLog('in', `[模拟] 指派：${parts.join('；')}`);
    if (skippedCmds.length) devLog('in', `[模拟] 跳过：${skippedCmds.join('、')}（复位键盘＝主机侧全局操作，无固件键位编码）`);
    devLog('tx', `blob 头 32B: ${P.hex(blob.subarray(0, 32))}`);
    return { sent: false, sim: true };
  },

  async applySleep(minutes) {
    if (this.mode === 'hid' && this.dev?.opened) {
      try { await H.hidSetSleep(this.dev, minutes, devLog); } catch (e) { devLog('er', e.message); }
    } else devLog('in', `[模拟] 下发睡眠 ${minutes} 分钟（配置片0 payload[9] = 档位索引 ${P.sleepIndexOf(minutes)}）`);
  },

  async applyDebounce(level) {
    if (this.mode === 'hid' && this.dev?.opened) {
      try { await H.hidSetDebounce(this.dev, level, devLog); } catch (e) { devLog('er', e.message); }
    } else devLog('in', `[模拟] 下发按键去抖 ${level} 档（配置片0 payload[2]/[3] = ${level - 1}）`);
  },

  async applyTapSens(level) {
    if (this.mode === 'hid' && this.dev?.opened) {
      try { await H.hidSetTapSens(this.dev, level, devLog); } catch (e) { devLog('er', e.message); }
    } else devLog('in', `[模拟] 下发 Tap 灵敏度 ${level} 档（配置片0 payload[8] = ${level}）`);
  },

  async factoryReset() {
    if (this.mode === 'hid' && this.dev?.opened) {
      try { await H.hidFactoryReset(this.dev, devLog); } catch (e) { devLog('er', e.message); }
    } else devLog('in', '[模拟] 恢复出厂（灯光配置写回模板 + 调色板 + 保存）');
  },

  // ---------- 调试台手动收发（HID 控制台的报文构造器走这里，不绕过设备管理器） ----------
  // 发送 output report（首字节 = report ID），发完读一帧回显（300ms）。target 省略 = 主接口。
  async rawSendOutput(target, bytes) {
    if (this.mode !== 'hid' || !target?.opened) { devLog('er', '手动发送需要真机模式（WebHID）'); return false; }
    try {
      const f = Uint8Array.from(bytes);
      await target.sendReport(f[0], f.slice(1));
      devLog('tx', P.hex(f) + '  (手动)');
      const echo = await H.readReport(target, 300);
      if (echo) devLog('rx', P.hex(echo));
      return true;
    } catch (e) {
      devLog('er', '发送失败: ' + e.message);
      return false;
    }
  },

  // 发送 feature report（有线键盘的命令通道）。readBack: 随后读一次同号应答并记录。
  async rawSendFeature(target, reportId, data, readBack = true) {
    if (this.mode !== 'hid' || !target?.opened) { devLog('er', '手动发送需要真机模式（WebHID）'); return false; }
    const rid = 'F' + reportId.toString(16).padStart(2, '0');
    try {
      await target.sendFeatureReport(reportId, Uint8Array.from(data));
      devLog('tx', `${rid} ${P.hex(data)}  (手动)`);
    } catch (e) {
      devLog('er', `SetFeature(${rid}) 失败: ` + e.message);
      return false;
    }
    if (readBack) {
      try {
        const dv = await Promise.race([
          target.receiveFeatureReport(reportId),
          new Promise((_, rej) => setTimeout(() => rej(new Error('超时（1s 无应答）')), 1000)),
        ]);
        const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        devLog('rx', `${rid} ${P.hex(b.slice(0, 32))}${b.length > 32 ? ' …' : ''}（${b.length}B）`);
      } catch (e) {
        devLog('er', `GetFeature(${rid}) 失败: ` + e.message);
      }
    }
    return true;
  },

  // ---------- 只读探针（调试台「快捷」区；全部不向设备写入任何配置） ----------
  // 型号识别（GetPSD）：对全部已授权接口逐条路径探测
  async probePsd() {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return; }
    devLog('in', '探针 · GetPSD 型号识别（对已授权接口逐个查询）…');
    return this.readPsdAny();
  },

  // 电量（仅 2.4G 通道有 0x4A 应答）
  async probeBattery() {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return; }
    if (this.channelOf(this.dev) !== 'wireless') {
      devLog('warn', '电量查询仅 2.4G 无线通道应答（有线连接无 0x4A）');
      return;
    }
    devLog('in', '探针 · 电量查询（0x4A）…');
    await this.readBattery();
  },

  // 读灯光配置（0x44 十片）并按协议字段解码。configSummary 也供有线探针复用。
  async probeConfig() {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return; }
    const dev = this.bestForLights();
    if (!this.canSend13(dev)) { devLog('er', '读配置需要 0x13 输出通道（2.4G 接收器）；有线键盘请用「有线命令扫描」探针'); return null; }
    devLog('in', '探针 · 读灯光配置（cmd 0x44 十片）…');
    const cfg = await H.readConfig(dev, devLog);
    if (!cfg) { devLog('er', '读配置失败（无应答或不完整）'); return null; }
    const info = this.configSummary(P.parseConfig(cfg));
    devLog('ok', `当前配置：${info}`);
    return cfg;
  },

  // 读键位层（cmd 0x41，读改写流程的读半边）
  async probeKeymap(layer = 0) {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return; }
    const { model } = state;
    if (!model?.keys?.length) { devLog('er', '未加载型号（键数未知），无法读键位层'); return; }
    const dev = this.bestForLights();
    if (!this.canSend13(dev)) { devLog('er', '读键位层需要 0x13 输出通道（2.4G 接收器）'); return; }
    devLog('in', `探针 · 读键位层 ${layer}（cmd 0x41，${model.keys.length} 键 × dword）…`);
    const bytes = await H.readMatrix13(dev, layer, model.keys.length * 4, devLog);
    if (!bytes) { devLog('er', '键位层读取失败（无应答）'); return; }
    const words = [];
    for (let i = 0; i + 4 <= bytes.length && words.length < 8; i += 4) {
      words.push(((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
    }
    devLog('ok', `层${layer} 键位表 ${bytes.length / 4} 键，前 8 个 dword：${words.map((w) => w.toString(16).padStart(8, '0')).join(' ')}`);
    return bytes;
  },

  // 有线命令族扫描（520B feature 帧，cmd 83-8A 只读遍历）+ 配置解码
  async probeWiredStores() {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return; }
    const dev = (this.hidDevs ?? []).find((d) => d?.opened && H.hasFeatureReport(d, 6));
    if (!dev) { devLog('er', '有线探针需要声明 feature report 6 的接口（520B 帧通道）'); return; }
    devLog('in', '探针 · 有线命令族扫描（feat520 读 83-8A × sub 0-2，各 400B）…');
    const res = await H.hidReadConfigWired(dev, devLog);
    if (res?.blob) devLog('ok', `有线配置命中 cmd ${res.cmd.toString(16)}/${res.sub}：${this.configSummary(P.parseConfig(P.blobToFrames(res.blob)))}`);
    return res;
  },

  // 配置解码摘要（0x13 十片 / 有线 400B blob 通用；效果字节域 = SW 槽位）
  configSummary(c) {
    if (!c) return '解析失败（帧不完整）';
    const { fxName, fxOffName } = i18n;
    const effectName = c.effect === 0 ? fxOffName() : c.effect === 21 ? fxName(19) : fxName(c.effect);
    const color = c.colorMode === 0x01 ? '单色/RGB' : c.colorMode === 0x03 ? '炫彩' : `模式${c.colorMode}`;
    const sleep = c.sleepMin != null ? `${c.sleepMin} 分钟` : `索引${c.frames[0][13]}`;
    return `效果 SW#${c.effect}（${effectName}）· 色彩 ${color} · 去抖 ${c.debounce ?? '?'} 档 · Tap ${c.tapSens} 档 · 睡眠 ${sleep}`;
  },
};
