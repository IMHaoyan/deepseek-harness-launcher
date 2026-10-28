# VM 验收：官方 MSI 安装路径（Windows Sandbox）

这套东西用来在**一次性的真 Windows VM**里跑完"与官网 `.msi` 完全一致"的验收：真装官方 MSI →
逐项断言 MSI 留下的全部痕迹 → 用 DSHL 自己的代码读回这台机器并断言决策 → 卸载并断言机器回到干净状态。
本轮（内置 Node 目标升到 **24.22.1 / Node.js 24 LTS**）起，脚本新增**「22 → 24 大版本升级」阶段**：
先装官方 22.23.2，再**直接**装内置 24.22.1（不先手工卸载 22，走官方 MSI 自带的 major upgrade），
断言旧产品被移除、全局包存活，最后卸载 24 并断言机器再次干净。

为什么要 VM：官方 MSI 是 `ALLUSERS=1` 的机器级安装（`ProductCode` 每个版本都不同、默认都装到
`C:\Program Files\nodejs`）。在**已经有 Node 的机器**上并装第二个版本会踩 Windows Installer 的经典坑
（两个产品共同宣称拥有同一目录，卸载其一会删掉文件）。所以验收必须在干净机器上做。

## 内置包身份与哈希（Node 24.22.1）

| 文件 | 大小 | sha256（官方 `SHASUMS256.txt` 一致） |
|---|---|---|
| `assets/node-dist/node-v24.22.1-x64.msi` | 31.8 MB | `3bda4baf1ee709b3…` |
| `assets/node-dist/node-v24.22.1-win-x64.zip` | 36.0 MB | `d2046d28c2c3dcd2…` |

升级阶段另行下载并校验的旧官方包：`node-v22.23.2-x64.msi`，sha256 `ce9572ae220c345f…`
（npmmirror 优先、nodejs.org 回退；仓库里若还留着同哈希的旧包，作为最后兜底）。

## 一次性前置（需要管理员 + 重启一次）

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
# 然后重启（Windows Sandbox 必须在重启后才会就位）
```

若只想手动跑一条命令：

```powershell
pwsh -File tools\vm-accept\run-accept.ps1                     # 启动沙箱、等报告、打印结论
pwsh -File tools\vm-accept\run-accept.ps1 -KeepOpen           # 保留沙箱窗口，便于进去手动看
pwsh -File tools\vm-accept\run-accept.ps1 -TimeoutMinutes 30  # 新增升级阶段后会多装/卸一轮，慢机器留足时间
```

沙箱配置见 [WindowsSandbox.wsb](WindowsSandbox.wsb)：仓库只读映射到 `C:\vm\repo`，
`%USERPROFILE%\Desktop\dshl-vm-accept` 可写映射到 `C:\vm\out`（报告与 msiexec 日志写回这里），
登录后自动执行 [accept-node-msi.ps1](accept-node-msi.ps1)，跑完自动关机。

## 断言清单（沙箱内 `accept-node-msi.ps1` 逐条产 PASS/FAIL）

| 组 | 断言 | 依据 |
|---|---|---|
| 包 | 内置 MSI 存在、`.sha256` 侧车一致、并等于宿主机下发的官方哈希 | `SHASUMS256.txt` |
| 前置 | 干净 VM：`HKLM\SOFTWARE\Node.js` 不存在 | 避免并装 |
| 安装 | `msiexec /i <msi> /qn /norestart` 退出码 0/3010 | 静默安装 |
| 痕迹 1 | `C:\Program Files\nodejs\node.exe` 存在且 `node -v` = `v24.22.1` | 落位 |
| 痕迹 2 | `HKLM\SOFTWARE\Node.js` 的 `InstallPath` + `Version` | 官方 MSI 写的标记 |
| 痕迹 3 | **机器 PATH** 含安装目录 | MSI `Environment` 表 `-*PATH` |
| 痕迹 4 | **用户 PATH** 含 `%APPDATA%\npm` | MSI `Environment` 表 `-PATH` |
| 痕迹 5 | 「应用和功能」出现 `Node.js 24.22.1` + `MsiExec` 卸载串 | 产品注册 |
| 痕迹 6 | 全体开始菜单目录 `…\Programs\Node.js` 有 ≥4 项 | `Shortcut` 表 |
| 痕迹 7 | `node_modules\npm\npmrc` = **23 字节** `prefix=${APPDATA}\npm` | 决定 npm 全局根 |
| 语义 | `npm config get prefix` = `%APPDATA%\npm` | 全局根 |
| 语义 | 全新进程里 `node -v` / `npm -v` 可用（机器 PATH 生效，`node -v` = `v24.22.1`） | PATH |
| 语义 | `npm i -g is-number` 落在 `%APPDATA%\npm\node_modules` | 全局包落点 |
| 语义（`-InstallDsh`） | 真装 `@deepseek-ai/dsh` → 落在 `%APPDATA%\npm`，`dsh.cmd --version` 可用 | 我们要的那条链 |
| DSHL 代码 | `readInstalledNodeMsi()` 读回 `24.22.1` | 注册表读取 |
| DSHL 代码 | `decideNodeInstallPlan`：已装 24 MSI → `reuse`；旧版 MSI（`18.20.0`，无版本管理器）→ `upgrade-msi` / `msi-too-old`；24 已装时 `envSummary.nodeUpgrade === null` | 决策层 |
| DSHL 代码 | `detectEnv` 在本机识别到 Node `24.22.1`（source/path 真实） | 探测层 |
| 卸载 | `msiexec /x {C4336CDB-…} /qn` 退出码 0，且安装目录 / 机器 PATH / 用户 PATH / 注册项全部清干净 | 与 MSI 一致的可卸载性 |
| **升级 0** | 升级阶段起点是干净机器（主流程卸载后）：无 `HKLM\SOFTWARE\Node.js`、无安装目录、无「应用和功能」条目；不干净则整段跳过（fail-closed，不并装第二个产品） | 避免并装 |
| **升级 1** | 下载官方 `node-v22.23.2-x64.msi` 并校验官方 sha256（镜像优先、官方源回退；旧包兜底也按同一哈希验） | `SHASUMS256.txt` |
| **升级 2** | 静默安装 22.23.2：退出码 0/3010；`node -v` = `v22.23.2`；`HKLM\SOFTWARE\Node.js` Version = `22.23.2`；「应用和功能」`Node.js 22.23.2`；旧 `ProductCode {D9606E8F-…}` 已注册；PATH 从注册表重建后可用 | 升级起点 |
| **升级 2.5** | 22 已装时探测层真的给出升级事实：`envSummary.nodeUpgrade = { mode:'msi', from:'22.23.2', targetMajor:24 }`（界面升级卡片的唯一来源） | 探测层 |
| **升级 2.6** | 显式升级决策：`decideNodeInstallPlan({ upgrade:true, 已装22 })` → `upgrade-msi`（from=22.23.2） | 决策层 |
| **升级 2.7** | 普通安装路径（nodeOk=true）仍是 `reuse` —— 不静默升级 | 决策层 |
| **升级 3** | 升级前在 `%APPDATA%\npm` 装一个小块全局包（`semver`），包与 shim 都在 | 全局包存活的前提 |
| **升级 4** | **不先卸载 22**，直接静默安装内置 24.22.1：退出码 0/3010；`node -v` = `v24.22.1`；`HKLM\SOFTWARE\Node.js` Version = `24.22.1` | MSI major upgrade |
| **升级 5** | 升级后「应用和功能」**只剩 1 条**且 DisplayVersion = `24.22.1`；旧 `ProductCode {D9606E8F-…}` 不再注册 | `RemoveExistingProducts` |
| **升级 6** | 升级前装的全局包仍在 `%APPDATA%\npm`（包目录 + shim），且 shim 可执行（`semver 1.2.3` → `1.2.3`） | 全局根未被升级破坏 |
| **升级 7** | 卸载 24 后：安装目录 / 机器 PATH / 用户 PATH / `HKLM\SOFTWARE\Node.js` / 「应用和功能」全部清干净 | 可卸载性 |

> 维护提醒：`accept-node-msi.ps1` 必须保持 **ASCII-only 且无 BOM**（Windows PowerShell 5.1 读无 BOM 的
> `.ps1` 会按 ANSI 解析，中文注释会乱码甚至改语义）。中文文档一律写在本文件里（宿主机侧）。

## 产物

- `%USERPROFILE%\Desktop\dshl-vm-accept\vm-accept-report.txt` / `.json`：逐条结论
- `vm-accept-transcript.txt`：完整控制台转录
- `msi-install.log` / `msi-uninstall.log`：主流程 msiexec 的 `/l*v` 详细日志
- `upgrade-22-install.log` / `upgrade-24-install.log` / `upgrade-24-uninstall.log`：升级阶段的 msiexec 日志
- `dshl-probe.json`：DSHL 代码在这台真机上的读回结果

## 最近一次验收

### 2026-10-28 · Node.js 24.22.1 + 22→24 major upgrade —— **57/57 全绿**

Windows Sandbox · Windows 11 企业版 build 26100，脚本为当前仓库版本（含升级阶段与升级卡片来源断言）。
报告产物在 `%USERPROFILE%\Desktop\dshl-vm-accept\vm-accept-report.txt`。

- **主流程（内置 24.22.1 MSI）**：静默安装退出码 0；`node -v` = `v24.22.1`（npm 11.19.1）；`HKLM\SOFTWARE\Node.js` Version=24.22.1；机器 PATH、用户 PATH `%APPDATA%\npm`；「应用和功能」`Node.js 24.22.1`；npmrc 23 字节；`npm config get prefix` = `%APPDATA%\npm`；全局包落在 `%APPDATA%\npm`；卸载后目录 / PATH / 注册项 / 条目全清。
- **DSHL 代码在真机上**：`readInstalledNodeMsi()` 读回 24.22.1；已装 24 → `reuse`；旧 MSI（18.20.0）→ `upgrade-msi` / `msi-too-old`；24 已装时 `envSummary.nodeUpgrade === null`；`detectEnv` → `ok/24.22.1`。
- **升级阶段（真实 major upgrade）**：下载并校验官方 22.23.2 MSI（sha256 `ce9572ae…`）→ 安装后 `node -v` = `v22.23.2`、`HKLM` Version=22.23.2、旧 ProductCode 已注册；**22 已装时 `envSummary.nodeUpgrade = { mode:'msi', from:'22.23.2', targetMajor:24 }`**（升级卡片的真实来源），显式升级决策 → `upgrade-msi`，普通安装路径仍 `reuse`（不静默升级）；升级前全局包 `semver` 已落 `%APPDATA%\npm`；**不卸载 22，直接静默安装 24** → 退出码 0、`node -v` = `v24.22.1`、`HKLM` Version=24.22.1、「应用和功能」只剩 **1** 条（24.22.1）、旧 ProductCode `{D9606E8F-…}` 消失、`semver` 包与 shim 存活且可执行（`semver 1.2.3` → `1.2.3`）；卸载 24 后全部清干净。

> 结论：官方 MSI 的 major upgrade 行为在真机验证通过 —— 升级旧 Node 不需要（也不应该）先手工卸载。

### 历史记录（旧版本，仅作参考）

2026-09-16，Windows Sandbox · Windows 11 企业版 26200，当时内置包是 `node-v22.23.2-x64.msi`，旧版脚本 **27/27 全绿**。要点（对应的是当时的脚本与断言，不是 24.22.1 的结果）：

- 包身份：`node-v22.23.2-x64.msi`（30.3 MB），sha256 `ce9572ae220c345f…` —— 与官方 `SHASUMS256.txt` 一致
- `msiexec /i … /qn /norestart` 退出码 0；`node -v` = `v22.23.2`
- 痕迹齐全：`C:\Program Files\nodejs\`、`HKLM\SOFTWARE\Node.js`（InstallPath + Version）、**机器 PATH**、**用户 PATH 的 `%APPDATA%\npm`**、「应用和功能」`Node.js 22.23.2` + `MsiExec.exe /I{D9606E8F-…}`、全体开始菜单 6 项、**npmrc 23 字节** `prefix=${APPDATA}\npm`
- 语义：`npm config get prefix` = `%APPDATA%\npm`；**新 shell 里** `node -v` / `npm -v` = `v22.23.2` / `10.9.8`；`npm i -g is-number` 落在 `%APPDATA%\npm\node_modules`
- DSHL 代码在真机上：`readInstalledNodeMsi()` 读回 22.23.2；已装 MSI → `reuse`；旧版 MSI → `refuse`（当时的行为，现行为 `upgrade-msi`）；`detectEnv` → `node=ok/22.23.2`
- 卸载：`msiexec /x {ProductCode} /qn` 退出码 0，安装目录 / 机器 PATH / 用户 PATH / 注册项全部清干净

> 踩过的坑（已修进脚本）：第一轮 24/26，两条 FAIL 是**同一个测试缺陷** —— MSI 只改注册表里的 PATH，
> 而安装它的那个进程的环境变量不会刷新，于是"新 shell 里能不能用 node"和"DSHL 能不能探到 node"
> 在旧环境里断言必然失败。现在脚本会先按注册表重建 `PATH`（等价于新登录的 shell）再断言。

## 事后

Windows Sandbox 是可随时关闭的一次性环境；如果不想留着这个系统功能，用管理员执行
`Disable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM` 再重启即可。
