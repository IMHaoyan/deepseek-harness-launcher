# DSHL 使用量统计接收端

Cloudflare Worker + D1，只接收并聚合 5 个字段：

| 字段 | 示例 |
|---|---|
| `dshlVersion` | `1.4.15` |
| `dshlChannel` | `latest` / `alpha` / `unknown` |
| `dshVersion` | `0.2.2-rc.2` |
| `dshChannel` | `latest` / `alpha` / `unknown` |
| `windowsVersion` | `Windows 11 23H2` |

**没有安装 ID、设备指纹、时间戳、主机名、文件路径、对话或日志。**

## 匿名边界（必须如实告知用户）

- Worker 代码不读取 `CF-Connecting-IP`、不读取 `request.cf`、不把来源 IP 写库或写日志；
- Cloudflare 网络层/平台访问日志仍可能看到连接来源，这不在 Worker 代码控制范围内；
  需要进一步收敛时，请在 Cloudflare 控制台关闭或缩短访问日志，并配置 WAF 速率限制；
- 没有安装 ID，因此**只能统计"上报样本量"，不能跨日去重，也不等于独立用户数**；
- 数据库只存 `(day, 版本组合) -> 计数`，不存逐条报告。

## 部署（在你的 Cloudflare 账号里执行）

```powershell
cd C:\Users\gonghaoyan\Desktop\dshl\stats

# 1. 登录你的 Cloudflare 账号（浏览器授权）
npx wrangler login

# 2. 创建 D1 数据库，把返回的 database_id 填进 wrangler.toml
npx wrangler d1 create dshl-stats

# 3. 建表
npx wrangler d1 execute dshl-stats --remote --file=schema.sql

# 4. 设置后台管理 Token（自己生成一串足够长的随机值）
npx wrangler secret put ADMIN_TOKEN

# 5. 部署
npx wrangler deploy
```

部署完成后你会拿到类似 `https://dshl-stats.<你的子域>.workers.dev` 的地址。

**建议再绑定自定义域名**（例如 `stats.example.com`），并把该地址填进
`main.js` 的 `USAGE_STATS_URL` 常量，然后重新打包发版。

## 查看数据

浏览器打开 Worker 地址（`/` 或 `/admin`），输入 `ADMIN_TOKEN` 后加载：

- 概览：统计周期内上报样本量、版本组合数；
- 每日上报样本；
- DSHL 版本分布、DSH 版本分布、更新渠道分布、Windows 版本分布。

Token 只保存在当前标签页的 `sessionStorage`，不会写入 Worker。

## 本地联调（可选）

```powershell
npx wrangler dev --local
# 另开一个终端（只对回环地址允许 http）：
curl -X POST http://127.0.0.1:8787/v1/report -H "content-type: application/json" `
  -d '{"dshlVersion":"1.4.15","dshlChannel":"latest","dshVersion":"0.2.2-rc.2","dshChannel":"alpha","windowsVersion":"Windows 11 23H2"}'
```

## 启用状态

当前默认关闭且界面不露出入口。接收端可达性确认后，再恢复控制台入口与默认开关。
