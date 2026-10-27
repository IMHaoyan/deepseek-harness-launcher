# 桌面快捷键模式（`desktopShell`，默认开启）

DSHL 通过 `dsh web` 加载 DSH 页面。默认情况下 DSH 判定自己是 **web runtime**：快捷键受浏览器白名单
限制（`Ctrl+B` 之类单修饰键组合不可绑定），部分桌面能力缺失。本模式让 DSHL 扮演"桌面壳"，
只补 DSH 需要的桥能力，不改 DSH 安装、不改 profile 里它自己的配置。

```jsonc
// ~/.dsh/dshl/config.json（控制台「通用 → 桌面快捷键模式」读写这个键）
{ "desktopShell": true }
```

- **默认开启**：新装与升级后自动生效（升级时旧配置没有这个键 → 一次性开启并记 `desktopShellAutoEnabledFor`
  版本号；用户显式设 `false` 则永远尊重）。
- 开关只在**启动器启动**时读取：改完配置/点开关需要重启启动器（不是重启 DSH 服务）。
- `SELF_TEST`（自检）恒关，避免自检去改写真实 profile。
- 失败一律 fail-closed 回今天的 web runtime，行为与旧版完全一致。

## 激活闸门（默认开启后的安全件）

"开关打开" ≠ "本次已启用"。preload 只有在三件事同时成立时才写 `data-platform` 并暴露 `dshDesktop`：

1. 开关打开；
2. 快捷键桥就绪（DSH 安装树里的 `ShortcutPersistence` 能 import，且包版本一致）；
3. **登录辅助已被当前服务加载**。

第 3 条按服务世代取证：

| 服务来源 | 判定 |
|---|---|
| 自管（dshl spawn） | 启动前先装辅助 → 一定已加载，直接激活 |
| 认领的自重启后继 / 接管的外部实例 | Windows 上比较"服务进程启动时刻"与"辅助安装时刻"：启动晚于安装才算加载；拿不到证据 → 不激活 |

因此升级路径是安全的：

- **正常升级**（服务是自管的）：更新安装前停服 → 新启动器启动服务时先装辅助 → 本次直接 desktop runtime；
- **上次非受控退出留下 adopted 服务**：辅助装不进正在运行的服务 → 本次保持 web（登录行为不变），
  控制台提示「服务重启后生效」，下次服务重启自动切换。

状态与原因写进控制台「通用 → 桌面快捷键模式」的提示文字，并同步写日志
`desktop-shell: enabled/disabled（reason=...）`。

## 它提供什么 / 不提供什么

| 提供给 DSH | 说明 |
|---|---|
| `html[data-platform="win32"]` | `dsh-client-shortcuts` 的 `detectEnvironment()` 据此进 desktop runtime |
| `window.dshDesktop.keyboard` | 原生键盘事件桥：`subscribe` / `closeWindow`（快捷键先由主进程转给渲染层注册表） |
| `window.dshDesktop.shortcuts` | 键位持久化适配器：`get` / `edit` / `subscribe` / `recording` / `dispose` |

**刻意不提供**（2026-10-27 决策）：

- `updates` —— DSH 自带的桌面更新指示。DSHL 有自己的更新器，不需要第二份；也因此本模式
  **不会出现**桌面更新徽标/指示。代码依据：`ui-settings-general` 只在
  `carrier.protocolVersion === 1` 时才接 `carrier.updates`，未接线时
  `DesktopUpdateSource` 永远 idle，`DesktopUpdateIndicator` / `DesktopUpdateBadge` 都返回 `null`。
- `browser` / `protocolVersion` —— 侧边栏浏览器继续走 iframe 回落，不接管 Electron guest。
- `deviceInfo`（可选）—— 反馈表单回落 `navigator.userAgent`。

## 三个组成部分

1. **`browser-preload.js`**：同步 IPC 问主进程要配置（`dshl:desktop-shell:config`）；只有
   "开关打开 + 桥就绪 + 登录辅助已被当前服务加载 + 来源是本机 DSH 页" 全部成立才写 `data-platform`、
   暴露 `dshDesktop`。同步是必须的：标记要在页面脚本执行前就位；`data-platform` 用 MutationObserver
   等 `<html>` 出现后立刻写。`preloadConfig` 的 `loginReady` 缺省按 false 处理（fail-closed）。
2. **`desktop-shell.js`（主进程）**：从 DSH 安装树里 `import()` `@deepseek-ai/dsh-client-shortcuts/lib/protocol.js`，
   用它的 `ShortcutPersistence` 做键位持久化（文件：`%APPDATA%\DeepSeek Harness Launcher\keybindings.json`，
   `schemaVersion: 2` / `desktop:windows` profile）；负责 IPC 信任判定、键盘转发（带配置 revision 盖章）、
   录键期间暂停、关窗。**入口导出形状或包版本不一致时 fail-closed**。
3. **`assets/dshl-desktop-signin`（Host 侧登录辅助 bundle）+ `desktop-signin.js`**：desktop 分支下 DSH 不再
   自己预开登录标签页，只等浏览器回调。这个 bundle `watch` 账号尝试，发现 `waiting-browser` 的新
   `authorizeUrl` 就用系统默认浏览器打开；只在 DSHL 写的就绪标记（`<DSH_HOME>/dshl/desktop-shell.active`）
   存在时工作，否则严格 no-op。仅当开关打开、且服务停止期间，由主进程经
   `dsh plugin --profile web add link:<dir>` 安装；安装成功写 `~/.dsh/dshl/desktop-signin/state.json`
   （`version / installedAt`，激活闸门的时间证据来源）。

**就绪标记只由主进程在真正激活时写**（启动时无条件清残留、退出时撤掉），因此 web runtime 下登录插件
永远不会被唤醒。

## 已知行为变化（默认开启后）

DSH 一旦看到 `dshDesktop` 标记就会走桌面分支，以下变化是上游行为，**不是 DSHL 的 bug**：

- 账号登录改走 desktop 模式（由上面的 host bundle 打开授权页；失败时仍可"复制链接"兜底）。
- 首次运行会注入桌面版欢迎/引导覆盖层（进度存在 DSH 设置里；已有 `ui-settings-account` 配置
  `step: done` 的机器不会出现）。
- 模型 API Key 的 Web 自助引导不再注册（桌面版把那套交给原生壳；DSHL 没有实现）。
- 未设置过时，会话工作步骤展示默认从「详细」变「标准」。
- 客户端埋点从"浏览器不采集"变为可订阅 Host 策略流上报（是否上报取决于 Host 配置）。
- 第三方插件（如 ds-bot）界面文案可能显示 "DSH Desktop"。
- 桌面 profile 的默认键位与 web 不同：`Ctrl+B` 展开/收起左侧栏、`Ctrl+Comma` 打开设置、
  `Ctrl+N` 新会话等；web 时代的自定义键位（`web:windows` localStorage）不迁移。

## 键位迁移

`web:windows` 的旧自定义存在浏览器 localStorage，**不会**迁移到 `desktop:windows` 的
`keybindings.json`；默认开启后从桌面默认键位开始。想保留旧习惯需要手工重设一次。

## 升级 / 回滚

- 升级安装包：更新流程会先停自管服务 → 新启动器启动服务时装/校验收助 → 直接进桌面模式。
- 关闭：控制台「通用 → 桌面快捷键模式」关掉（或 config `"desktopShell": false`）→ **重启启动器**生效；
  本会话保持现有桌面运行时（界面提示「重启启动器后生效」），下次启动时落闸并撤掉就绪标记，
  登录插件退回 no-op。辅助 bundle 留在 profile 里但不再生效。
  需要彻底移除时执行 `dsh plugin --profile web remove dshl-desktop-signin`。
- 桥与 DSH 版本不匹配：`desktop-shell: disabled（reason=bridge-not-ready）`，页面回 web，不带病启动。

## 验证清单

- 新装/升级后：设置 → 通用 → 编辑快捷键，`Ctrl+B` 可用；控制台开关提示「已生效」；无更新指示/徽标。
- 录键时按键不被 DSHL 抢走；重启启动器后键位仍在（`keybindings.json` 落盘）。
- 账号菜单 → 登录：默认浏览器打开平台授权页，回调完成后弹窗自动关闭。
- 关闭开关重启：页面回到 web runtime（无 `data-platform`、登录恢复预开标签页流程）。
- adopted 服务场景：控制台提示「服务重启后生效」，登录保持网页模式；重启服务后自动切换。
- 日志关键字：`desktop-shell:`、`[desktop-signin]`。

## 排障要点

- **preload 的同步 IPC 通道必须在任何窗口创建前注册**（`desktopShell.registerConfigChannel` 在
  main.js 模块加载期就调用）。否则渲染进程会卡在 `sendSync` 上，连 `did-finish-load` 都不到——
  SELF_TEST 的早退分支曾因此挂死。
- 桥就绪晚于页面加载（接管已有服务、环境后装）时，`markDesktopShellReady()` 会在激活后重载一次标签页。
- 服务停止/意外退出/交接裁决时闸门会落下并撤标记；不要绕过 `setDesktopShellGate` 直接写标记文件。
- 辅助的 payload 目录按版本号落盘（`desktop-signin/<version>`）：改插件代码必须 bump
  `assets/dshl-desktop-signin/package.json` 的 `version`，否则缓存目录不会刷新。
