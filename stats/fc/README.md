# DSHL 使用量统计（阿里云 FC + OTS）

国内可达版本：函数计算 FC 3.0 提供 HTTPS 入口，表格存储 OTS 存数据。

## 数据口径

只接收 5 个字段：

| 字段 | 示例 |
|---|---|
| `dshlVersion` | `1.4.15` |
| `dshlChannel` | `latest` / `alpha` / `unknown` |
| `dshVersion` | `0.2.2-rc.2` |
| `dshChannel` | `latest` / `alpha` / `unknown` |
| `windowsVersion` | `Windows 11 23H2` |

- 没有安装 ID、设备指纹、主机名、文件路径、对话或日志；
- 不读取、不保存来源 IP；
- OTS 每条报告一行，主键是 `日期#随机串`（随机串不关联设备），后台按天扫描后聚合；
- 没有安装 ID，所以统计口径是「上报样本量」，不是独立用户数。

## 前置条件

1. 阿里云账号，已开通**函数计算 FC**与**表格存储 OTS**；
2. 一个 **OTS Serverless 实例**（地域建议 `cn-hangzhou`），并开启公网访问；
3. 一个 RAM 用户 AccessKey，至少具备：
   - `AliyunFCFullAccess`（或等价的 FC 创建/更新/调用权限）
   - `AliyunOTSFullAccess`（或仅目标实例的读写/建表权限）

> 建议只给这个 RAM 用户最小权限，不要用主账号 AccessKey。

## 部署步骤

### 1. 安装依赖

```powershell
cd C:\Users\gonghaoyan\Desktop\dshl\stats\fc
npm install
```

### 2. 配置 OTS 环境变量

```powershell
$env:OTS_ENDPOINT   = 'https://<实例名>.cn-hangzhou.ots.aliyuncs.com'
$env:OTS_INSTANCE   = '<实例名>'
$env:OTS_TABLE      = 'dshl_stats'
$env:OTS_AK_ID      = '<RAM AccessKey ID>'
$env:OTS_AK_SECRET  = '<RAM AccessKey Secret>'
```

### 3. 建表

```powershell
node tools/create-table.js
```

### 4. 配置 Serverless Devs 凭据

```powershell
npx @serverless-devs/s config add
```

按提示填 `AccessKeyID` / `AccessKeySecret`，别名用 `default`。

### 5. 部署函数

```powershell
$env:ADMIN_TOKEN = '<至少 32 位随机串>'
npx @serverless-devs/s deploy
```

部署成功后，输出里会有类似：

```text
https://dshl-stats-<随机>.<region>.fcapp.run
```

这就是上报与后台地址。

### 6. 验证

```powershell
$base = 'https://<部署输出的地址>'
curl.exe -X POST "$base/v1/report" -H "content-type: application/json" `
  -d '{"dshlVersion":"1.4.15","dshlChannel":"latest","dshVersion":"0.2.2-rc.2","dshChannel":"latest","windowsVersion":"Windows 11 23H2"}'
curl.exe -H "Authorization: Bearer $env:ADMIN_TOKEN" "$base/api/summary"
```

浏览器打开 `$base/`，粘贴 `ADMIN_TOKEN` 查看后台。

### 7. 切到 DSHL

把 `main.js` 的 `USAGE_STATS_URL` 改成 `$base/v1/report`，重新打包发版。

## 注意

- 默认域名有调用频率/带宽限制，适合起步；长期建议绑定已备案的自定义域名。
- FC 的 HTTP 触发已设置为匿名访问；统计接口本身是公开写入的，恶意重复请求可以抬高样本量，后续可在 API 网关或 WAF 层加限流。
- 函数环境变量里保存 OTS AccessKey；如果在意长期凭据，改用 FC 服务角色 + RAM 角色授权 OTS，可去掉 AK。
