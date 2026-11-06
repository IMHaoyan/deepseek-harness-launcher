# 开发与发布

面向想改代码、发版本的人。普通用户只需要看 [README](../README.md)。

## 本地开发

```powershell
npm install            # 安装依赖
npm run build:assets   # 首次或修改 ui-src 后生成 wwwroot 产物
npm start              # 开发模式运行（--console 启动后直接打开控制台）
npm run dev            # 热更新：改 ui-src 自动重建并刷新控制台，改主进程文件自动重启
npm test               # 单元测试（node --test，零依赖）
npm run selftest       # 端到端自检（临时 DSH_HOME + 3999 端口，不影响正在运行的服务）
npm run envcheck       # 脱离 Electron 的环境探测（退出码 0 就绪 / 1 缺失 / 2 错误）
npm run dist:win       # 打包 NSIS 安装包 → dist/dshl-<版本>.exe
npm run release        # 构建 + 创建 GitHub Release 并上传产物
```

用 VS Code 打开仓库即可使用内置的 `.vscode/launch.json`（Ctrl+Shift+D 选择配置后 F5）：F5 运行的是当前 workspace 的源码，不是 `dist` 安装包；开发配置使用独立的 `.dev-user-data`，避免 Electron 单实例锁冲突；`DSH_HOME` 仍指向真实 `~/.dsh`，F5 前建议先托盘退出已安装版，避免两个启动器同时管理同一 DSH 服务。要验证打包产物，请直接运行 `dist\win-unpacked\DeepSeek Harness Launcher.exe` 或安装 `dist\dshl-*.exe`。

调试 UI：控制台内按 **F12** 或右键 →「打开开发者工具」；配合 `npm run dev` 改样式即时生效。详见 `.vscode/launch.json` 注释。

## 目录结构

```
main.js               主进程：托盘、服务生命周期、IPC、更新接线
preload.js            控制台渲染进程桥（contextIsolation + sandbox）
console-surface.js    控制台 WebContentsView 生命周期（唯一窗口内全页覆盖）
browser-preload.js    独立窗口（WebContentsView）桥
env-detect.js         环境探测（Node + pnpm + DSH 安装形态 + 通知插件）
env-install.js        一键安装引擎（Node 发行包 + pnpm + DSH 全局安装）
updater.js            启动器自动更新（electron-updater）
dsh-update.js         DSH 版本检测、更新与回滚

market.js             插件市场（dshmarket 安装 / 卸载）
plugin-switch.js      插件启停（写 profile 的 cordis.patch.yml，不卸载即可关闭）
bridge.js             远程连接（DSH Bridge Next 安装 / 卸载，随包 payload）
service-stop-guard.js 服务停止防重入与看门狗
service-handover.js   DSH 自重启后继的识别与认领判据（纯函数）
service-listener.js   监听 PID 取证：netstat 解析 + Get-NetTCPConnection 兜底 + found/absent/unknown 三态（可注入 IO）
notify-policy.js      通知分类开关与"每版本只提醒一次"策略（纯函数）
redact.js             日志 / 反馈 / 诊断统一脱敏
run-guard.js          活跃运行证据（非正常退出检测）
crash-note.js         崩溃提示的展示与"知道了"记账
start-progress.js     启动步骤文案与进度打点
lifecycle.js          生命周期事件日志
health.js             健康快照与崩溃回退
diagnostics.js        诊断报告
ui-src/               控制台源码（index.html / styles.css / console.css / app.js）
wwwroot/              构建产物（由 ui-src 生成，随仓库提交）
assets/               图标；assets/bridge-next 为随包分发的远程连接 payload
docs/                 发布说明规范与截图
tests/                单元测试
tools/                构建、开发、发布与校验脚本
```

## 新增插件

插件管理页由主进程注册表驱动，不要求为每个插件写专用 DOM：

**推荐插件（npm 分发，最常见）**：

1. 在 `main.js` 的 `MANAGED_NPM_PLUGINS` 里补一条描述（`id` / `order` / `npm` 包名 / 名称 / 说明 / 图标 / 分类；要默认代装再加 `autoInstall: true`）；
2. 动作分支不用改：`runManagedPluginAction()` 按 `id` 在注册表里查表，`install` / `uninstall` / `update` / `reinstall` / `enable` / `disable` 全部通用（插件市场与手机连接是另两张固定卡片）；
3. 只加插件条目不需要重建产物（`wwwroot` 由 `ui-src` 生成，注册表在主进程）；改了 `ui-src` 才要执行 `npm run build:assets`。安装、卸载、更新检查、启停开关、状态卡片全部由通用逻辑生成，无需改 `ui-src/app.js`，也不需要新写安装器模块（启停要求 bundle patch 使用标准的 `insert:` 行；若 bundle 还带有对别的插件的 `disabled: true`（carrier），DSHL 会自动写反向覆盖并在关闭时恢复那些行）。

**随启动器分发或需要专用逻辑的插件**：在 `buildPluginCatalog()` 中补一条描述，并在 `runManagedPluginAction()` 中补对应动作分支（如现有的 `dshmarket`、`bridge-next`）。

插件操作、默认代装集合与排障的细节见 [internals.md](./internals.md#插件管理)。

## 配置

`~/.dsh/dshl/config.json`（首次运行自动生成）。常用字段：

| 字段 | 说明 |
|---|---|
| `theme` | 主题：`light` / `dark` / `system` |
| `port` | 服务端口，`0` = 默认 3080 |
| `dshVersion` | 一键安装锁定的 DSH 版本，默认 `latest` |
| `pnpmVersion` | 安装/对齐的 pnpm 版本，默认 `11.8.0` |
| `nodeMajor` | 安装的 Node 主版本，默认 24（目标 Node.js 24 LTS；能复用的现有 Node 22 不会被重装） |
| `nodePath` / `harnessRoot` | 手动指定 Node 路径 / DSH 源码仓库根目录 |
| `nodeMirror` / `npmRegistry` | 下载源与 npm 源覆盖（默认镜像优先、失败回退官方） |
| `dshChannel` | DSH 更新渠道：`latest`（默认）/ `alpha` |
| `launcherChannel` | 启动器更新渠道：`latest`（默认）/ `alpha` |
| `launcherUpdateSource` | 启动器更新源：`auto`（默认，GitHub 优先、失败回退国内加速）/ `github`（只用官方）/ `domestic`（只用国内源） |
| `launcherUpdateMirror` | 自建国内镜像 base（可选，末尾 `/`；需同时提供 `latest.yml` / `alpha.yml` 与安装包、blockmap）；配置后国内源即该镜像，不再使用公共加速代理 |
| `launcherUpdateSourceOk` | 上次成功的更新源记账（内部维护，用于下次优先，不要手改） |
| `notifyCategories` | 三类系统通知的开关：`{ service, recovery, update }` |
| `pluginPendingRestart` | 已改但还没重启生效的插件变更（控制台顶部提示条用） |
| `pluginNotes` | 各插件的本地备注 |
| `remoteConnect` | 远程连接开关：`{ enabled, autoEnabledFor, declined }`。默认开启；旧配置无此字段时升级后自动开启并记录到 `autoEnabledFor`；用户手动关闭会置 `declined`，不会被自动开启重新打开 |
| `desktopShell` | 桌面快捷键模式，**默认开启**（旧配置升级后一次性自动开启并记 `desktopShellAutoEnabledFor`；`SELF_TEST` 恒关；显式设 `false` 永远尊重）。开启后 DSH 以 desktop runtime 运行（快捷键白名单不再生效，可绑 `Ctrl+B` 等），登录授权页由随包 host bundle 打开；**不提供** DSH 自带的桌面更新指示。控制台「通用 → 桌面快捷键模式」可开关（重启启动器生效）；桥或登录辅助未就绪时自动保持网页模式，不会出现"快捷键可用但登录退化"的半套状态。边界、副作用与验证清单见 [desktop-shell.md](./desktop-shell.md) |
| `feedbackWebhook` | 反馈通道覆盖（通道地址随安装包内置） |

其余字段为窗口几何与内部记账，由程序自动维护。

## 维护者：发布新版本

> **发布由维护者决定，不是改动的收尾动作。** 改完代码、跑通测试、提交推送 ≠ 可以发版：
> 只有维护者明确说「发包」时才执行 `npm run release`，且**执行前必须先征求维护者同意** ——
> 发出去的 prerelease 会被所有 alpha 渠道的机器自动更新，撤回成本远高于多问一句。
> 协作者 / 自动化 agent 可以做到「提交并推送」，但**不得自行发布**。

发布说明必须遵守 [release-notes-style.md](./release-notes-style.md)：标题为纯版本号，正文按 新增 / 优化 / 调整 / 修复 / 移除 分组，每条一行、动词开头，只写用户可感知的变化。

1. 更新 `package.json` 的 `version`，按规范写好说明，提交并推送；
2. 执行发布（脚本会补上 `## vX.Y.Z — <日期>` 版本头并打印最终说明）：

```powershell
npm run release "**新增**\n- 通用页新增…\n\n**修复**\n- 修复…"
```

前置条件：工作区干净、已 `git push origin main`、已安装并登录 GitHub CLI。

**渠道由版本号决定**（脚本按它选 yml 与 GitHub 发布类型，写错会直接拒绝发布）：

| `package.json` 版本号 | 渠道 | 产物 yml | GitHub Release | 谁会收到 |
|---|---|---|---|---|
| `1.4.5-alpha.1` | `alpha` | `alpha.yml` | prerelease、不占 Latest | 把「启动器更新渠道」选成 alpha 的机器 |
| `1.4.5` | `latest` | `latest.yml` | 正式 Release（占 Latest） | 所有默认（latest 渠道）机器；选 alpha 的也会拿到 |

日常开发**默认发 alpha**：把版本号写成 `x.y.z-alpha.N` 再跑 `npm run release` 即可。正式版（版本号无预发布段）会推给所有机器，所以脚本额外要求显式加 `--stable` 确认一次，避免版本号忘了改成 alpha 就把未验证的构建发出去。历史上的 `-rc.N` 会被 electron-updater 当成「自定义渠道」而忽略（`rc.yml` 不会分发给任何渠道），脚本已停用这种写法。

> 默认的「国内加速回退」不需要发布侧做任何事：公共加速代理直接读 GitHub Releases（`releases/latest/download/` 别名）。只有配置了自建镜像（`launcherUpdateMirror`）才需要额外把 `latest.yml` / `alpha.yml` 与安装包、blockmap 同步到镜像目录。
