// 设备管理：模拟器 / WebHID 真机的统一接口
import * as P from './protocol.js';
import * as H from './webhid.js';
import * as F from './film.js';
import * as i18n from '../i18n.js';
import { state, emit, BUILD } from '../store.js';
import { download } from '../ui.js';

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

// ---------- HID 事务互斥 ----------
// 所有设备收发串行化：下发 / 探针 / 调试台手动发送并发时，各自的 inputreport
// 监听会互相抢帧（校验误判、配置读半截）。公开入口一律 lock() 排队；方法内部的
// 嵌套调用走 *Inner（不再排队，避免自锁）。
let txChain = Promise.resolve();
function lock(fn) {
  const p = txChain.then(fn);
  txChain = p.then(() => {}, () => {});
  return p;
}

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

  // 型号协议配置：K65（fw≠24）的 520B 有线通道固定走 report 9（帧布局与 LEOBOG 相同，
  // 真机实证 2026-10），LEOBOG 全系 fw24 走 report 6。进入型号会话时调用（enterApp）。
  configureModel(model) {
    const mode = model?.fw === 24 ? 'legacy' : 'k65';
    H.setFeat520Mode(mode);
    devLog('in', `520B 通道：${mode}（${model?.short ?? '?'} fw=${model?.fw ?? '?'}）——K65 = 同布局 + report 9`);
  },

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
    // 防重复挂监听：同一设备多次 attach（卡片重进）不能叠加 disconnect 处理器
    if (!dev.__khDiscWired) {
      dev.__khDiscWired = true;
      dev.addEventListener('disconnect', () => this.disconnect());
    }
    devLog('in', `真机模式已启用（${dev.productName || 'Keyboard'}，${this.hidDevs.length} 个接口）`);
    emit('device', this.mode);
  },

  // 通道判别：按 VID/PID 区分有线 / 2.4G 无线（「自动」连接后由此识别实际通道）。
  // 多设备族（LEOBOG 全系 / 银雕 K65）逐族匹配，见 protocol.js DEVICE_FAMILIES。
  channelOf(dev) {
    for (const fam of P.DEVICE_FAMILIES) {
      if (dev?.vendorId === fam.wired?.vid && dev?.productId === fam.wired?.pid) return 'wired';
      if (dev?.vendorId === fam.wireless?.vid && dev?.productId === fam.wireless?.pid) return 'wireless';
    }
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
    const filters = P.idsForChannel('any').map(({ vid, pid }) => ({ vendorId: vid, productId: pid }));
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

  // 电量：按型号代际选择通道（2026-10 K65 版驱动 REA）：
  //   fw26（K65）→ GetPower（feat520 校验和帧 cmd 09/01，应答数据@8；仅 k65 帧模式），
  //                有线/无线连接都走同一 feat520 接口（官方驱动仅在无线连接时查询，有线恒显 100%）
  //   fw24（LEOBOG）→ 0x13 cmd 0x4A（仅 2.4G 接收器通道应答；注意 0x4A 在 fw26 语义是板载档号）
  // 返回 {percent}；未连接 / 无响应 / 休眠返回 null
  async readBattery() {
    return lock(async () => {
    if (this.mode !== 'hid' || !this.dev?.opened) return null;
    const { model } = state;
    // GetPower（fw26）只发给 VID/PID 与该型号匹配的设备——连接向导的电量角标可能在
    // 型号会话之外触发，state.model 未必对应眼前这台键盘
    const matchesModel = model && [[model.vid, model.pid], [model.vidW, model.pidW]]
      .some(([v, p]) => v != null && this.dev?.vendorId === v && this.dev?.productId === p);
    if (model && P.cfgGenOf(model) === 'fw26' && matchesModel) {
      // GetPower 需要 feat520（report 6/9 任一）；主接口没有则试其它已授权接口
      const dev = [this.dev, ...(this.hidDevs ?? [])].find((d) => d?.opened && (H.hasFeatureReport(d, 6) || H.hasFeatureReport(d, 9)));
      if (dev) { try { return await H.hidReadBatteryWired(dev, devLog); } catch (e) { devLog('er', '电量(GetPower): ' + e.message); return null; } }
      devLog('er', '电量(GetPower)：已授权接口无 520B feature 通道（report 6/9）');
      return null;
    }
    if (this.channelOf(this.dev) !== 'wireless') return null;
    try { return await H.hidReadBattery(this.dev, devLog); } catch { return null; }
    });
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
    return lock(() => this.readPsdAnyInner(devs));
  },
  async readPsdAnyInner(devs) {
    const list = (devs && devs.length ? devs : this.hidDevs ?? [this.dev]).filter((d) => d?.opened);
    // 排序 = readPsd 的路径优先级：out[13]（0x13 协议，接收器）> feat[6/9]（520B 帧，有线）> feat[5]
    const rank = (d) => H.hasOutputReport(d, P.REPORT_ID) ? 3 : (H.hasFeatureReport(d, 6) || H.hasFeatureReport(d, 9)) ? 2 : H.hasFeatureReport(d, P.PSD_REPORT_ID) ? 1 : 0;
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
    return devs.filter((d) => P.idsForChannel('any').some(({ vid, pid }) => d.vendorId === vid && d.productId === pid));
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
    return lock(() => this.applyLightInner(cfg, model));
  },
  async applyLightInner(cfg, model) {
    const isCustom = cfg.effectUi === 19;   // FX_CUSTOM_UI（注入的自定义槽）
    const isOff = cfg.effectUi === 21;      // 原生 LedOpt19 行（首列 21/fw 0），UI 呈现为关闭
    // 效果字节 = UI 号（两代同域）。§11.5 曾改为 fw 固件号——系 LedOpt 行布局偏移读错
    //（行实为 [使能,fw,ui,...]，驱动 FillCfgB 取行+2=ui 列）；真机大规模错乱后回滚，
    // 并由真机现象反证固件效果域确为 UI 1-18（LedMask 隐藏的 6/14/18 固件没有）+21+0。
    const sw = isOff ? 0 : isCustom ? 21 : cfg.effectUi;
    const opts = {
      // 颜色按效果能力过滤：花开富贵等无色效果（LedOpt color=0）只隐藏了控件，
      // cfg.color 仍残留上次选色——带着它下发会灌单色表 → 单色频闪（真机复现）。
      // 无行（自定义槽等）视为支持。这里不清 store，切回支持颜色的效果仍可用。
      color: (cfg.colorful || !(model.ledopts.find((x) => x.ui === cfg.effectUi)?.color ?? true)) ? null : cfg.color,
      colorful: cfg.colorful,
      anim: cfg.effectUi === ANIM_EFFECT_UI && !!(model.animations && model.animations['cartoon/flower']), // 花开富贵：仅动画代固件（有 cartoon/flower 定义文件：Hi98/Hi98 3-Mode/Hi86）走表驱动三件套；其他代际固件原生渲染，走普通路径
      brightness: cfg.brightness,
      speed: cfg.speed,
      gen: P.cfgGenOf(model),           // fw24（LEOBOG 历史布局）/ fw26（K65 版驱动 FillCfg 实证布局）
      lightHw: P.modelLightHw(model),   // K65 = [1,5,10,15,20]（直写 UI 档会近乎最暗）；LEOBOG 恒等 → null
    };
    if (this.mode === 'hid' && this.dev?.opened) {
      if (!this.canSend13()) {
        // 有线键盘：无 0x13 输出通道。效果/亮度/速度走 520B 配置帧（cmd 84/04）；
        // 颜色走 report 6 隧道帧复用无线命令集（wcmd 0x09 调色板，逆向自 CDevG5KB 隧道族）
        try {
          await H.hidApplyEffectWired(this.dev, sw, opts, devLog);
          if (!isOff) {
            // 自定义色=灌色；无自定义色（炫彩/无色效果）=默认彩虹表——
            // 花开富贵等读每键表，残留单色=单色频闪（真机复现）。
            // crc 型号（K65）按官方流程全表直写（8a 读回仅 144B，读改写会清零 ui7+ 的组）
            const rgb = (!opts.colorful && opts.color) ? opts.color : null;
            await H.hidSetColorWired(this.dev, rgb, devLog, !!opts.anim, { crc: !!model.crc });
          }
        }
        catch (e) { devLog('er', '有线下发失败: ' + e.message); }
        if (isCustom && Object.keys(cfg.perKey || {}).length) {
          await this.applyPerKeyInner(cfg.perKey || {}, model, cfg); // 自定义模式：主下发连带每键/动画图案
        }
        return;
      }
      try { await H.hidApplyEffect(this.dev, sw, opts, devLog); }
      catch (e) { devLog('er', '下发失败: ' + e.message); }
      if (isCustom && Object.keys(cfg.perKey || {}).length) {
        await this.applyPerKeyInner(cfg.perKey || {}, model, cfg); // 自定义模式：主下发连带每键/动画图案
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
  },

  async applyPerKey(perKey, model, cfg = {}, ui = {}) {
    return lock(() => this.applyPerKeyInner(perKey, model, cfg, ui));
  },
  // perKey: {keyId: [r,g,b]} → led 索引 = 矩阵号。
  // 动画编译：选中动画（自定义模式）时先铺动画图案（行色锚点间线性插值，
  // 无锚点按行号色相渐变——原驱动同款语义），手涂颜色叠加其上覆盖
  async applyPerKeyInner(perKey, model, cfg = {}) {
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
            gen: P.cfgGenOf(model), lightHw: P.modelLightHw(model),
          }, devLog);
          await H.hidSetPerKeyWired(this.dev, ledMap, devLog, { crc: !!model.crc });
        }
        catch (e) { devLog('er', '有线下发失败: ' + e.message); }
        return;
      }
      try { await H.hidApplyPerKey(this.dev, ledMap, selfFw, devLog, model); }
      catch (e) { devLog('er', '下发失败: ' + e.message); }
    } else {
      devLog('in', `[模拟] 下发每键 RGB ${Object.keys(ledMap).length} 键（自定义模式 fw#${selfFw}）`);
      devLog('tx', `config×10 perkey×28 save×1`);
    }
  },

  // 下发改键与宏（全功能指派 + 宏内容）。逆向自原驱动 CDev3632（SetMacro cmd 0x03 /
  // SetMatrix cmd 0x01）；回放由键盘固件执行，关掉网页不影响使用。
  // cfg.layers 里的全部功能类型都参与读改写：普通键/组合键（fnToDword hid 编码）、多媒体/灯光
  // （type 0x09 字节重排）、宏（type 0x0A）、常用命令（type 0x01 查表）——编码规则全部实证自
  // keyinfo_to_hardware_code@0x491f90（2026-10 REA 复核）。无编码的指派跳过并计数。
  // 键位槽位用 model.keys[].matrix（驱动按 KB.ini 每键 matrix 寻址，BuildMacroBlob 实证；
  // K 序号≠槽位——Hi75 K1→槽0、K2→槽12，此前按 K 序号直索引是错位 bug，2026-10 修正）。
  async applyMacros() {
    return lock(() => this.applyMacrosInner());
  },
  async applyMacrosInner() {
    const { model, cfg } = state;
    const macros = state.macros;
    if (!model || !cfg) return { error: 'no-model' };
    if (!model.keys?.length) { devLog('er', '未加载型号（键位槽未知），无法下发改键'); return { error: 'no-model' }; }
    // 键 → 固件矩阵槽位；槽数 = max(matrix)+1（Hi75 为 90 槽 > 键数 82——旋钮等占位）
    const slotOf = new Map(model.keys.map((k) => [k.i, k.matrix]));
    const slotCount = Math.max(...model.keys.map((k) => k.matrix)) + 1;
    const patchByLayer = {};
    const skipped = [];
    let any = false;
    for (let l = 0; l < (model.layerNum ?? 4); l++) {
      const p = {};
      for (const [kIdx, fn] of Object.entries(cfg.layers?.[l] ?? {})) {
        const slot = slotOf.get(+kIdx);
        if (slot == null) continue;
        const dw = P.fnToDword(fn, { macroOrder: macros });
        if (dw != null) { p[slot] = dw; any = true; }
        else if (fn?.type === 0x0A) skipped.push(`K${kIdx} 宏不存在`);
        else if (fn?.type === 0x01 && fn.code === 0x1d) skipped.push(`K${kIdx} 复位键盘`);
        else if (fn?.type === 0x02 && fn.code >= 6 && fn.code <= 9) skipped.push(`K${kIdx} 鼠标动作值域未校准`);
        else skipped.push(`K${kIdx} 无固件编码`);
      }
      if (Object.keys(p).length) patchByLayer[l] = p;
    }
    if (this.mode === 'hid' && this.dev?.opened) {
      if (!this.canSend13() && !H.hasFeatureReport(this.dev, 6) && !H.hasFeatureReport(this.dev, 9)) {
        devLog('er', '当前接口既无 0x13 输出报文（2.4G）也无 520B 特征帧（有线 report 6/9）——请重新连接设备');
        return { error: 'no-channel' };
      }
      if (!macros.length && !any) {
        devLog('in', '没有可下发的指派，无事可做');
        return { sent: false };
      }
      // 容量拦截（原驱动同款，双层上限）：打包 blob 超 KB.ini MacroBufferSize（K65 缺省 4096，
      // 驱动打包器实际生效的上限）或驱动静态数组硬上限 0x2800 直接拒绝，别让固件截断
      if (macros.length) {
        const cap = Math.min(model.macroBufferSize ?? H.MACRO_DRIVER_LIMIT, H.MACRO_DRIVER_LIMIT);
        const { blob } = P.buildMacroBlob(macros);
        if (blob.length > cap) {
          devLog('er', `宏打包 ${blob.length}B 超过原驱动上限 ${cap}B——请删减宏/事件后重试`);
          return { error: 'too-big', size: blob.length };
        }
        devLog('in', `容量检查：打包 ${blob.length}B ≤ ${cap}B ✓`);
      }
      if (skipped.length) devLog('in', `[提示] 跳过 ${skipped.length} 项无固件编码/待校准的指派：${skipped.join('、')}`);
      // K65 等按 MatrixLen 全层下发 + 末槽 A5A5A5A5（驱动 FillMatrix 0x490D10 实证）；
      // fw24 世代维持 max(matrix)+1 槽（真机验证过的行为）
      const mOpts = model.crc
        ? { matrixLen: model.matrixLen ?? P.MATRIX_DEFAULT_LEN, crc: true }
        : {};
      if (mOpts.matrixLen) devLog('in', `键位层域：MatrixLen=${mOpts.matrixLen} 槽（CRC 型号全层下发，末槽 A5A5A5A5）`);
      try {
        let res;
        if (this.canSend13()) {
          // 2.4G 无线通道：0x13 协议（宏内容 cmd 0x03 + 键位 0x41/0x01）
          res = await H.hidApplyMacros(this.dev, macros, patchByLayer, slotCount, devLog, mOpts);
        } else {
          // 有线通道：520B 特征帧（键位读 cmd 83 / 写 cmd 03，宏写 cmd 05——逆向自 CDevG5KB）
          res = await H.hidApplyMacrosWired(this.dev, macros, patchByLayer, slotCount, devLog, mOpts);
        }
        // 旋钮模式联动（型号过滤：KB.ini WheelMode>0 才有；驱动 FillCfg Cfg[26]=nWheelMode——
        // 旋钮键被改键→6=固件当普通键，否则 0。KnobIndex 为 0 基，K 表 1 基 +1）
        const wheel = model.wheel;
        if (wheel?.mode > 0 && Number.isInteger(wheel.knobIndex) && this.canSend13()) {
          const knobI = wheel.knobIndex + 1;
          const defFn = model.keys.find((k) => k.i === knobI)?.fn ?? null;
          const customized = Array.from({ length: model.layerNum ?? 4 }, (_, l) => cfg.layers?.[l]?.[knobI])
            .some((fn) => fn != null && !(defFn && fn.type === defFn.type && fn.code === defFn.code && fn.param === defFn.param));
          await H.hidSetKnobMode(this.dev, customized, devLog);
        }
        return res;
      } catch (e) {
        devLog('er', '改键/宏下发失败: ' + e.message);
        return { error: e.message };
      }
    }
    // 模拟模式：演示打包结果
    const { blob, count } = P.buildMacroBlob(macros);
    devLog('in', `[模拟] 宏下发：${count} 条 / ${blob.length}B（cmd 0x03 ×${Math.ceil(blob.length / P.MACRO_CHUNK)} 块）`);
    const parts = Object.entries(patchByLayer).map(([l, k]) => `层${l}×${Object.keys(k).length}键`);
    if (parts.length) devLog('in', `[模拟] 指派：${parts.join(' ')}`);
    if (skipped.length) devLog('in', `[模拟] 跳过：${skipped.join('、')}`);
    devLog('tx', `blob 头 32B: ${P.hex(blob.subarray(0, 32))}`);
    return { sent: false, sim: true };
  },

  // 设置类下发的通道路由：0x13（2.4G/接收器）走 hidSetX；有线走 feat520 读改写（hidSetSettingWired）
  async applySleep(minutes) {
    return lock(async () => {
    const { model } = state;
    const gen = P.cfgGenOf(model);
    const tbl = P.modelSleepTable(model);
    const idx = P.sleepUiIndexOf(tbl, minutes);
    const patch = gen === 'fw26' ? { sleepHw: tbl.hw[idx] & 0xff, gen } : { sleepIndex: idx, gen };
    if (this.mode === 'hid' && this.dev?.opened) {
      try {
        if (this.canSend13()) await H.hidSetSleep(this.dev, minutes, devLog, model);
        else await H.hidSetSettingWired(this.dev, patch, devLog);
      } catch (e) { devLog('er', e.message); }
    } else devLog('in', `[模拟] 下发睡眠 ${minutes} 分钟（${gen === 'fw26' ? `blob[24] = HW 值 ${tbl.hw[idx]}` : `配置片0 payload[9] = 档位索引 ${idx}`}）`);
    });
  },

  async applyDebounce(level) {
    return lock(async () => {
    const { model } = state;
    const gen = P.cfgGenOf(model);
    if (this.mode === 'hid' && this.dev?.opened) {
      try {
        if (this.canSend13()) await H.hidSetDebounce(this.dev, level, devLog, model);
        else await H.hidSetSettingWired(this.dev, { debounce: level, gen }, devLog);
      } catch (e) { devLog('er', e.message); }
    } else devLog('in', `[模拟] 下发按键去抖 ${level} 档（${gen === 'fw26' ? 'blob[3]' : '配置片0 payload[2]/[3]'} = ${gen === 'fw26' ? level : level - 1}）`);
    });
  },

  async applyTapSens(level) {
    return lock(async () => {
    const { model } = state;
    const gen = P.cfgGenOf(model);
    if (this.mode === 'hid' && this.dev?.opened) {
      try {
        if (this.canSend13()) await H.hidSetTapSens(this.dev, level, devLog, model);
        else await H.hidSetSettingWired(this.dev, { tapSens: level, gen }, devLog);
      } catch (e) { devLog('er', e.message); }
    } else devLog('in', `[模拟] 下发 Tap 灵敏度 ${level} 档（${gen === 'fw26' ? 'blob[22]' : '配置片0 payload[8]'} = ${level}）`);
    });
  },

  async factoryReset() {
    return lock(async () => {
    if (this.mode === 'hid' && this.dev?.opened) {
      try { await H.hidFactoryReset(this.dev, devLog); } catch (e) { devLog('er', e.message); }
    } else devLog('in', '[模拟] 恢复出厂（灯光配置写回模板 + 调色板 + 保存）');
    });
  },

  // ---------- 屏幕（K65 等带屏型号；协议 2026-10 反汇编实证：feat520 通道，见 device/film.js） ----------
  // 屏幕通道 = 主接口（与灯光 feat520 同一管线），无独立接口
  bestForScreen(devs) {
    const list = (devs?.length ? devs : (this.hidDevs ?? [])).filter((d) => d?.opened);
    return F.pickFilmIface(list, devLog);
  },

  // 烧录屏幕帧。frames: RGB565 Uint8Array[]（页面层用 film.rgb565Pack 打包）；
  // opts.delays: 每帧播放间隔 ms（协议为单一全局值，取首帧）。
  // onProgress(done, total)；shouldAbort() 轮询取消。演示模式只记录不发。
  async burnScreen(frames, opts = {}) {
    return lock(() => this.burnScreenInner(frames, opts));
  },
  async burnScreenInner(frames, { onProgress, shouldAbort, delays } = {}) {
    if (this.mode === 'hid' && this.dev?.opened) {
      const dev = this.bestForScreen();
      if (!dev) return { sent: false, error: 'no-iface' };
      try { return await F.filmBurn(dev, frames, devLog, { onProgress, shouldAbort, delays }); }
      catch (e) { devLog('er', '屏幕烧录失败: ' + e.message); return { sent: false, error: e.message }; }
    }
    devLog('in', `[模拟] 屏幕烧录：${frames.length} 帧（演示模式不写入真机）`);
    for (let i = 0; i < frames.length; i++) {
      if (shouldAbort?.()) return { sent: false, aborted: true };
      onProgress?.(i + 1, frames.length);
      await new Promise((r) => setTimeout(r, 40)); // 模拟烧录节奏
    }
    return { sent: false, sim: true, chunks: frames.length, echoes: 0 };
  },

  // SetGIFParam（cmd 0x0D）——烧录开始/收尾命令，屏幕页调试区用（op: 1 开始 0 收尾 2 取消）
  async setGifParam(op, frameCount, delayMs) {
    return lock(async () => {
    if (this.mode === 'hid' && this.dev?.opened) {
      const dev = this.bestForScreen();
      if (!dev) return null;
      try { return await F.filmGifParam(dev, op, frameCount, delayMs, devLog, 1); }
      catch (e) { devLog('er', 'SetGIFParam 失败: ' + e.message); return null; }
    }
    devLog('in', `[模拟] SetGIFParam(op=${op}, 帧数=${frameCount}, 延时=${delayMs}ms)`);
    return null;
    });
  },

  // ---------- 调试台手动收发（HID 控制台的报文构造器走这里，不绕过设备管理器） ----------
  // 发送 output report（首字节 = report ID），发完读一帧回显（300ms）。target 省略 = 主接口。
  async rawSendOutput(target, bytes) {
    return lock(async () => {
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
    });
  },

  // 发送 feature report（有线键盘的命令通道）。readBack: 随后读一次同号应答并记录。
  async rawSendFeature(target, reportId, data, readBack = true) {
    return lock(async () => {
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
    });
  },

  // ---------- 只读探针（调试台「快捷」区；全部不向设备写入任何配置） ----------
  // 型号识别（GetPSD）：对全部已授权接口逐条路径探测
  async probePsd() {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return; }
    devLog('in', '探针 · GetPSD 型号识别（对已授权接口逐个查询）…');
    return this.readPsdAny();
  },

  // 电量：fw26（K65）走 GetPower（feat520，两通道皆可）；fw24 走 0x4A（仅 2.4G 接收器应答）
  async probeBattery() {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return; }
    const { model } = state;
    if (model && P.cfgGenOf(model) === 'fw26') {
      devLog('in', '探针 · 电量查询（GetPower cmd 09/01，feat520 通道）…');
    } else {
      if (this.channelOf(this.dev) !== 'wireless') {
        devLog('warn', '该型号电量查询走 0x13 cmd 0x4A——仅 2.4G 无线通道应答（有线连接无响应）');
        return;
      }
      devLog('in', '探针 · 电量查询（0x4A）…');
    }
    await this.readBattery();
  },

  // 读灯光配置（0x44 十片）并按协议字段解码。configSummary 也供有线探针复用。
  async probeConfig() {
    return lock(async () => {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return null; }
    const dev = this.bestForLights();
    if (!this.canSend13(dev)) { devLog('er', '读配置需要 0x13 输出通道（2.4G 接收器）；有线键盘请用「有线命令扫描」探针'); return null; }
    devLog('in', '探针 · 读灯光配置（cmd 0x44 十片）…');
    const cfg = await H.readConfig(dev, devLog);
    if (!cfg) { devLog('er', '读配置失败（无应答或不完整）'); return null; }
    const info = this.configSummary(P.parseConfig(cfg, state.model));
    devLog('ok', `当前配置：${info}`);
    return cfg;
    });
  },

  // 读键位层（cmd 0x41，读改写流程的读半边）。槽数 = max(matrix)+1（matrix 为固件槽位，
  // 非键数——Hi75 为 90 槽 > 82 键）
  async probeKeymap(layer = 0) {
    return lock(async () => {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return; }
    const { model } = state;
    if (!model?.keys?.length) { devLog('er', '未加载型号（键数未知），无法读键位层'); return; }
    const dev = this.bestForLights();
    if (!this.canSend13(dev)) { devLog('er', '读键位层需要 0x13 输出通道（2.4G 接收器）'); return; }
    const slotCount = Math.max(...model.keys.map((k) => k.matrix)) + 1;
    devLog('in', `探针 · 读键位层 ${layer}（cmd 0x41，${slotCount} 槽 × dword）…`);
    const bytes = await H.readMatrix13(dev, layer, slotCount * 4, devLog);
    if (!bytes) { devLog('er', '键位层读取失败（无应答）'); return; }
    const words = [];
    for (let i = 0; i + 4 <= bytes.length && words.length < 8; i += 4) {
      words.push(((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
    }
    devLog('ok', `层${layer} 键位表 ${bytes.length / 4} 槽，前 8 个 dword：${words.map((w) => w.toString(16).padStart(8, '0')).join(' ')}`);
    return bytes;
    });
  },

  // 有线命令族扫描（520B feature 帧，cmd 83-8A 只读遍历）+ 配置解码
  async probeWiredStores() {
    return lock(async () => {
    if (this.mode !== 'hid') { devLog('er', '探针需要真机模式'); return; }
    const dev = (this.hidDevs ?? []).find((d) => d?.opened && (H.hasFeatureReport(d, 6) || H.hasFeatureReport(d, 9)));
    if (!dev) { devLog('er', '有线探针需要声明 feature report 6/9 的接口（520B 帧通道）'); return; }
    devLog('in', '探针 · 有线命令族扫描（feat520 读 83-8A × sub 0-2，各 400B）…');
    const res = await H.hidReadConfigWired(dev, devLog);
    if (res?.blob) devLog('ok', `有线配置命中 cmd ${res.cmd.toString(16)}/${res.sub}：${this.configSummary(P.parseConfig(P.blobToFrames(res.blob), state.model))}`);
    return res;
    });
  },

  // 配置解码摘要（0x13 十片 / 有线 400B blob 通用；fw26 效果字节已反映射回 UI 号）
  configSummary(c) {
    if (!c) return '解析失败（帧不完整）';
    const { fxName, fxOffName } = i18n;
    const effectName = c.effect === 0 ? fxOffName() : c.effect === 21 ? fxName(19) : fxName(c.effect);
    const color = c.colorMode === 0x01 ? '单色/RGB' : c.colorMode === 0x03 ? '炫彩' : `模式${c.colorMode}`;
    const sleep = c.sleepMin != null ? `${c.sleepMin} 分钟` : `索引${c.frames[0][13]}`;
    // 效果参数对（亮度,速度|颜色号nibble）——官方驱动抓包对比的关键字节
    let pair = '';
    if (c.effect >= 1 && c.effect <= 18) {
      const blob = P.framesToBlob(c.frames);
      const off = 58 + 2 * (c.effect - 1);
      pair = ` · 参数对[${blob[off]},${blob[off + 1]}]`;
    }
    return `效果 SW#${c.effect}（${effectName}）· 色彩 ${color}${pair} · 去抖 ${c.debounce ?? '?'} 档 · Tap ${c.tapSens} 档 · 睡眠 ${sleep}`;
  },
};

// ---------- 适配诊断包 ----------
// 给 issue / 社区适配贡献者的一键只读快照（CONTRIBUTING.md 贡献路径②）：
// 环境、当前设备与已授权接口能力、最近一次型号识别结果（device.lastIdentify，由
// connect.js 在每次识别后写入）、完整日志。**不含宏内容/涂色等用户数据**（仅计数），
// 可直接作为附件公开上传。
export function buildDiagnostics() {
  const vp = (d) => `0x${(d?.vendorId ?? 0).toString(16).padStart(4, '0')}:0x${(d?.productId ?? 0).toString(16).padStart(4, '0')}`;
  const m = state.model;
  return {
    app: 'keyhub-diag', ver: 1,
    exported: new Date().toISOString(),
    build: BUILD,
    ua: navigator.userAgent,
    url: location.href,
    lang: state.lang ?? null,
    webhid: H.hidAvailable(),
    webusb: !!navigator.usb,
    device: {
      mode: device.mode,
      channel: device.dev ? device.channelOf(device.dev) : null,
      productName: device.dev?.productName ?? null,
      vidPid: device.dev ? vp(device.dev) : null,
      interfaces: (device.hidDevs ?? []).filter(Boolean).map((d) => ({
        productName: d.productName ?? null,
        vidPid: vp(d),
        opened: !!d.opened,
        reports: device.ifaceSummary(d),
      })),
    },
    model: m ? {
      slug: state.slug, name: m.name, short: m.short, fw: m.fw ?? null,
      keys: m.keys?.length ?? null, psd: m.psd ?? null,
      ledoptsRows: m.ledopts?.length ?? null, hasScreen: !!m.screen,
    } : null,
    devices: (state.devices ?? []).map((d) => ({ slug: d.slug, channel: d.channel ?? null, demo: !!d.demo })),
    lastIdentify: device.lastIdentify ?? null,
    macroCount: (state.macros ?? []).length, // 宏内容可能含用户输入，只报数量
    log: getLogs(),
  };
}

export function exportDiagnostics() {
  const name = `keyhub-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  download(name, JSON.stringify(buildDiagnostics(), null, 2));
  devLog('ok', `适配诊断包已导出：${name}（${getLogs().length} 行日志）——提交 issue 时请作为附件上传`);
}
