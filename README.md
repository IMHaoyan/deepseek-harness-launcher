# DeepSeek Harness Launcher（DSHL）

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）的 Windows 托盘启动器：常驻托盘，负责 DSH Web 服务的启停与看护、运行环境一键安装、消息通知与自动更新。

支持 **Windows 10/11（64 位）**。macOS / Linux 的代码保留在仓库中，但未测试，暂不承诺可用。

> 本项目完全由 DeepSeek Harness 搭载 DeepSeek 模型通过 Vibe coding 得到。

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/ui-1.png" alt="启动器面板：服务状态、余额与常用入口" width="100%"></td>
    <td width="50%"><img src="docs/screenshots/ui-2.png" alt="设置页：缩放、主题、端口、插件市场与版本更新" width="100%"></td>
  </tr>
</table>

## 安装与使用

1. 从 [Releases](https://github.com/IMHaoyan/deepseek-harness-launcher/releases) 下载最新 `dshl-<版本>.exe` 并安装（免管理员权限，**无需预装 Node.js / npm / DSH**）。
2. 首次启动若检测到运行环境缺失，会自动打开「运行环境」页，点击**一键安装缺失环境**即可（自动安装 Node.js 与 DSH，全程进度与日志，失败自动回退国内镜像）。
3. 环境就绪后自动启动服务并打开 DeepSeek Harness 窗口；此后托盘常驻、开机自启。
4. 卸载：控制面板 → 卸载程序。用户数据保留在 `~/.dsh`（配置、日志、会话数据）。

安装包未做代码签名，SmartScreen 提示「未知发布者」时选择**更多信息 → 仍要运行**。

## 功能

**服务管理**
- 托盘一键启动 / 停止 / 打开 DSH，接管已在运行的服务；退出启动器时只停止自己拉起或已认领看护的服务，外部实例保持不动。
- 端口被占用时先做 HTTP 指纹校验：确认是 DSH 才接管，否则拒绝启动并推荐空闲端口，一键切换，绝不误杀。
- 服务意外退出自动重启（10 秒冷却，10 分钟内最多 5 次）；服务反复启动失败时自动回退到上一个正常配置，仍失败则停止自动恢复并提示。
- 在 DSH 内点「重启服务」不会被误判成崩溃：启动器识别出换了进程的同签名服务并继续看护，状态行区分「由本工具启动 / 服务自重启后已接管 / 接管外部服务」。
- 面板状态行区分「正在启动服务… / 正在停止服务… / 服务正在自动重启… / 运行中 / 已停止」，启停过程中按钮禁用。

**运行环境**
- 自动识别 Node.js 与 DSH 的四种安装形态（源码 / 全局 npm / 托管 / npx），缺失或版本过低时引导一键安装。
- 一键安装使用官方发行包（校验 SHA256，失败回退镜像），装入用户级目录并写入用户 PATH，全程零管理员权限。

**更新**
- 启动器自身：静默检查 GitHub Releases，后台下载，退出重启自动安装。
- DSH：静默保持最新版（24 小时节流）；更新前先停服务、更新后重启并强制重载页面，避免旧进程与新文件混用导致白屏。新版启动失败或版本不符时自动回滚到旧版。

**其他**
- **余额查询**：主页直接显示 DeepSeek 余额，每 3 分钟自动刷新，零配置读取 DSH 凭据；接口与密钥可在设置页覆盖。
- **插件市场**：设置页一键安装 DSH 内置的可视化插件市场（`dshmarket`），装完自动重启服务生效；新版本首次启动默认安装。
- **通知**：DSH 完成 / 提问时托盘闪烁提醒，点击直达对话；窗口聚焦时静默不打扰。
- **问题反馈**：面板内填写后一键发送给作者，自动附带版本、环境与日志（日志已脱敏）。
- **诊断**：日志自动轮转（保留 3 份），异常退出自动生成脱敏诊断报告。

## 开发者

```powershell
npm install            # 安装依赖
npm run build:assets   # 首次或修改 ui-src 后生成 wwwroot 产物
npm start              # 开发模式运行（--panel 启动后直接弹出面板）
npm run dev            # 热更新：改 ui-src 自动重建并刷新面板，改主进程文件自动重启
npm test               # 单元测试（node --test，零依赖）
npm run selftest       # 端到端自检（临时 DSH_HOME + 3999 端口，不影响正在运行的服务）
npm run envcheck       # 脱离 Electron 的环境探测（退出码 0 就绪 / 1 缺失 / 2 错误）
npm run dist:win       # 打包 NSIS 安装包 → dist/dshl-<版本>.exe
npm run release        # 构建 + 创建 GitHub Release 并上传产物
```

VS Code 打开仓库即可使用内置的 `.vscode/launch.json`（Ctrl+Shift+D 选择配置后 F5）：主进程调试、主进程 + 渲染进程调试、自检。启动前请先退出正在运行的启动器（单实例锁）。

调试 UI：面板内按 **F12** 或右键 →「打开开发者工具」；配合 `npm run dev` 改样式即时生效。详见 `.vscode/launch.json` 注释。

### 目录结构

```
main.js              主进程：托盘、服务生命周期、IPC、更新接线
preload.js           面板渲染进程桥（contextIsolation + sandbox）
browser-preload.js   独立窗口（WebContentsView）桥
env-detect.js        环境探测（Node + DSH 安装形态 + 通知插件）
env-install.js       一键安装引擎（Node 发行包 + DSH 全局安装）
updater.js           启动器自动更新（electron-updater）
dsh-update.js        DSH 版本检测、更新与回滚
balance.js           DeepSeek 余额查询
market.js            插件市场（dshmarket 安装 / 卸载）
service-stop-guard.js 服务停止防重入与看门狗
service-handover.js  DSH 自重启后继的识别与认领判据（纯函数）
redact.js            日志 / 反馈 / 诊断统一脱敏
run-guard.js         活跃运行证据（非正常退出检测）
lifecycle.js         生命周期事件日志
health.js            健康快照与崩溃回退
diagnostics.js       诊断报告
ui-src/              面板源码（index.html / styles.css / app.js）
wwwroot/             构建产物（由 ui-src 生成，随仓库提交）
assets/              图标与随包插件
tests/               单元测试
tools/               构建、开发、发布与校验脚本
```

### 配置

`~/.dsh/dshl/config.json`（首次运行自动生成）。常用字段：

| 字段 | 说明 |
|---|---|
| `theme` | 主题：`light` / `dark` / `system` |
| `port` | 服务端口，`0` = 默认 3080 |
| `dshVersion` | 一键安装锁定的 DSH 版本，默认 `latest` |
| `nodeMajor` | 安装的 Node 主版本，默认 22 |
| `nodePath` / `harnessRoot` | 手动指定 Node 路径 / DSH 源码仓库根目录 |
| `nodeMirror` / `npmRegistry` | 下载源与 npm 源覆盖（默认镜像优先、失败回退官方） |
| `balanceApiKey` / `balanceBaseUrl` | 余额查询的密钥与接口覆盖（默认自动读取 DSH 配置） |
| `feedbackWebhook` | 反馈通道覆盖（通道地址随安装包内置） |

其余字段为窗口几何与内部记账，由程序自动维护。

## 维护者：发布新版本

发布说明必须遵守 [`docs/release-notes-style.md`](./docs/release-notes-style.md)：标题为纯版本号，正文按 新增 / 优化 / 调整 / 修复 / 移除 分组，每条一行、动词开头，只写用户可感知的变化。

1. 更新 `package.json` 的 `version`，按规范写好说明，提交并推送；
2. 执行发布（脚本会补上 `## vX.Y.Z — <日期>` 版本头并打印最终说明）：

```powershell
npm run release "**新增**\n- 设置页新增…\n\n**修复**\n- 修复…"
```

前置条件：工作区干净、已 `git push origin main`、已安装并登录 GitHub CLI。产物为 `dshl-<版本>.exe` / `.blockmap` / `latest.yml`，客户端依据 `latest.yml` 自动更新。

## 已知限制

- 安装包未做代码签名，SmartScreen 会提示「未知发布者」。
- Windows 开发模式（`npm start`）的通知来源显示为 "Electron"，安装版显示产品名。
- Defender 排除项需一次 UAC 授权；Windows 11 开启「篡改保护」时无法添加（系统限制，仅记录日志）。

## 许可证

[MIT](./LICENSE)
