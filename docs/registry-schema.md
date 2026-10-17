# 型号注册表 Schema（assets/models/）

KeyHub 的键盘适配数据（「处方」）是**纯数据 JSON**，不含任何可执行内容。本目录即社区共建的型号注册表：新增一个键盘型号 = 提交一个目录 + 清单条目，无需改动任何 JS 代码。

```
assets/models/
  index.json          # 注册表清单：识别入口（PSD/VID/PID 匹配）+ 连接过滤的数据源
  <slug>/
    model.json        # 型号适配数据（布局/灯效/FN 层/动画）
    keyimg.png        # 布局底图（来自官方驱动导出，需标注来源）
```

数据由 `tools/convert.mjs` 从官方驱动的 KB.ini 自动生成；贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)。入库前用 `node tools/validate-registry.mjs` 校验（CI 同款闸门）。

---

## index.json（顶层数组，每型号一条）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `slug` | string | ✓ | 注册表 ID，等于目录名（目录安全字符 `[A-Za-z0-9_.-]`） |
| `name` | string | ✓ | 官方驱动 KB.ini `Name=`（可能跨型号重名，如 Hi98 两代） |
| `short` | string | ✓ | KB.ini `ShortName=`，UI 展示名 |
| `sub` | string | ✓ | 副标题（人工撰写的一句卖点） |
| `keys` | number | ✓ | **物理键数** = model.json `keys[]` 中可见条目（`r[2] > r[0]`）的数量，≠ 数组长度 |
| `psd` | int[6] | ✓ | 识别签名，KB.ini `Psd=` 逐字节十六进制解析后以十进制存储（如 `0x03 0xA2` → `[3,0,0,0,0,162]`）。**识别的主键** |
| `wired` | `{vid,pid}` \| null | ✓ | 有线 VID/PID（十进制）。WebHID/WebUSB 请求过滤与通道判别的数据源 |
| `wireless` | `{vid,pid}` \| null | ✓ | 2.4G VID/PID；`null` = 纯有线（hi98 先例）。注意个别型号的「无线」是键盘本体而非接收器（k65） |
| `source` | `{vendor, driver}` | ✓ | 驱动来源：厂商与安装包名/版本（版权与溯源） |
| `attribution` | string | ✓ | keyimg.png 及驱动派生数据的版权/授权说明 |
| `contributor` | string | ✓ | 贡献者（GitHub ID 或昵称） |
| `added` | string | ✓ | 收录日期 `YYYY-MM-DD` |
| `dir` | string | — | 死字段：原驱动 KB.ini 所在子目录名，`convert.mjs` 全量重跑定位用；运行时零消费 |

## model.json 字段

### 识别与连接（必填）

| 字段 | 类型 | 说明 |
|---|---|---|
| `slug` / `name` / `short` / `sub` | string | 与 index.json 条目逐字相等（校验强制） |
| `psd` | int[6] | 同上；运行时只消费 index.json 副本，此处为源数据留档 |
| `vid` / `pid` | int | 有线 VID/PID，与 index `wired` 相等 |
| `vidW` / `pidW` | int（可选） | 2.4G VID/PID，与 index `wireless` 相等；纯有线型号省略 |
| `fw` | int | **协议代际**（KB.ini `Fw=`）。白名单：`24` = 520B feature report 6 族（LEOBOG 系）、`26` = report 9 族（银雕 K65）。**未知值校验直接拒绝**——协议分支未经逆向确认前不盲写硬件 |

### 结构（必填）

| 字段 | 类型 | 说明 |
|---|---|---|
| `layerNum` | int | 键位层数（现有型号均为 4：默认/FN1/FN2/Tap） |
| `ledMask` | int | 位掩码：bit(`ui`−1)=1 → 灯效槽 `ui` 固件未实现，UI 隐藏 |
| `ledopts` | array（现有型号均为 19 行） | 灯效表（KB.ini `LedOpt1..30`）：`{ui, fw, speed, light, dir, rand, color}`。`ui` 槽位号（唯一）、`fw` 固件效果字节（**必须至少含一行 `fw===0`** 的关灯行——`js/pages/light.js` 依赖它定位自定义槽插入点）、其余为能力布尔值（控制 UI 控件显隐）。校验强制 `ui` 唯一 + 必含关灯行，**不强制总行数**（≠19 行只报 WARN）。注意：该表在全部现有型号中逐字节相同，实为**协议族数据**；schema 暂保持逐型号内联，未来可改为按 `fw` 提供默认值 + 型号覆写 |
| `keys` | array | 键位表，见下 |
| `img` | `{w,h}` | keyimg.png 的像素尺寸（IHDR 实测，校验强制一致） |

#### keys[] 条目

| 字段 | 类型 | 说明 |
|---|---|---|
| `i` | int | 键索引，1 起严格升序唯一——全应用的交互主键（点击/涂色/perKey/fn1/动画 groups 引用） |
| `r` | int[4] | keyimg.png 像素坐标 `[left, top, right, bottom]`。可见键须 `r[2] > r[0]` 且完全落在 `img` 边界内；**旋钮虚键恒为 `[0,0,0,0]`**（隐身占位，参与矩阵写但不渲染不响应） |
| `vk` | int \| null | Windows 虚拟键码（宏录制时高亮物理键用）；特殊键为 null |
| `fn` | `{type, code, param}` | 层 0 默认功能。观察到 `type 2`（普通键）与 `type 9`（特殊 dword：媒体/LED/组合功能，编码在 `param`） |
| `matrix` | int | **固件键位矩阵槽位**（KB.ini 每键第 8 字段；驱动 BuildMacroBlob 按 `dword[4×matrix]` 寻址实证 + 2026-10-17 Hi98 Pro 真机逐槽比对），兼每键 RGB 寻址。**型号内唯一**（错误会把改键/灯光下到别的物理键上）。K 序号 ≠ 槽位（Hi75 K1→槽0、K2→槽12）；键位表长度 = `max(matrix)+1` 槽。**已知数据边界**（Hi98 Pro 实测）：小键盘簇/Home/End/ScrollLock 不在线键位表——KB.ini 给的尾部槽（96-110）固件实为重复映射区/空位，改这批键可能不生效 |

### 可选（有运行时容错先例）

| 字段 | 类型 | 说明 |
|---|---|---|
| `sleepTime` | int | 默认睡眠分钟数（hi86 省略，`??` 兜底） |
| `defLedIndex` | int | 默认灯效（可见效果列表中的 1 基序号；hi86 省略） |
| `screen` | `{w,h,maxFrames}` | 屏幕动画页参数（仅 k65 有；省略则隐藏该页） |
| `fn1` | object | 默认 FN 层指派：键索引（字符串）→ `{type, code, param}`；键必须存在于 `keys[].i` |
| `wheel` | `{mode, knobIndex}` | **旋钮能力位**（convert 自 KB.ini `WheelMode`/`KnobIndex`，被注释则整组空）。`mode > 0` 启用旋钮改键联动：任一层改指旋钮键时写 `Cfg[26]=6`（固件把旋钮当普通键——逆向自驱动 FillCfg 的 nWheelMode），恢复默认写 0；`knobIndex` 为 **0 基**（对应 `keys[].i - 1`）。侧灯不做：官方驱动确有 SideLED 配置代码，但全 9 个 KB.ini 均无侧灯键（仅 Hi75 有 `ShowLED=0` 显式关）——官方未对任何型号开放；实物侧灯条若存在则由主 RGB 矩阵驱动（矩阵槽位多于可见键），每键 RGB 已可达 |
| `animations` | object | `et/<name>` 与 `cartoon/<name>` → 帧数组 `[{groups: int[][], color: [r,g,b] \| null}]`；`groups` 引用 `keys[].i`。运行时目前仅做**存在性检查**（`cartoon/flower` 存在 → 「花开富贵」走表驱动下发路径） |

### 死字段（运行时零消费；保留以对齐 KB.ini 源，全量重跑 convert 不丢数据）

`dir`（原驱动子目录）、`channelMask`、`show`（`power/music/musicUI/tapTip/debounce`）、`colors`、`gaoshouKeys`、`gaoshouIndex`、`brightness`、`speed`，以及 `ledopts[].dir` / `ledopts[].light`。

---

## 关键约定（校验强制）

1. **纯数据**：注册表 JSON 不得含任何可执行内容；应用对注册表数据只做数据消费。
2. **PSD 唯一性**：注册表内 PSD 全局查重；两型号撞车时必须具备区分字段（键数或 `name` 不同），否则拒绝合并。撞车型号在运行时进入候选消歧（用户对照布局图终审）。
3. **协议代际白名单**：`fw` 未知值拒绝入库。新代际需先逆向确认（见 `js/device/protocol.js` 的协议注释与 `tools/find-psd.mjs`），加白名单后开放。
4. **旋钮虚键约定**：`r=[0,0,0,0]` 隐身；index 的 `keys` 计数 = 可见条目数。
5. **交叉一致**：index.json 与 model.json 的 `psd/vid/pid/name/short` 必须逐字相等；`slug` 必须等于目录名；`img` 必须等于 keyimg.png 的 IHDR 尺寸。
6. **几何合法**：可见键矩形落在底图内；`matrix` 型号内唯一；`i` 升序唯一。
7. **溯源**：`source/attribution/contributor/added` 必填——keyimg.png 与驱动派生数据必须标注来源与版权。

## 校验

```bash
node tools/validate-registry.mjs        # 本地校验（CI 同款）
node --input-type=module --check < js/main.js   # 单文件语法检查
```

CI（`.github/workflows/validate.yml`）对每个 PR/push 运行注册表校验 + 全 JS 模块语法检查，全部零依赖。
