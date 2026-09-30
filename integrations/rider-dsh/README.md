# Rider ↔ DSH Web IDE Bridge (prototype)

这是两个独立插件，不修改 dshl 的启动器代码，也**不依赖 JetBrains Rider MCP server**。

- `rider-plugin/`：Rider 编辑器选区监听与右键 **Send to DSH**；只观察当前项目内文件。
- `dsh-plugin/`：DSH Web Host 接收 Rider 事件；Web Client 用 DSH 正式的 `slash/input-insert-text` 草稿事件插入，绝不自动提交；首个模型 step 注入短期编辑器上下文。

## 已验证范围（2026-09-23）

- DSH `0.1.7-alpha.2`：安装在**隔离**的 `DSH_HOME`，插件 Host 启动、随机端口 descriptor、loopback Bearer 校验、未认证的 Web 请求 401；Playwright 浏览器中原草稿和发送过来的选区共存，没有自动提交。
- Rider：用本机 Rider 2026.2.2 的 SDK/JBR 编译通过（磁盘安装目录名仍是 2023.3.4），JAR 的 `META-INF/plugin.xml` 与 class 条目已核对。
- **尚未验证**：在你的实际 Rider 2026.x 内安装/点右键，以及 dshl 的 Electron WebView 里运行。没有更改日常 `~/.dsh/profiles/web`、Rider 插件目录、PATH 或注册表。

## 实际安装（如需启用）

1. 确认 `dsh --version` 为已测试的 `0.1.7-alpha.2`。新版本接口可能漂移，先在隔离 profile 复测，不要盲目覆盖。
2. 在 Rider 的 Settings → Plugins → Install Plugin from Disk 中选择 `rider-plugin/build/dsh-rider-bridge.jar`，重启 Rider。`rider-plugin/build.ps1 -RiderHome <本机 Rider 目录>` 可重新编译；默认使用当前 Rider 2026.2.2 SDK（磁盘安装目录名仍是 2023.3.4）。
3. 在 DSH **web** profile 中安装本地包：
   ```powershell
   dsh plugin --profile web add "file:C:/Users/gonghaoyan/Desktop/dshl/integrations/rider-dsh/dsh-plugin"
   ```
   这一步是安装插件，不是升级 dsh；升级 dsh 仍应使用 dshl 的“更新 dsh”按钮。关闭并重新启动 dshl 管理的 DSH 服务，使 Host 与 Web Client 同时生效。
4. Rider 与 DSH 选择同一工作目录下的文件和会话。Rider 右键发送后切回 DSH 当前会话：文本插入**未发送草稿**。要让模型自动获知当前文件/选区，Rider 保持项目活动；上下文只在下一轮模型请求前读取，不会改动草稿。

> 不要在运行中的主 profile 上用本目录直接试装而不确认版本；当前只在隔离 profile 做了完整 Web 端验证。

## 行为与失败边界

- Rider 自动上报当前文件、选区和行号；选区正文限 32 KiB，模型请求注入限 4 KiB，状态 30 秒失效。仅用户右键时才进入待插入队列，120 秒无人接收就丢弃。
- 只有一个健康 DSH 实例才发出 Rider POST；多个实例**拒绝猜测目标**。DSH Web 页面只在可见、获得焦点且当前会话工作目录包含目标文件时领取。短期租约和浏览器 ACK 避免多数重复；浏览器刚插入但 ACK 丢失时跨页面的严格 exactly-once 尚未保证。
- 插入使用修订版本 CAS，若用户在异步接收期间修改草稿，会拒绝过期编辑而非覆盖；失败可在租约到期后重试。Rider 显示“入队”不冒充“已经插入”。
- 本机 descriptor 位于 `$DSH_HOME/rider-bridge`（默认 `~/.dsh/rider-bridge`），只存活于插件进程；包含独立随机 token，退出时按 owner 校验删除。DSH 浏览器 GET/ACK 复用 DSH 自身认证 cookie；Rider POST 严格限 loopback、Host 与 Bearer token。选区正文只在进程内存中保留，不落盘。
- `@"路径"` 是文件**引用**，不代表 Agent 已经读过磁盘；可能未保存的选区会另附正文。外部文件、UNC 路径和工作目录不匹配均不转发。

## 本地验证

```powershell
node --test integrations/rider-dsh/test/*.test.js
& integrations/rider-dsh/rider-plugin/build.ps1
```

Host 集成测试需要在 `dsh-plugin/node_modules` 装好该插件的依赖；未安装时该单项跳过。源码目录中可使用隔离测试 profile：设置临时 `DSH_HOME`，运行 `dsh web --dump-default-config` 初始化，随后 `dsh plugin --profile web add file:<绝对路径>`，`dsh web --no-open --port 0`。请勿把测试 profile 当成当前用户配置。

