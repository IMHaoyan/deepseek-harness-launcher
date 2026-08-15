// DSHL 启动器面板脚本：Electron IPC 桥 + 状态渲染
'use strict';

const $ = (id) => document.getElementById(id);

// Electron 桥（preload 暴露 dshBridge；invoke 异步返回 JSON 字符串）
async function cmd(name, value) {
  try {
    const result = await window.dshBridge.cmd(name, value);
    return result ? JSON.parse(result) : null;
  } catch (err) {
    console.error('[dshl] bridge error:', err);
    return null;
  }
}

const THEME_VALUES = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '亮色' },
  { key: 'dark', label: '暗色' },
];

// ---------- 缩放微调控件：按住左右拖动（5% 一格），双击变输入框（越界 clamp） ----------
function makeZoomWidget(id, min, max, cmdName) {
  const el = $(id);
  const ui = { dragging: false, editing: false, value: 100, startX: 0, startVal: 0, moved: false };
  const clamp5 = (v) => Math.min(max, Math.max(min, Math.round(v / 5) * 5));
  const setText = (v) => { el.textContent = v + '%'; };

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || ui.editing) return;
    ui.dragging = true;
    ui.moved = false;
    ui.startX = e.clientX;
    ui.startVal = ui.value;
    el.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!ui.dragging) return;
    const delta = e.clientX - ui.startX;
    if (Math.abs(delta) < 3) return;
    ui.moved = true;
    ui.value = clamp5(ui.startVal + Math.round(delta / 10) * 5); // 右滑加、左滑减，10px = 5%
    setText(ui.value);
  });
  window.addEventListener('mouseup', () => {
    if (!ui.dragging) return;
    ui.dragging = false;
    el.classList.remove('dragging');
    if (ui.moved) cmd(cmdName, ui.value);
  });

  el.addEventListener('dblclick', () => {
    if (ui.editing) return;
    ui.editing = true;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.step = 5;
    input.value = ui.value;
    input.className = 'zoom-input';
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ui.editing = false;
      input.remove();
      setText(ui.value);
    };
    const commit = () => {
      const v = parseInt(input.value, 10);
      if (Number.isInteger(v)) {
        ui.value = Math.min(max, Math.max(min, v)); // 越界 clamp（输入值不吸附步进）
        cmd(cmdName, ui.value);
      }
      finish();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') finish();
    });
    input.addEventListener('blur', commit);
  });

  return {
    setFromState(v) {
      if (ui.dragging || ui.editing) return;
      ui.value = v;
      setText(v);
    },
  };
}

const zoomWidgets = {
  launcher: makeZoomWidget('btnZoom', 50, 200, 'setZoom'),
  web: makeZoomWidget('btnWebZoom', 50, 300, 'setWebZoom'),
};

// ---------- 服务端口控件：双击变输入框（1024–65535），保存后服务自动切换端口 ----------
function initPortWidget() {
  const el = $('btnPort');
  const ui = { value: 3080, editing: false };
  const setText = () => { el.textContent = String(ui.value); };
  el.addEventListener('dblclick', () => {
    if (ui.editing) return;
    ui.editing = true;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = 1024;
    input.max = 65535;
    input.step = 1;
    input.value = ui.value;
    input.className = 'zoom-input';
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = () => { if (done) return; done = true; ui.editing = false; input.remove(); setText(); };
    const commit = () => {
      const v = parseInt(input.value, 10);
      if (Number.isInteger(v) && v >= 1024 && v <= 65535) {
        ui.value = v;
        cmd('setPort', v);
      }
      finish();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') finish();
    });
    input.addEventListener('blur', commit);
  });
  return {
    setFromState(v) {
      if (ui.editing || !Number.isInteger(v)) return;
      ui.value = v;
      setText();
    },
  };
}
const portCtl = initPortWidget();

function buildChips(containerId, items, checkedKey, onPick) {
  const container = $(containerId);
  container.textContent = '';
  for (const item of items) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = typeof item === 'object' ? item.label : item + '%';
    const key = typeof item === 'object' ? item.key : item;
    if (key === checkedKey) chip.classList.add('checked');
    chip.addEventListener('click', () => onPick(item));
    container.appendChild(chip);
  }
}

// 开关型 chip（消息提醒 / 开机自启）
function renderToggleChip(id, enabled, labelOn, labelOff) {
  const chip = $(id);
  chip.textContent = enabled ? labelOn : labelOff;
  chip.classList.toggle('checked', enabled);
}

// cssZoom：主进程已按平台校正过的实际 CSS 缩放值
function applyZoom(cssZoom) {
  document.documentElement.style.zoom = (cssZoom / 100).toString();
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode; // system|light|dark（CSS 处理 system+系统暗色）
}

function showPage(name) {
  $('pageMain').classList.toggle('hidden', name !== 'main');
  $('pageSettings').classList.toggle('hidden', name !== 'settings');
  $('pageLog').classList.toggle('hidden', name !== 'log');
  $('pageEnv').classList.toggle('hidden', name !== 'env');
  if (name === 'env') {
    // 打开环境页：拉取安装任务快照 + 强制重新检测
    void cmd('envGetState').then((s) => { if (s) renderEnvSnapshot(s); });
    void cmd('envDetect');
  }
}

function render(state) {
  window._running = !!state.running;

  // 面板副标题显示版本号（确认运行的是哪个构建）
  const verEl = $('panelVersion');
  if (verEl && state.version) verEl.textContent = `启动器面板 v${state.version}`;

  // 状态
  const running = window._running;
  const rowDot = $('statusRowDot');
  const rowWrap = $('statusText');
  $('portWarnCard').classList.add('hidden');
  if (running) {
    rowWrap.className = 'value strong status-value running';
    rowDot.className = 'dot running';
    const origin = state.owned ? '由本工具启动' : '接管外部服务';
    $('statusRowText').textContent = `运行中（${origin}）`;
    $('statusRowText').title = '';
  } else if (state.blocked) {
    // 端口被非 DSH 程序占用：拒绝接管，也不允许启动
    rowWrap.className = 'value strong status-value stopped';
    rowDot.className = 'dot stopped';
    $('statusRowText').textContent = '已停止（端口被占用）';
    $('statusRowText').title = state.blocked;
    // 警示卡：完整原因 + 一键换到建议的空闲端口
    $('portWarnCard').classList.remove('hidden');
    $('portWarnDetail').textContent = state.blocked;
    const suggested = Number.isInteger(state.suggestedPort) && state.suggestedPort > 0 ? state.suggestedPort : 0;
    window._suggestedPort = suggested;
    const sw = $('btnPortSwitch');
    sw.classList.toggle('hidden', !suggested);
    if (suggested) sw.textContent = `换到端口 ${suggested} 并启动`;
  } else {
    rowWrap.className = 'value strong status-value stopped';
    rowDot.className = 'dot stopped';
    $('statusRowText').textContent = '已停止';
    $('statusRowText').title = '';
  }
  $('urlText').textContent = state.url || '-';
  window._currentUrl = state.url || '';

  // 启动/停止 合一按钮
  const toggle = $('btnToggle');
  toggle.textContent = running ? '停止服务' : '启动服务';
  toggle.classList.toggle('primary', !running);
  toggle.classList.toggle('danger', running);

  // 开关 chip
  renderToggleChip('btnNotify', state.notify !== false, '开启', '关闭');
  renderToggleChip('btnAuto', !!state.autostart, '开启', '关闭');
  renderToggleChip('btnAutoRestart', state.autoRestart !== false, '开启', '关闭');
  renderToggleChip('btnSystemBrowser', !!state.useSystemBrowser, '开启', '关闭');
  renderToggleChip('btnTabsEnabled', !!state.tabsEnabled, '开启', '关闭');

  // 运行环境：状态卡 + 主页面警示行；未就绪时首次自动进入环境页
  renderEnvSummary(state.env);

  // 缩放微调按钮（拖动/双击输入；值变化时应用）
  zoomWidgets.launcher.setFromState(state.zoom);
  if (window._lastZoom !== state.zoom) {
    window._lastZoom = state.zoom;
    applyZoom(state.cssZoom ?? state.zoom);
  }
  zoomWidgets.web.setFromState(state.webZoom ?? 100);
  portCtl.setFromState(state.port || 3080);

  // 主题 chips（仅值变化时重建，避免打断点击）
  if (window._lastTheme !== state.theme) {
    window._lastTheme = state.theme;
    buildChips('themeChips', THEME_VALUES, state.theme, (t) => cmd('setTheme', t.key));
    applyTheme(state.theme);
  }

  // 日志
  const logEl = $('log');
  if (logEl.textContent !== state.log) logEl.textContent = state.log || '暂无日志';
}

// ---------- 运行环境（检测结果 + 一键安装向导） ----------

const ENV_KIND_LABELS = {
  source: '源码仓库',
  global: '全局安装',
  npx: 'npx 缓存',
  managed: '托管安装',
  none: '未安装',
};

// 卡片：{ badge: 'ok'|'warn'|'bad', name, version, detail, item, btnLabel }
function envCardHtml(c) {
  const actions = c.btnLabel
    ? `<div class="env-card-actions"><button class="btn sm" data-env-item="${c.item}">${c.btnLabel}</button></div>`
    : '';
  return `<div class="env-card">
    <div class="env-card-head">
      <span class="env-badge env-badge-${c.badge}">${c.badge === 'ok' ? '✓' : c.badge === 'warn' ? '⚠' : '✕'}</span>
      <span class="env-card-name">${c.name}</span>
      <span class="env-card-version">${c.version || ''}</span>
    </div>
    <div class="env-card-detail">${c.detail || ''}</div>
    ${actions}
  </div>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function missingEnvItems(env) {
  const items = [];
  if (!env) return items;
  if (env.node && env.node.status !== 'ok') items.push('node');
  if (env.dsh && env.dsh.status !== 'ok') items.push('dsh');
  if (env.plugin && env.plugin.status !== 'ok') items.push('plugin');
  return items;
}

function renderEnvSummary(env) {
  window._envSummary = env;
  // 主页面警示卡
  const warnCard = $('envWarnCard');
  if (env && !env.ready) {
    warnCard.classList.remove('hidden');
    // 详情 = 具体问题列表 + 原始状态速览（node/dsh/plugin/ready），排查时一眼定位
    const issues = (env.issues && env.issues.length) ? env.issues.join('；') : '检测到运行环境缺失';
    const raw = `[node=${env.node ? env.node.status : '?'}, dsh=${env.dsh ? env.dsh.status + '/' + env.dsh.kind : '?'}, plugin=${env.plugin ? env.plugin.status : '?'}, ready=${env.ready}]`;
    $('envWarnDetail').textContent = issues + ' ' + raw;
    // 首次检测到未就绪：自动进入环境页引导安装（仅一次，不打断用户后续操作）
    if (!window._envAutoShown) {
      window._envAutoShown = true;
      showPage('env');
    }
  } else {
    warnCard.classList.add('hidden');
  }

  // 状态卡仅在摘要变化时重建（广播频繁，避免打断交互）
  const envJson = JSON.stringify(env);
  if (window._lastEnvJson === envJson) return;
  window._lastEnvJson = envJson;

  // 环境页状态卡
  if (!env) {
    $('envCards').innerHTML = '<div class="env-card"><div class="env-card-detail">环境检测中…</div></div>';
    const btn = $('btnEnvInstallAll');
    btn.disabled = true;
    $('envInstallHint').textContent = '检测中…';
    return;
  }
  const cards = [];
  {
    const n = env.node;
    const badge = n.status === 'ok' ? 'ok' : n.status === 'tooOld' ? 'warn' : 'bad';
    const version = n.version ? `v${n.version}` : '';
    const detail = n.status === 'ok'
      ? (n.source === 'managed' ? '托管安装' : n.source === 'config' ? '手动指定' : '系统检测') + (n.path ? ` · ${n.path}` : '')
      : n.status === 'tooOld' ? `版本过低（需要 ${env.engineRange || '22.19+/24+'}）${n.path ? ' · ' + n.path : ''}`
      : n.path ? `配置的路径不可用：${n.path}` : '未检测到 Node.js';
    cards.push({ badge, name: 'Node.js', version, detail, item: 'node', btnLabel: n.status === 'ok' ? '' : '安装 Node.js（托管版）' });
  }
  {
    const d = env.dsh;
    const badge = d.status === 'ok' ? 'ok' : d.status === 'unbuilt' ? 'warn' : 'bad';
    const version = d.version ? `v${d.version}` : '';
    const kindLabel = ENV_KIND_LABELS[d.kind] || d.kind || '未安装';
    let detail = `${kindLabel}` + (d.dir ? ` · ${d.dir}` : '');
    if (d.status === 'unbuilt') detail = '源码仓库已检出，但尚未构建（缺少 apps/cli/lib/bin.js，需 pnpm install && pnpm run build）';
    if (env.source && env.source.found && !env.source.built && d.kind !== 'source') detail += ` · 当前回退到${kindLabel}，构建源码后自动优先使用源码版`;
    cards.push({ badge, name: 'DeepSeek Harness', version, detail, item: 'dsh', btnLabel: d.status === 'ok' ? '' : '安装 DSH（托管版）' });
  }
  {
    const p = env.plugin;
    const badge = p.status === 'ok' ? 'ok' : 'bad';
    const detail = p.status === 'ok' ? (p.path || '') : '会话完成/提问的托盘通知将不可用';
    cards.push({ badge, name: '通知插件（dsh-notify）', version: '', detail, item: 'plugin', btnLabel: p.status === 'ok' ? '' : '安装插件' });
  }
  $('envCards').innerHTML = cards.map(envCardHtml).join('');

  const missing = missingEnvItems(env);
  const btn = $('btnEnvInstallAll');
  btn.disabled = missing.length === 0;
  $('envInstallHint').textContent = missing.length === 0 ? '环境已就绪 ✓' : `缺失：${missing.join('、')}（安装过程实时显示进度与日志）`;
}

// 安装任务视图：阶段列表 + 进度条 + 阶段说明 + 日志
function renderEnvJob(job) {
  if (!job) return;
  window._envJob = job;
  window._lastInstallItems = job.items || [];
  $('envProgressWrap').classList.remove('hidden');
  const stagesEl = $('envStages');
  if (JSON.stringify(window._envStagesJson) !== JSON.stringify(job.stages)) {
    window._envStagesJson = JSON.stringify(job.stages);
    stagesEl.innerHTML = job.stages.map((s) => `<div class="env-stage ${s.status}">${esc(s.label)}</div>`).join('');
  } else {
    for (let i = 0; i < job.stages.length; i++) {
      const el = stagesEl.children[i];
      if (el) el.className = 'env-stage ' + job.stages[i].status;
    }
  }
  $('envProgressBar').style.width = Math.max(0, Math.min(100, job.percent || 0)) + '%';
  const running = job.status === 'running';
  if (running) {
    $('envStageText').textContent = job.stageText || '准备中…';
  } else if (job.status === 'done') {
    $('envStageText').textContent = '✓ 安装完成，正在重新检测环境…';
  } else if (job.status === 'failed') {
    $('envStageText').textContent = '✕ 安装失败：' + (job.error || '未知错误');
  } else if (job.status === 'cancelled') {
    $('envStageText').textContent = '已取消安装';
  }
  $('btnEnvCancel').style.display = running ? '' : 'none';
  $('btnEnvRetry').style.display = (job.status === 'failed' || job.status === 'cancelled') ? '' : 'none';
  const btn = $('btnEnvInstallAll');
  btn.disabled = running;
  // 提示文案只认"检测结果"（renderEnvSummary 负责），安装任务状态只显示在阶段文本里，
  // 避免"安装完成"与"检测未就绪"互相矛盾；安装进行中时给出进度提示。
  if (running) $('envInstallHint').textContent = '安装进行中…';
}

// 环境页打开时的全量快照（任务状态 + 环形日志）
function renderEnvSnapshot(s) {
  if (s && s.job) renderEnvJob(s.job);
  if (s && Array.isArray(s.log)) {
    window._envLogLines = s.log.map((e) => (typeof e === 'object' && e.line != null ? e.line : String(e)));
    refreshEnvLog();
  }
}

function appendEnvLog(lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  if (!window._envLogLines) window._envLogLines = [];
  window._envLogLines = window._envLogLines.concat(lines).slice(-400);
  refreshEnvLog();
}

function refreshEnvLog() {
  const el = $('envLog');
  const lines = window._envLogLines || [];
  el.textContent = lines.join('\n') || '（暂无日志）';
  if ($('envLogAuto').checked) el.scrollTop = el.scrollHeight;
}

// ---------- 事件绑定 ----------

$('btnOpen').addEventListener('click', () => cmd('openWeb'));
$('urlText').addEventListener('click', () => {
  if (window._currentUrl) cmd('openUrlExternal');
});
$('btnToggle').addEventListener('click', () => cmd(window._running ? 'stop' : 'start'));
$('btnTest').addEventListener('click', () => cmd('testNotify'));
$('btnLogs').addEventListener('click', () => showPage('log'));
$('btnBack').addEventListener('click', () => showPage('main'));
$('btnSettings').addEventListener('click', () => showPage('settings'));
$('btnSettingsBack').addEventListener('click', () => showPage('main'));
$('btnOpenLogsDir').addEventListener('click', () => cmd('openLogs'));
$('btnAuto').addEventListener('click', () => cmd('toggleAutostart'));
$('btnAutoRestart').addEventListener('click', () => {
  const chip = $('btnAutoRestart');
  cmd('setAutoRestart', !chip.classList.contains('checked'));
});
$('btnNotify').addEventListener('click', () => {
  const chip = $('btnNotify');
  cmd('setNotify', !chip.classList.contains('checked'));
});
$('btnSystemBrowser').addEventListener('click', () => {
  const chip = $('btnSystemBrowser');
  cmd('setUseSystemBrowser', !chip.classList.contains('checked'));
});
$('btnTabsEnabled').addEventListener('click', () => {
  const chip = $('btnTabsEnabled');
  cmd('setTabsEnabled', !chip.classList.contains('checked'));
});
$('btnOpenEnv').addEventListener('click', () => showPage('env'));
$('btnReset').addEventListener('click', () => cmd('resetDefaults'));

// 运行环境页
$('btnEnvBack').addEventListener('click', () => showPage('main'));
$('btnEnvFix').addEventListener('click', () => showPage('env'));
$('btnEnvOpen').addEventListener('click', () => showPage('env'));
$('btnPortSwitch').addEventListener('click', () => {
  if (window._suggestedPort) cmd('portSwitchStart', { port: window._suggestedPort });
});
$('btnPortOpenSettings').addEventListener('click', () => showPage('settings'));
$('btnEnvRecheck').addEventListener('click', () => { void cmd('envDetect'); });
$('btnEnvCopyDiag').addEventListener('click', () => { void cmd('envCopyDiagnostics'); });
$('btnEnvInstallAll').addEventListener('click', () => {
  const items = missingEnvItems(window._envSummary);
  if (items.length) void cmd('envInstall', { items });
});
$('btnEnvCancel').addEventListener('click', () => void cmd('envCancel'));
$('btnEnvRetry').addEventListener('click', () => {
  const items = window._lastInstallItems || [];
  if (items.length) void cmd('envInstall', { items });
});
$('btnEnvOpenInstallLog').addEventListener('click', () => void cmd('openInstallLog'));

// ---------- 自动更新（electron-updater → GitHub Releases） ----------
function renderUpdater(u) {
  if (!u) return;
  window._updater = u;
  const statusEl = $('updaterStatus');
  const checkBtn = $('btnUpdaterCheck');
  const detailRow = $('updaterDetailRow');
  const detail = $('updaterDetail');
  const badge = $('btnUpdateBadge');
  const current = u.current || '-';
  const hasUpdate = (u.status === 'downloading' || u.status === 'downloaded') && !!u.latest;

  // 主页面底端指示：有更新时"更新日志"右侧显示绿色 ↑ 圆圈
  badge.classList.toggle('hidden', !hasUpdate);

  // 有更新时"检查更新"按钮变形为绿色"更新到 vX"
  checkBtn.textContent = hasUpdate ? `更新到 v${u.latest}` : '检查更新';
  checkBtn.classList.toggle('update-ready', hasUpdate);

  switch (u.status) {
    case 'dev':
      statusEl.textContent = `v${current}`;
      detail.textContent = '开发模式（npm start）不支持在线更新';
      detailRow.classList.remove('hidden');
      checkBtn.disabled = true;
      break;
    case 'checking':
      statusEl.textContent = `v${current}`;
      detail.textContent = '正在检查更新…';
      detailRow.classList.remove('hidden');
      checkBtn.disabled = true;
      break;
    case 'downloading':
      statusEl.textContent = `v${current}`;
      detail.textContent = `发现新版本 v${u.latest}，正在下载 ${u.percent || 0}%…（下载完成后点"更新到 v${u.latest}"立即安装，退出重启也会自动安装）`;
      detailRow.classList.remove('hidden');
      checkBtn.disabled = true;
      break;
    case 'downloaded':
      statusEl.textContent = `v${current}`;
      detail.textContent = `新版本 v${u.latest} 已就绪：点"更新到 v${u.latest}"立即安装（退出重启也会自动安装）`;
      detailRow.classList.remove('hidden');
      checkBtn.disabled = false;
      break;
    case 'up-to-date':
      statusEl.textContent = `v${current}（已是最新）`;
      detailRow.classList.add('hidden');
      checkBtn.disabled = false;
      break;
    case 'error':
      statusEl.textContent = `v${current}`;
      detail.textContent = '检查更新失败：' + (u.error || '网络错误');
      detailRow.classList.remove('hidden');
      checkBtn.disabled = false;
      break;
    default:
      statusEl.textContent = `v${current}`;
      detailRow.classList.add('hidden');
      checkBtn.disabled = false;
  }
}

// 主页面底端链接
$('btnGithub').addEventListener('click', () => void cmd('openGithub'));
$('btnChangelog').addEventListener('click', () => void cmd('openChangelog'));
// 绿色 ↑ 更新指示：点击切换到设置页（那里有"更新到 vX"按钮）
$('btnUpdateBadge').addEventListener('click', () => showPage('settings'));
// 版本与更新按钮：已就绪 → 立即安装；否则 → 检查更新
$('btnUpdaterCheck').addEventListener('click', () => {
  const u = window._updater;
  if (u && u.status === 'downloaded') void cmd('updaterInstall');
  else void cmd('updaterCheck');
});
// 状态卡上的单项安装按钮（事件委托：卡片由 render 重建）
$('envCards').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-env-item]');
  if (!btn) return;
  const item = btn.getAttribute('data-env-item');
  const items = item === 'dsh' ? ['dsh'] : item === 'node' ? ['node'] : ['plugin'];
  void cmd('envInstall', { items });
});

// 主进程 → JS 状态推送
window.dshBridge.onState((json) => {
  try { render(JSON.parse(json)); } catch (err) { console.error('[dshl] render error:', err); }
});

// 主进程 → 环境安装任务推送（进度 + 日志批量）
window.dshBridge.onEnv((json) => {
  try {
    const p = JSON.parse(json);
    if (p && p.job) renderEnvJob(p.job);
    if (p && p.lines) appendEnvLog(p.lines);
  } catch (err) { console.error('[dshl] env push error:', err); }
});

// 主进程 → 自动更新状态推送
window.dshBridge.onUpdater((json) => {
  try { renderUpdater(JSON.parse(json)); } catch (err) { console.error('[dshl] updater push error:', err); }
});

$('envLogAuto').addEventListener('change', () => refreshEnvLog());

// 初始状态拉取
(async () => {
  try {
    render(await cmd('getState'));
    renderUpdater(await cmd('updaterGetState'));
  } catch (err) { console.error('[dshl] initial state failed:', err); }
})();
