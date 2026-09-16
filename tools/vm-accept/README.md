# VM 验收：官方 MSI 安装路径（Windows Sandbox）

这套东西用来在**一次性的真 Windows VM**里跑完"与官网 `.msi` 完全一致"的验收：真装官方 MSI →
逐项断言 MSI 留下的全部痕迹 → 用 DSHL 自己的代码读回这台机器并断言决策 → 卸载并断言机器回到干净状态。

为什么要 VM：官方 MSI 是 `ALLUSERS=1` 的机器级安装（`ProductCode` 每个版本都不同、默认都装到
`C:\Program Files\nodejs`）。在**已经有 Node 的机器**上并装第二个版本会踩 Windows Installer 的经典坑
（两个产品共同宣称拥有同一目录，卸载其一会删掉文件）。所以验收必须在干净机器上做。

## 一次性前置（需要管理员 + 重启一次）

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All
# 然后重启（Windows Sandbox 必须在重启后才会就位）
```

若只想手动跑一条命令：

```powershell
pwsh -File tools\vm-accept\run-accept.ps1            # 启动沙箱、等报告、打印结论
pwsh -File tools\vm-accept\run-accept.ps1 -KeepOpen  # 保留沙箱窗口，便于进去手动看
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
| 痕迹 1 | `C:\Program Files\nodejs\node.exe` 存在且 `node -v` = `v22.23.2` | 落位 |
| 痕迹 2 | `HKLM\SOFTWARE\Node.js` 的 `InstallPath` + `Version` | 官方 MSI 写的标记 |
| 痕迹 3 | **机器 PATH** 含安装目录 | MSI `Environment` 表 `-*PATH` |
| 痕迹 4 | **用户 PATH** 含 `%APPDATA%\npm` | MSI `Environment` 表 `-PATH` |
| 痕迹 5 | 「应用和功能」出现 `Node.js 22.23.2` + `MsiExec` 卸载串 | 产品注册 |
| 痕迹 6 | 全体开始菜单目录 `…\Programs\Node.js` 有 ≥4 项 | `Shortcut` 表 |
| 痕迹 7 | `node_modules\npm\npmrc` = **23 字节** `prefix=${APPDATA}\npm` | 决定 npm 全局根 |
| 语义 | `npm config get prefix` = `%APPDATA%\npm` | 全局根 |
| 语义 | 全新进程里 `node -v` / `npm -v` 可用（机器 PATH 生效） | PATH |
| 语义 | `npm i -g is-number` 落在 `%APPDATA%\npm\node_modules` | 全局包落点 |
| 语义（`-InstallDsh`） | 真装 `@deepseek-ai/dsh` → 落在 `%APPDATA%\npm`，`dsh.cmd --version` 可用 | 我们要的那条链 |
| DSHL 代码 | `readInstalledNodeMsi()` 读回 22.23.2 | 注册表读取 |
| DSHL 代码 | `decideNodeInstallPlan`：已装 MSI → `reuse`；旧版 MSI → `refuse` | 决策层 |
| DSHL 代码 | `detectEnv` 在本机识别到 Node 22.23.2（source/path 真实） | 探测层 |
| 卸载 | `msiexec /x {D9606E8F-…} /qn` 退出码 0，且安装目录 / 机器 PATH / 用户 PATH / 注册项全部清干净 | 与 MSI 一致的可卸载性 |

## 产物

- `%USERPROFILE%\Desktop\dshl-vm-accept\vm-accept-report.txt` / `.json`：逐条结论
- `vm-accept-transcript.txt`：完整控制台转录
- `msi-install.log` / `msi-uninstall.log`：msiexec 的 `/l*v` 详细日志
- `dshl-probe.json`：DSHL 代码在这台真机上的读回结果

## 最近一次验收（2026-09-16，Windows Sandbox · Windows 11 企业版 26200）

**27/27 全绿。** 要点：

- 包身份：`node-v22.23.2-x64.msi`（30.3 MB），sha256 `ce9572ae220c345f…` —— 与官方 `SHASUMS256.txt` 一致
- `msiexec /i … /qn /norestart` 退出码 0；`node -v` = `v22.23.2`
- 痕迹齐全：`C:\Program Files\nodejs\`、`HKLM\SOFTWARE\Node.js`（InstallPath + Version）、**机器 PATH**、**用户 PATH 的 `%APPDATA%\npm`**、「应用和功能」`Node.js 22.23.2` + `MsiExec.exe /I{D9606E8F-…}`、全体开始菜单 6 项、**npmrc 23 字节** `prefix=${APPDATA}\npm`
- 语义：`npm config get prefix` = `%APPDATA%\npm`；**新 shell 里** `node -v` / `npm -v` = `v22.23.2` / `10.9.8`；`npm i -g is-number` 落在 `%APPDATA%\npm\node_modules`
- DSHL 代码在真机上：`readInstalledNodeMsi()` 读回 22.23.2；已装 MSI → `reuse`；旧版 MSI → `refuse`；`detectEnv` → `node=ok/22.23.2`
- 卸载：`msiexec /x {ProductCode} /qn` 退出码 0，安装目录 / 机器 PATH / 用户 PATH / 注册项全部清干净

> 踩过的坑（已修进脚本）：第一轮 24/26，两条 FAIL 是**同一个测试缺陷** —— MSI 只改注册表里的 PATH，
> 而安装它的那个进程的环境变量不会刷新，于是"新 shell 里能不能用 node"和"DSHL 能不能探到 node"
> 在旧环境里断言必然失败。现在脚本会先按注册表重建 `PATH`（等价于新登录的 shell）再断言。

## 事后

Windows Sandbox 是可随时关闭的一次性环境；如果不想留着这个系统功能，用管理员执行
`Disable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM` 再重启即可。
