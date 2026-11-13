// stats/worker.js — DSHL 使用量统计接收端（Cloudflare Worker + D1）
//
// 数据最小化：
//   - 只接受 5 个字段：dshlVersion / dshlChannel / dshVersion / dshChannel / windowsVersion；
//   - 不读取 request.cf，不读取 CF-Connecting-IP，不把来源 IP 写库或写日志；
//   - 数据库只存"按天 + 版本组合"的聚合计数，不存逐条报告，也没有安装 ID。
// 注意：Worker 代码不采集 IP，不代表 Cloudflare 网络层/平台访问日志看不到连接来源；
//       如需进一步收敛，请在 Cloudflare 侧关闭/缩短访问日志并配置 WAF 速率限制。

const MAX_BODY_BYTES = 1024
const FIELD_RE = /^[\x20-\x7E]{1,48}$/
const FIELDS = ['dshlVersion', 'dshlChannel', 'dshVersion', 'dshChannel', 'windowsVersion']
const DAYS_KEPT = 400

export function validateReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== FIELDS.length) return null
  const out = {}
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return null
    const text = typeof value[field] === 'string' ? value[field].trim() : ''
    if (!FIELD_RE.test(text)) return null
    out[field] = text
  }
  return out
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

async function handleReport(request, env) {
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > MAX_BODY_BYTES) return json({ ok: false, error: 'too-large' }, 413)
  let text
  try { text = await request.text() } catch { return json({ ok: false, error: 'unreadable' }, 400) }
  if (text.length > MAX_BODY_BYTES) return json({ ok: false, error: 'too-large' }, 413)
  let parsed
  try { parsed = JSON.parse(text) } catch { return json({ ok: false, error: 'invalid-json' }, 400) }
  const report = validateReport(parsed)
  if (!report) return json({ ok: false, error: 'invalid-fields' }, 400)

  const day = new Date().toISOString().slice(0, 10)
  try {
    await env.DB.prepare(
      `INSERT INTO daily_counts
         (day, dshl_version, dshl_channel, dsh_version, dsh_channel, windows_version, reports)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(day, dshl_version, dshl_channel, dsh_version, dsh_channel, windows_version)
       DO UPDATE SET reports = reports + 1`,
    ).bind(
      day, report.dshlVersion, report.dshlChannel, report.dshVersion, report.dshChannel, report.windowsVersion,
    ).run()
  } catch {
    return json({ ok: false, error: 'storage-unavailable' }, 503)
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

// 常量时间比较：避免通过响应时间探测 token 前缀。
function tokenMatches(expected, given) {
  const a = String(expected || '')
  const b = String(given || '')
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function bearerOf(request) {
  const header = request.headers.get('authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(header)
  return m ? m[1].trim() : ''
}

async function handleSummary(request, env) {
  if (!tokenMatches(env.ADMIN_TOKEN, bearerOf(request))) return json({ ok: false, error: 'unauthorized' }, 401)
  const since = new Date(Date.now() - DAYS_KEPT * 86400000).toISOString().slice(0, 10)
  try {
    const [daily, byDshl, byDsh, byChannel, byWindows, totals] = await Promise.all([
      env.DB.prepare(
        `SELECT day, SUM(reports) AS reports FROM daily_counts WHERE day >= ? GROUP BY day ORDER BY day DESC`,
      ).bind(since).all(),
      env.DB.prepare(
        `SELECT dshl_version AS version, dshl_channel AS channel, SUM(reports) AS reports
           FROM daily_counts WHERE day >= ? GROUP BY dshl_version, dshl_channel ORDER BY reports DESC`,
      ).bind(since).all(),
      env.DB.prepare(
        `SELECT dsh_version AS version, dsh_channel AS channel, SUM(reports) AS reports
           FROM daily_counts WHERE day >= ? GROUP BY dsh_version, dsh_channel ORDER BY reports DESC`,
      ).bind(since).all(),
      env.DB.prepare(
        `SELECT dshl_channel AS launcherChannel, dsh_channel AS dshChannel, SUM(reports) AS reports
           FROM daily_counts WHERE day >= ? GROUP BY dshl_channel, dsh_channel ORDER BY reports DESC`,
      ).bind(since).all(),
      env.DB.prepare(
        `SELECT windows_version AS windowsVersion, SUM(reports) AS reports
           FROM daily_counts WHERE day >= ? GROUP BY windows_version ORDER BY reports DESC`,
      ).bind(since).all(),
      env.DB.prepare(
        `SELECT COUNT(*) AS combinations, SUM(reports) AS reports FROM daily_counts WHERE day >= ?`,
      ).bind(since).first(),
    ])
    return json({
      ok: true,
      since,
      totals: { reports: Number(totals?.reports || 0), combinations: Number(totals?.combinations || 0) },
      daily: daily.results || [],
      byDshlVersion: byDshl.results || [],
      byDshVersion: byDsh.results || [],
      channels: byChannel.results || [],
      windows: byWindows.results || [],
    })
  } catch {
    return json({ ok: false, error: 'query-failed' }, 503)
  }
}

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSHL 使用量统计</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f8fb; color: #1e293b;
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { margin: 0 0 4px; font-size: 22px; color: #0369a1; }
  p.sub { margin: 0 0 24px; color: #64748b; }
  .card { background: #fff; border: 1px solid #dbe4ee; border-radius: 12px; padding: 18px 20px; margin-bottom: 18px; }
  .card h2 { margin: 0 0 12px; font-size: 15px; color: #0369a1; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: end; }
  label { display: block; font-size: 12px; color: #64748b; margin-bottom: 4px; }
  input { width: 320px; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; }
  button { padding: 8px 16px; border: 0; border-radius: 8px; background: #0369a1; color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #eef2f7; }
  th { color: #64748b; font-weight: 500; font-size: 12px; }
  td.num, th.num { text-align: right; }
  .kpis { display: flex; gap: 28px; flex-wrap: wrap; }
  .kpi b { display: block; font-size: 24px; color: #0f172a; }
  .kpi span { color: #64748b; font-size: 12px; }
  .note { color: #b45309; font-size: 12px; margin-top: 8px; }
  #status { color: #b91c1c; min-height: 20px; }
</style>
</head>
<body>
<main>
  <h1>DSHL 使用量统计</h1>
  <p class="sub">只按天聚合版本与系统信息，没有安装 ID，不保存来源 IP。</p>
  <section class="card">
    <div class="row">
      <div><label for="token">管理 Token</label><input id="token" type="password" autocomplete="off" placeholder="部署时设置的管理 Token"></div>
      <button id="load">加载</button>
    </div>
    <div id="status"></div>
    <div class="note">每天最多上报一次的样本量；没有安装 ID，因此不能跨日去重，也不等于独立用户数。</div>
  </section>
  <section class="card"><h2>概览</h2><div class="kpis" id="kpis"></div></section>
  <section class="card"><h2>每日上报样本</h2><table id="daily"></table></section>
  <section class="card"><h2>DSHL 版本分布</h2><table id="dshl"></table></section>
  <section class="card"><h2>DSH 版本分布</h2><table id="dsh"></table></section>
  <section class="card"><h2>更新渠道</h2><table id="channels"></table></section>
  <section class="card"><h2>Windows 版本</h2><table id="windows"></table></section>
</main>
<script>
const FIELDS = {
  daily: ['day', 'reports'],
  dshl: ['version', 'channel', 'reports'],
  dsh: ['version', 'channel', 'reports'],
  channels: ['launcherChannel', 'dshChannel', 'reports'],
  windows: ['windowsVersion', 'reports'],
};
function table(id, rows) {
  const el = document.getElementById(id);
  const cols = FIELDS[id];
  const head = '<tr>' + cols.map(c => '<th' + (c === 'reports' ? ' class="num"' : '') + '>' + c + '</th>').join('') + '</tr>';
  const body = (rows || []).map(r => '<tr>' + cols.map(c => '<td' + (c === 'reports' ? ' class="num"' : '') + '>' + String(r[c] ?? '') + '</td>').join('') + '</tr>').join('');
  el.innerHTML = head + (body || '<tr><td colspan="' + cols.length + '">暂无数据</td></tr>');
}
document.getElementById('load').addEventListener('click', async () => {
  const token = document.getElementById('token').value.trim();
  sessionStorage.setItem('dshlStatsToken', token);
  const status = document.getElementById('status');
  status.textContent = '';
  try {
    const res = await fetch('/api/summary', { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) { status.textContent = '加载失败：' + (body.error || res.status); return; }
    document.getElementById('kpis').innerHTML =
      '<div class="kpi"><b>' + body.totals.reports + '</b><span>统计周期内上报样本</span></div>' +
      '<div class="kpi"><b>' + body.totals.combinations + '</b><span>版本组合数</span></div>' +
      '<div class="kpi"><b>' + body.since + '</b><span>统计起始日（UTC）</span></div>';
    for (const key of ['daily', 'dshl', 'dsh', 'channels', 'windows']) {
      table(key, key === 'daily' ? body.daily : key === 'dshl' ? body.byDshlVersion : key === 'dsh' ? body.byDshVersion : key === 'channels' ? body.channels : body.windows);
    }
  } catch (error) {
    status.textContent = '加载失败：' + error.message;
  }
});
document.getElementById('token').value = sessionStorage.getItem('dshlStatsToken') || '';
</script>
</body>
</html>`

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/v1/report') return handleReport(request, env)
    if (request.method === 'GET' && url.pathname === '/api/summary') return handleSummary(request, env)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
      return new Response(ADMIN_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    return json({ ok: false, error: 'not-found' }, 404)
  },
}
