# KeyHub 设计系统

本文件描述 KeyHub 的界面设计约定。**token 的唯一权威来源是 `css/app.css` 的 `:root` / `:root[data-theme="dark"]`**——本文是它的叙述与使用规则；两者冲突时以 CSS 为准。

## 总览

KeyHub 是工具型应用（键盘驱动），视觉目标：安静、克制、以内容（键盘布局图、报文日志）为主角。

- **画布**：暖奶油底（`--canvas` #f7f7f4），不用纯白；卡片用纯白（`--card` #ffffff）在画布上浮起半级。
- **文字**：暖近黑墨色（`--ink` #26251e）做标题与强调，正文 `--body` #5a5852，次级 `--muted` #807d72——全站无纯黑 #000。
- **唯一强调色**：橙（`--primary` #f54e00），只用于主 CTA、选中态、品牌标。一处一屏，克制使用；按压态用 `--primary-active` #d04200。
- **深度表达**：只用 1px 细线（`--hairline` 三档）分层，不用投影/渐变。
- **语义色**：成功 `--success` #1f8a65 / 警告 `--warn` #9a6700 / 错误 `--error` #cf2d56，只用于状态指示，不承担品牌职能。

## 夜间主题

同一 token 体系整体替换（`data-theme="dark"`）：暖黑画布 #1c1b18，墨色反转为 #e9e7de，橙色提亮为 #ff5c14。所有组件只允许引用 token，禁止写死颜色——夜间主题靠变量自动成立。

## 字体

**零外部字体依赖**（不请求任何字体 CDN，站点可完全离线）：

- Sans（界面）：`--font-sans` = `system-ui, -apple-system, "Segoe UI", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif`——西文随平台（SF/Segoe），中文由苹方/雅黑承接。
- Mono（报文/十六进制/数值）：`--font-mono` = `ui-monospace, "Cascadia Mono", Consolas, "JetBrains Mono", monospace`——HID 调试台、配置 dwords、VID:PID 等一律 mono。

字重只用 400/500/600；标题靠字号与颜色分层，不靠加粗（正文标题 600 封顶）。

## 圆角与控件

- 圆角 token：`--r-xs` 4px / `--r-sm` 6px / `--r-md` 8px（按钮、输入框默认）/ `--r-lg` 12px（弹窗卡片）/ `--r-pill`（药丸标签）。
- 按钮：主按钮橙底白字；普通按钮透明底细线边；危险操作（恢复出厂、清空）红色系。8px 圆角是"开发者工具"的口音，不做大圆角。
- 弹窗：`modal-mask` 毛玻璃遮罩 + 白卡（`.modal`）居中；所有动态弹窗过 `ui.js modalA11y()`（role=dialog / Esc / 焦点管理）。
- 页签（`.tab`）：`<button>` 元素，选中态墨底反白；键盘可达（focus-visible 描边）。

## 品牌标

- 方标（sidebar logo / mark.svg）：墨色圆角 tile + 奶油色 Key 字 + 橙色键帽块；夜间主题用 `--mark-tile` / `--mark-key` 变量反转。
- 宽标（门禁/欢迎页）：`logo-wide.svg`（浅色）/ `logo-wide-dark.svg`（深色）二选一显示。
