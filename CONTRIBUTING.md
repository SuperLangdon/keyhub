# 贡献指南 / Contributing

KeyHub 的键盘适配数据存放在 `assets/models/`（**型号注册表**）：一个键盘型号 = 一个数据目录 + `index.json` 里的一条登记，全部是**纯数据 JSON，不含可执行代码**——新增型号不需要改动任何 JS 代码。字段规范见 [docs/registry-schema.md](docs/registry-schema.md)。

本方案（SinoWealth 中颖系固件）的键盘品牌众多，官方驱动几乎都是同一套 OemDrv 换皮，因此**绝大多数键盘只要有官方驱动就能低成本适配**。按你手头的条件三选一：

## 路径① 有官方驱动（主推，约 10 分钟）

1. 拿到键盘的官方驱动安装包（品牌官网/卖家提供的 `xxx Setup.exe`），用 7-Zip / InnoExtract 解包到仓库外任意目录（如 `D:\drv\mykeyboard`），确认里面有 `Dev\kb\`（单型号驱动直接是 `Dev\kb\KB.ini`）。
2. 增量转换并登记你的名字：
   ```bash
   node tools/convert.mjs "D:\drv\mykeyboard" --contributor "你的GitHubID"
   ```
   未收录过的型号会自动派生 slug 收录（`assets/models/<slug>/` + `index.json` 条目），副标题先用驱动名占位。
3. 本地校验（CI 同款闸门）：
   ```bash
   node tools/validate-registry.mjs
   ```
4. 人工核对：打开 `assets/models/<slug>/keyimg.png` 对照实物键盘逐区检查布局与键数；顺手润色 `index.json` 里该条目的 `sub`（一句卖点）与 `source`（品牌与驱动版本）。
5. `git add assets/models/ && git commit && git push`，提 PR。CI 会再跑一遍校验，通过即合并——合并后所有用户立即可以连接这款键盘（VID/PID 与识别数据均来自注册表）。

> 注意：`keyimg.png` 与 KB.ini 派生数据版权归原作者，仅用于互操作适配；`index.json` 的 `attribution` 字段必须如实标注来源（校验强制）。

## 路径② 手里只有键盘

1. 用 Chrome/Edge 打开 KeyHub，连上键盘（2.4G 接收器或数据线）点「添加新设备」。
2. 识别失败时，手动向导里会出现「帮社区适配这款键盘 →」：
   - **导出适配诊断包**：环境、接口能力、识别 PSD、完整日志的只读 JSON 快照（不含宏等用户数据）；
   - **复制 issue 模板**：自动填入识别到的 PSD。
3. 到仓库 Issues 用 [适配请求模板](.github/ISSUE_TEMPLATE/adapter-request.md) 提交，附上诊断包与键盘正面实拍。
4. 等待有驱动/真机的贡献者按路径①接力。

## 路径③ 协议逆向（进阶）

遇到新协议代际（`validate-registry` 会以「未知 fw」拒绝入库）或新命令族时：

- 协议注释集中在 `js/device/protocol.js`（每条命令的逆向出处都标了来源），逆向辅助工具 `tools/find-psd.mjs`（OemDrv 反汇编）可复用。
- 先提 issue 附诊断包讨论，确认命令语义并真机验证后，再：协议实现进 `protocol.js`/`webhid.js` → `fw` 白名单同步加进 `tools/validate-registry.mjs` 的 `KNOWN_FW` → 文档更新。

## 注册表规则（校验强制，详见 schema 文档）

- **PSD 唯一性**：两个型号 PSD 撞车时必须具备区分字段（键数或名称），否则拒绝合并；撞车型号运行时会弹候选对话框由用户对照布局图终审。
- **协议代际白名单**：`fw` 未知值拒绝入库——未经逆向确认不向硬件盲写。
- **溯源必填**：`source / attribution / contributor / added` 四个字段缺一不可。
- **纯数据**：注册表 JSON 不得含任何可执行内容。

## 本地校验

```bash
node tools/validate-registry.mjs                       # 注册表（CI 同款）
node --test tools/test/protocol.test.mjs               # 协议层单元测试（CI 同款）
node --input-type=module --check < js/任意模块.js      # 单文件语法检查
node tools/bump-build.mjs                              # 改了 js 之后刷新构建标记（git 短哈希 + 日期）
```

CI（`.github/workflows/validate.yml`）对每个 PR/push 自动运行注册表校验、协议单测与全 JS 模块语法检查，零依赖、无需安装任何包。
