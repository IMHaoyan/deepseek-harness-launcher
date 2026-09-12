// DSHL 控制台脚本：Electron IPC 桥 + 状态渲染
'use strict';

const $ = (id) => document.getElementById(id);

let consoleToastTimer = null;
function showConsoleToast(text) {
  const el = $('consoleToast');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(consoleToastTimer);
  consoleToastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 200);
  }, 2600);
}

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
// DSH 更新渠道：latest = npm latest（默认，稳定线）；alpha = npm alpha（预览线）
const DSH_CHANNEL_VALUES = [
  { key: 'latest', label: 'latest' },
  { key: 'alpha', label: 'alpha' },
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

const CONSOLE_PAGE_LABELS = { general: '通用', plugins: '预装插件', env: '运行环境', logs: '日志与反馈', wizard: '首次设置' };
// env 是「通用 → 服务与更新」里的二级页：导航高亮仍落在通用上
const CONSOLE_NAV_IDS = { general: 'navGeneral', plugins: 'navPlugins', env: 'navGeneral', logs: 'navLog' };
// 旧名兼容：概览/设置已合并成「通用」（主进程很多入口还在推 main）；服务与诊断已合并进「日志与反馈」
const CONSOLE_PAGE_ALIASES = { main: 'general', settings: 'general', recovery: 'logs', service: 'logs', log: 'logs' };

function updateConsoleChrome(state) {
  const dot = $('consoleServiceDot');
  const text = $('consoleServiceText');
  const version = $('consoleVersion');
  if (version) version.textContent = state && state.version ? `DSHL v${state.version}` : 'DSHL';
  if (!dot || !text) return;
  const phase = (state && state.phase) || (state && state.running ? 'ready' : 'stopped');
  dot.className = 'dot';
  if (phase === 'stopping') {
    text.textContent = '服务停止中…';
  } else if (phase === 'starting' || phase === 'restarting') {
    dot.classList.add('running');
    text.textContent = phase === 'restarting' ? '服务重启中…' : '服务启动中…';
  } else if (state && (state.running || state.settling)) {
    dot.classList.add('running');
    text.textContent = '服务运行中';
  } else if (state && state.blocked) {
    dot.classList.add('stopped');
    text.textContent = '端口被占用';
  } else {
    dot.classList.add('stopped');
    text.textContent = '服务已停止';
  }
}

function showPage(name) {
  name = CONSOLE_PAGE_ALIASES[name] || name;
  const activeNav = CONSOLE_NAV_IDS[name] || '';
  document.querySelectorAll('#consoleNav .console-nav-item').forEach((el) => {
    el.classList.toggle('active', el.id === activeNav);
  });
  document.title = 'DSHL 控制台 · ' + (CONSOLE_PAGE_LABELS[name] || '通用');
  const content = $('consoleContent');
  if (content) content.scrollTop = 0;
  $('pageGeneral').classList.toggle('hidden', name !== 'general');
  $('pagePlugins').classList.toggle('hidden', name !== 'plugins');
  $('pageLog').classList.toggle('hidden', name !== 'logs');
  $('pageEnv').classList.toggle('hidden', name !== 'env');
  $('pageWizard').classList.toggle('hidden', name !== 'wizard');
  if (name === 'logs') {
    // 进入合并页（运行日志 + 服务与诊断）先拉一次最新状态（检查点列表主进程侧有 5s 缓存）
    void cmd('getState').then((s) => { if (s) render(s); });
  }
  if (name === 'plugins') {
    // 打开插件页：先拉一次最新插件状态，避免设置/恢复页操作后卡片状态滞后
    void cmd('pluginsGetState').then((s) => { if (s) renderPlugins(s, true); });
    // 再查一次 npm 最新版（主进程有 10 分钟 TTL 缓存；断网只返回空版本，不弹错）
    void cmd('pluginCheckUpdates').then((s) => { if (s) renderPlugins(s, true); });
  }
  if (name === 'env') {
    // 打开环境页：拉取安装任务快照 + 强制重新检测
    void cmd('envGetState').then((s) => { if (s) renderEnvSnapshot(s); });
    void cmd('envDetect');
  }
  if (name === 'wizard') {
    // 进入向导：环境已就绪 → 完成屏；有安装任务 → 按任务状态显示；否则欢迎屏
    void cmd('envGetState').then((s) => {
      if (!s) return;
      if (s.job) {
        if (s.job.status === 'running' || s.job.status === 'done') window._wizardActive = true;
        renderWizardJob(s.job);
      }
      if (Array.isArray(s.log)) appendWizardLog(s.log.map((e) => (typeof e === 'object' && e.line != null ? e.line : String(e))));
    });
    if (window._envSummary && window._envSummary.ready) {
      showWizardScreen('done');
      ensureWizardStart();
      if (window._running) finishWizardStart();
    } else if (window._envJob) renderWizardJob(window._envJob);
    else showWizardScreen('welcome');
  }
}

function render(state) {
  updateConsoleChrome(state);
  window._lastState = state;
  window._running = !!state.running;
  window._firstRun = !!state.firstRun;

  // 最低端版本行：启动器版本 / DSH 版本（DSH 优先取环境探测的已安装版本，回退更新器记录；点击打开 npm 官方页）
  const lvEl = $('launcherVersion');
  if (lvEl) lvEl.textContent = state.version ? `v${state.version}` : '-';
  const dshV = (state.env && state.env.dsh && state.env.dsh.version) || (state.dshUpdate && state.dshUpdate.current) || '';
  const dshKind = state.env && state.env.dsh ? state.env.dsh.kind : '';
  const dshKindLabel = ENV_KIND_LABELS[dshKind];
  const dshVerText = dshV ? `v${dshV}` : (state.env ? '未安装' : '检测中…');
  const dshVerEl = $('dshVersion');
  if (dshVerEl) {
    dshVerEl.textContent = dshVerText;
    dshVerEl.title = dshV && state.env && state.env.dsh && state.env.dsh.dir
      ? `v${dshV} · ${dshKindLabel || ''} · ${state.env.dsh.dir}` : '在浏览器打开 npm 官方页';
  }
  // DSH 更新渠道（设置页）：latest / alpha，切换后主进程立即按新渠道重新检查
  const dshChannel = (state.dshUpdate && state.dshUpdate.channel) || 'latest';
  if (window._lastDshChannel !== dshChannel) {
    window._lastDshChannel = dshChannel;
    buildChips('dshChannelChips', DSH_CHANNEL_VALUES, dshChannel, (c) => cmd('setDshChannel', c.key));
  }

  // 状态
  const running = window._running;
  // 启动中/重启中：服务进程已起但端口还没就绪（或看护正在重启）。此时不能显示"已停止"，
  // 也不能让"启动服务"按钮可点（再点一次会命中 startServer 的早退 → 误报"服务已就绪"）。
  const phase = state.phase || (running ? 'ready' : 'stopped');
  const stopping = phase === 'stopping';
  // 交接裁决中（DSH 自重启换新进程）：端口可能还在服务，只是我们暂时说不出 PID —— 不能塌成"已停止"
  const settling = !!state.settling;
  const serving = running || (settling && phase === 'ready');
  const starting = phase === 'starting' || phase === 'restarting';
  window._starting = starting;
  window._stopping = stopping;
  const rowDot = $('statusRowDot');
  const rowWrap = $('statusText');
  $('portWarnCard').classList.add('hidden');
  if (stopping) {
    rowWrap.className = 'value strong status-value stopped';
    rowDot.className = 'dot stopped';
    $('statusRowText').textContent = '正在停止服务…';
    $('statusRowText').title = '正在结束服务进程，请稍候';
  } else if (starting) {
    rowWrap.className = 'value strong status-value running';
    rowDot.className = 'dot running';
    $('statusRowText').textContent = phase === 'restarting' ? '服务正在自动重启…' : '正在启动服务…';
    $('statusRowText').title = '服务进程已启动，正在等待端口就绪';
  } else if (serving) {
    rowWrap.className = 'value strong status-value running';
    rowDot.className = 'dot running';
    const ORIGIN_TEXT = { owned: '由本工具启动', claimed: '服务自重启后已接管', external: '接管外部服务' };
    // 缺省按旧字段兜底，兼容控制台先于主进程更新的情况
    const origin = settling && !running ? '正在确认新进程…'
      : (ORIGIN_TEXT[state.origin] || (state.owned ? '由本工具启动' : '接管外部服务'));
    $('statusRowText').textContent = `运行中（${origin}）`;
    const ho = state.handover;
    $('statusRowText').title = settling && !running ? '检测到服务进程更换，正在确认新进程（无需操作）'
      : state.origin === 'claimed' && ho ? `DSH 内部重启换了新进程（PID ${ho.fromPid} → ${ho.toPid}），启动器已认领并继续看护`
        : (state.authPending ? '服务在正常运行，但窗口没有有效登录凭据：先在 DeepSeek Harness 窗口点「刷新页面」，仍不行再点「重启服务以恢复访问」' : '');
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
    $('statusRowText').textContent = state.autoRestartStopped ? '已停止（自动恢复已停止，请查看日志）' : '已停止';
    $('statusRowText').title = state.autoRestartStopped ? '服务连续启动失败，自动恢复已停止；请查看日志后手动启动服务' : '';
  }
  $('urlText').textContent = state.url || '-';
  window._currentUrl = state.url || '';

  // 稳定性提示（分级展示）：
  //   info   —— 单次异常退出、无影响：中性一行，主按钮「知道了」，不推恢复、不弹通知（大多数强杀/断电属于这档）
  //   notice —— 24 小时内第 2 次：中性提示"近期连续异常退出 N 次"
  //   alert  —— 配置已回退 / 自动恢复已停止 / 24 小时内 ≥3 次：红卡 + 「打开恢复」主按钮（这档才真需要处理）
  const crashEl = $('crashNote');
  if (crashEl) {
    const notes = [];
    const severity = state.crashSeverity || 'none';
    const alert = severity === 'alert';
    const streak = Number(state.crashStreak) || 0;
    const when = (iso) => fmtLocalTime(iso) || '未知时间';
    // crashNotice 由主进程按「该次崩溃是否已被关闭」下发；缺省时按 lastExit 兜底（兼容旧状态）
    const showCrash = state.crashNotice !== undefined ? !!state.crashNotice : state.lastExit === 'crashed';
    if (showCrash && state.lastExit === 'crashed') {
      if (alert) notes.push(`上次启动器未正常退出（${when(state.lastCrashAt)}），诊断报告已保存到日志目录`);
      else if (severity === 'notice') notes.push(`启动器近期连续异常退出 ${streak} 次（最近一次 ${when(state.lastCrashAt)}）：不影响 DSH 使用，诊断报告已自动保存`);
      else notes.push(`上次启动器异常退出（${when(state.lastCrashAt)}），不影响使用：服务已由启动器重新接管，诊断报告已自动保存`);
    }
    if (state.recoveredAt) {
      notes.push(`服务反复启动失败，已自动回退到上一个正常配置（${when(state.recoveredAt)}）`);
    }
    // 自动恢复已停止：服务不会再被自动拉起 —— 这条才是真需要用户处理的
    if (state.autoRestartStopped) {
      notes.push('自动恢复已停止，服务保持停止状态');
    }
    crashEl.classList.toggle('env-warning', alert); // 非 alert 用普通卡片样式，不再红色告警
    crashEl.classList.toggle('hidden', notes.length === 0);
    if (notes.length) {
      const t = $('crashNoteText');
      if (t) {
        t.textContent = (alert ? '⚠ ' : '') + notes.join('；');
        t.classList.toggle('muted', !alert); // 中性：次要色、常规字重
      }
    }
    // 按钮主次随分级变化：非 alert 时「知道了」是主按钮，恢复入口降级为「查看恢复页」，
    // 同时收起「导出诊断」（诊断报告本就自动生成，"导出"是给需要提交问题的人用的，放在恢复页里）
    const recoverBtn = $('btnCrashNoteRecover');
    const diagBtn = $('btnCrashNoteDiag');
    const closeBtn = $('btnCrashNoteClose');
    if (recoverBtn) {
      recoverBtn.textContent = alert ? '打开恢复' : '查看恢复页';
      recoverBtn.classList.toggle('primary', alert);
    }
    if (diagBtn) diagBtn.classList.toggle('hidden', !alert);
    if (closeBtn) closeBtn.classList.toggle('primary', !alert);
  }

  // 启动/重启 合一按钮：运行中 = 重启 DSH（停 → 起 → 刷新独立窗口），未运行 = 启动 DSH。
  // 单纯的"停止"只留在恢复页：日常停一下没有出口（停了还得手动起、窗口停在未启动说明页），不如一键重启。
  const toggle = $('btnToggle');
  const busy = starting || stopping || settling; // 启动/重启/停止/交接裁决中一律禁用，避免重复点击
  toggle.textContent = stopping ? '停止中…'
    : starting ? (phase === 'restarting' ? '重启中…' : '启动中…')
      : settling ? '确认中…'
        : (serving ? '重启 DSH' : '启动 DSH');
  toggle.disabled = busy;
  toggle.classList.toggle('primary', !serving && !busy);
  toggle.title = serving
    ? '停止并重新启动服务，然后刷新独立窗口（会中断正在运行的会话）'
    : '启动服务；环境未就绪时会引导到环境页';

  // 开关 chip
  renderToggleChip('btnNotify', state.notify !== false, '开启', '关闭');
  renderToggleChip('btnAuto', !!state.autostart, '开启', '关闭');

  // 运行环境：状态卡 + 主页面警示行；未就绪时首次自动进入环境页
  renderEnvSummary(state.env);

  // DSH 新版本卡片（检测自动、更新手动）
  renderDshUpdate(state.dshUpdate);

  // 新手向导：安装完成且环境已就绪 → 启动进度屏（进度条走完自动回主页；DSH 窗口由主进程弹出）
  if (window._wizardActive && window._envJob && window._envJob.status === 'done' && state.env && state.env.ready) {
    showWizardScreen('done');
    ensureWizardStart();
    if (state.running) {
      finishWizardStart();
    } else if (wizardStartState && !wizardStartState.finished && Date.now() - wizardStartState.t0 > 90000) {
      finishWizardStart(); // 兜底：90 秒仍未就绪也回主页（主页会显示真实状态，用户可手动处理）
    }
  }

  // 插件页：卡片完全由 state.plugins 驱动；新增插件不需要改这里
  renderPlugins(state.plugins);
  renderInstallAll(state.pluginInstallAll);
  renderPendingRestart(state.pluginPendingRestart);

  // 通知分类开关（设置页）+ 恢复页（检查点/回退记录/服务操作）
  renderNotifyCategories(state.notifyCategories);
  renderRecovery(state);

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

  // 日志：控制台里唯一的日志区（原「服务与诊断」的最近日志已合并进来）
  for (const id of ['logFull']) {
    const el = $(id);
    if (el && el.textContent !== state.log) el.textContent = state.log || '暂无日志';
  }
}

// ---------- 运行环境（检测结果 + 一键安装向导） ----------

const ENV_KIND_LABELS = {
  source: '源码仓库',
  global: '全局 npm 安装',
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
  if (env.pnpm && env.pnpm.status !== 'ok') items.push('pnpm');
  if (env.dsh && env.dsh.status !== 'ok') items.push('dsh');
  if (env.plugin && env.plugin.status !== 'ok') items.push('plugin');
  return items;
}

function renderEnvSummary(env) {
  window._envSummary = env;
  // 主页面警示卡
  const warnCard = $('envWarnCard');
  if (env && (!env.ready || !env.pnpmReady)) {
    warnCard.classList.remove('hidden');
    // 详情 = 具体问题列表 + 原始状态速览（node/dsh/plugin/ready），排查时一眼定位
    const issues = (env.issues && env.issues.length) ? env.issues.join('；') : '检测到运行环境缺失';
    const raw = `[node=${env.node ? env.node.status : '?'}, pnpm=${env.pnpm ? env.pnpm.status + '/' + (env.pnpm.version || '-') : '?'}, dsh=${env.dsh ? env.dsh.status + '/' + env.dsh.kind : '?'}, plugin=${env.plugin ? env.plugin.status : '?'}, ready=${env.ready}]`;
    $('envWarnDetail').textContent = issues + ' ' + raw;
    // 仅首次运行自动进入新手向导；已有用户的运行环境缺失由启动流程打开环境页，"新手向导"仍可从环境页手动进入。
    if (!window._envAutoShown && window._firstRun) {
      window._envAutoShown = true;
      window._wizardActive = true;
      showPage('wizard');
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
      ? (n.source === 'user' ? '用户级安装' : n.source === 'managed' ? '托管安装' : n.source === 'config' ? '手动指定' : '系统检测') + (n.path ? ` · ${n.path}` : '')
      : n.status === 'tooOld' ? `版本过低（需要 ${env.engineRange || '22.19+/24+'}）${n.path ? ' · ' + n.path : ''}`
      : n.path ? `配置的路径不可用：${n.path}` : '未检测到 Node.js';
    cards.push({ badge, name: 'Node.js', version, detail, item: 'node', btnLabel: n.status === 'ok' ? '' : '安装 Node.js（用户级）' });
  }

  {
    const p = env.pnpm;
    const badge = p && p.status === 'ok' ? 'ok' : p && p.status === 'mismatch' ? 'warn' : 'bad';
    const version = p && p.version ? `v${p.version}` : '';
    const detail = p && p.status === 'ok'
      ? (p.source === 'corepack' ? 'Corepack 管理' : p.source === 'npm-global' ? 'npm 全局安装' : 'PATH 安装') + (p.path ? ` · ${p.path}` : '')
      : p && p.status === 'mismatch'
        ? `版本不匹配：当前 v${p.version}，期望 v${p.expectedVersion}（dsh plugin / 插件市场需要）${p.path ? ` · ${p.path}` : ''}`
        : '未检测到 pnpm（dsh plugin / 插件市场需要）';
    cards.push({ badge, name: 'pnpm', version, detail, item: 'pnpm', btnLabel: p && p.status === 'ok' ? '' : '安装/对齐 pnpm' });
  }
  {
    const d = env.dsh;
    const badge = d.status === 'ok' ? 'ok' : d.status === 'unbuilt' ? 'warn' : 'bad';
    const version = d.version ? `v${d.version}` : '';
    const kindLabel = ENV_KIND_LABELS[d.kind] || d.kind || '未安装';
    let detail = `${kindLabel}` + (d.dir ? ` · ${d.dir}` : '');
    if (d.status === 'unbuilt') detail = '源码仓库已检出，但尚未构建（缺少 apps/cli/lib/bin.js，需 pnpm install && pnpm run build）';
    if (env.source && env.source.found && !env.source.built && d.kind !== 'source') detail += ` · 当前回退到${kindLabel}，构建源码后自动优先使用源码版`;
    cards.push({ badge, name: 'DeepSeek Harness', version, detail, item: 'dsh', btnLabel: d.status === 'ok' ? '' : '安装 DSH（全局 npm）' });
  }
  {
    const p = env.plugin;
    const badge = p.status === 'ok' ? 'ok' : 'bad';
    const detail = p.status === 'ok' ? (p.path || '') : '不装也能正常使用，只是少了完成/提问的托盘提醒';
    cards.push({ badge, name: '桌面通知（可选）', version: '', detail, item: 'plugin', btnLabel: p.status === 'ok' ? '' : '安装桌面通知' });
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

  // 新手向导联动（仅在向导流程激活时驱动向导屏）
  if (window._wizardActive) renderWizardJob(job);
}

// ---------- 新手安装向导（欢迎 → 极简进度 → 完成/失败；错误翻译成大白话） ----------

const WIZARD_STAGE_LABELS = {
  'node-dl': '准备基础组件（Node.js）',
  'node-ex': '校验并解压基础组件',
  'dsh-npm': '安装 DeepSeek Harness 主程序',
  'dsh-verify': '检查安装结果',
  'plugin': '安装桌面通知（可选）',
};

const WIZARD_STAGE_ACTION = {
  'node-dl': '正在准备基础组件…',
  'node-ex': '正在校验并解压…',
  'dsh-npm': '正在安装 DeepSeek Harness 主程序…',
  'dsh-verify': '正在检查安装结果…',
  'plugin': '正在安装桌面通知组件…',
};

function showWizardScreen(name) {
  $('wizardWelcome').classList.toggle('hidden', name !== 'welcome');
  $('wizardProgress').classList.toggle('hidden', name !== 'progress');
  $('wizardDone').classList.toggle('hidden', name !== 'done');
  $('wizardFail').classList.toggle('hidden', name !== 'fail');
}

let wizardTimer = null;
let wizardStartState = null; // 启动进度屏状态 { t0, finished }

// 启动进度条：10 秒线性走到 90%（首次启动初始化），服务就绪后跳到 100% 并回主页
function ensureWizardStart() {
  if (wizardStartState && !wizardStartState.finished) return;
  wizardStartState = { t0: Date.now(), finished: false };
  const bar = $('wizardStartBar');
  const note = $('wizardStartNote');
  bar.style.transition = 'none';
  bar.style.width = '0%';
  note.textContent = '首次启动需要初始化（约 10 秒），完成后会自动打开 DeepSeek Harness';
  requestAnimationFrame(() => {
    bar.style.transition = 'width 10s linear';
    bar.style.width = '90%';
  });
}

function finishWizardStart() {
  if (!wizardStartState || wizardStartState.finished) return;
  wizardStartState.finished = true;
  const bar = $('wizardStartBar');
  bar.style.transition = 'width 400ms ease-out';
  bar.style.width = '100%';
  $('wizardStartNote').textContent = '已就绪，正在打开 DeepSeek Harness…';
  if (window._wizardDoneTimer) clearTimeout(window._wizardDoneTimer);
  window._wizardDoneTimer = setTimeout(() => {
    window._wizardDoneTimer = null;
    if (!$('pageWizard').classList.contains('hidden')) {
      window._wizardActive = false;
      showPage('main');
    }
  }, 600);
}

function mmss(sec) { return `${Math.floor(sec / 60)}:${String(Math.max(0, sec) % 60).padStart(2, '0')}`; }

// 科学剩余时间估算：
//   当前阶段 ETA + 后续阶段名义值
//   - node-dl：用真实下载速率（剩余比例 ÷ 已用时间 × 剩余比例）
//   - dsh-npm：本机学习值 − 本阶段已用时（主进程每次安装后 EWMA 更新）
//   - 其他阶段：名义值
function computeRemainingSec(job) {
  if (!job || !Array.isArray(job.stages)) return 0;
  const idx = job.currentStage >= 0 ? job.currentStage : 0;
  const st = job.stages[idx] || {};
  const nominal = job.stageNominalMs || {};
  const stageElapsedSec = Math.max(0, (Date.now() - (window._stageStartedAt || Date.now())) / 1000);
  let etaCurrent;
  if (st.id === 'node-dl' && (job.stageProgress || 0) > 0.02) {
    etaCurrent = stageElapsedSec * (1 - job.stageProgress) / job.stageProgress; // 真实速率推算
  } else if (st.id === 'dsh-npm') {
    const estMs = job.estimateNpmMs || 210000;
    etaCurrent = Math.max(0, estMs / 1000 - stageElapsedSec);
  } else {
    etaCurrent = (nominal[st.id] || 10000) / 1000;
  }
  // 当前阶段已超预估：剩余未知，显示"即将完成"，不再叠加后续阶段名义值（否则会卡死在虚假的固定剩余上）
  if (etaCurrent <= 0) return 0;
  let futureSec = 0;
  for (let i = idx + 1; i < job.stages.length; i++) {
    futureSec += (nominal[job.stages[i].id] || 10000) / 1000;
  }
  return Math.max(0, Math.round(etaCurrent + futureSec));
}

function startWizardTimer() {
  if (wizardTimer) return;
  const start = (window._envJob && window._envJob.startedAt) || Date.now();
  wizardTimer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    $('wizardElapsed').textContent = `已用时 ${mmss(s)}`;
    const remain = $('wizardRemain');
    if (remain) {
      const r = computeRemainingSec(window._envJob);
      remain.textContent = r > 0 ? `预计剩余 ${mmss(r)}` : '预计剩余 即将完成';
    }
  }, 1000);
}
function stopWizardTimer() {
  if (wizardTimer) { clearInterval(wizardTimer); wizardTimer = null; }
}

// 错误翻译：把底层错误映射成一句大白话 + 行动建议（原文放小字详情）
function translateInstallError(job) {
  const e = String(job.error || '');
  if (job.status === 'cancelled') return { title: '安装已取消，随时可以重新开始' };
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|ENOTFOUND|网络|下载失败|超时/i.test(e)) {
    return { title: '网络不通或防火墙拦截，下载失败了：请检查网络后点"重试"（已下载的部分会保留，不会重来）' };
  }
  if (/npm 退出码|is not recognized|不是内部或外部命令/i.test(e)) {
    return { title: '安装组件时出了点小问题：点"重试"通常就能继续；反复失败请复制诊断信息反馈' };
  }
  if (/ENOSPC|空间不足|no space/i.test(e)) {
    return { title: '磁盘空间不足：请清理一些空间后点"重试"' };
  }
  return { title: '安装没有完成：点"重试"再试一次；反复失败请复制诊断信息反馈，作者会尽快修复' };
}

// 百分比数字平滑动画：阶段跳变（如 npm 完成 77%→95%）变成 600ms 快速滑行，不再瞬跳
function tweenWizardPercent(target) {
  const el = $('wizardPercent');
  if (!el) return;
  const from = (window._wizardPctShown == null) ? target : window._wizardPctShown;
  window._wizardPctShown = target;
  if (from === target) { el.textContent = target + '%'; return; }
  const t0 = performance.now();
  const dur = 600;
  if (window._wizardPctAnim) cancelAnimationFrame(window._wizardPctAnim);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    el.textContent = Math.round(from + (target - from) * k) + '%';
    if (k < 1) window._wizardPctAnim = requestAnimationFrame(step);
  };
  window._wizardPctAnim = requestAnimationFrame(step);
}

function renderWizardJob(job) {
  if (!job) return;
  window._envJob = job;
  window._lastInstallItems = job.items || [];
  if (job.status === 'running') {
    // 新任务：重置计时；阶段切换：记录本阶段开始时刻（速率型 ETA 的基准）
    if (window._wizardJobId !== job.id) {
      window._wizardJobId = job.id;
      stopWizardTimer();
      window._stageKey = null;
      window._wizardPctShown = null;
    }
    if (window._stageKey !== job.id + ':' + job.currentStage) {
      window._stageKey = job.id + ':' + job.currentStage;
      window._stageStartedAt = Date.now();
    }
    showWizardScreen('progress');
    tweenWizardPercent(job.percent || 0);
    $('wizardBar').style.width = Math.max(0, Math.min(100, job.percent || 0)) + '%';
    const cs = job.stages[job.currentStage] || {};
    $('wizardStepText').textContent = WIZARD_STAGE_ACTION[cs.id] || job.stageText || '准备中…';
    $('wizardSteps').innerHTML = job.stages.map((s) => {
      const icon = s.status === 'done' ? '✓' : s.status === 'active' ? '●' : '○';
      return `<div class="wizard-step ${s.status}"><span class="wizard-step-icon">${icon}</span>${esc(WIZARD_STAGE_LABELS[s.id] || s.label)}</div>`;
    }).join('');
    if (cs.id === 'node-dl') {
      const sp = job.stageProgress || 0;
      if (sp >= 1) {
        // 内置包：免下载，直接进入解压
        $('wizardStageHint').textContent = '已使用安装包内置组件（免下载），正在解压…';
      } else {
        // 回退在线下载：显示真实字节进度
        const mb = Math.max(0, Math.min(34, Math.round(sp * 34)));
        $('wizardStageHint').textContent = `正在下载：约 ${mb} / 34 MB`;
      }
    } else if (cs.id === 'dsh-npm') {
      const estMin = Math.max(1, Math.round((job.estimateNpmMs || 60000) / 60000));
      $('wizardStageHint').textContent = `这一步要组装约 500 个小组件（本机通常约 ${estMin} 分钟）；进度条按预计时间平滑前进，请勿关闭`;
    } else {
      $('wizardStageHint').textContent = '';
    }
    startWizardTimer();
  } else if (job.status === 'done') {
    stopWizardTimer();
    if (window._envSummary && window._envSummary.ready) showWizardScreen('done');
    else { showWizardScreen('progress'); $('wizardStepText').textContent = '完成检查…'; }
  } else if (job.status === 'failed' || job.status === 'cancelled') {
    stopWizardTimer();
    showWizardScreen('fail');
    $('wizardErrorText').textContent = translateInstallError(job).title;
    $('wizardErrorDetail').textContent = job.error || '';
  }
}

function appendWizardLog(lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  if (!window._wizardLogLines) window._wizardLogLines = [];
  window._wizardLogLines = window._wizardLogLines.concat(lines).slice(-300);
  const el = $('wizardLog');
  el.textContent = window._wizardLogLines.join('\n');
  if (!$('wizardLog').classList.contains('hidden')) el.scrollTop = el.scrollHeight;
}

$('btnWizardStart').addEventListener('click', () => {
  window._wizardActive = true;
  const items = missingEnvItems(window._envSummary);
  if (items.length) void cmd('envInstall', { items });
  else if (window._envSummary && window._envSummary.ready) showWizardScreen('done');
});
$('btnWizardSkip').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '跳过向导？',
    body: '跳过向导需要你手动安装 Node / npm / pnpm / DSH；建议先试自动安装（约 3-5 分钟，已装好的组件会自动跳过）。',
    confirmText: '仍要跳过',
  });
  if (!ok) return;
  window._wizardActive = false;
  stopWizardTimer();
  showPage('env');
});
$('btnWizardCancel').addEventListener('click', () => {
  void cmd('envCancel');
  window._wizardActive = false;
  stopWizardTimer();
  showPage('main');
});
$('btnWizardRetry').addEventListener('click', () => {
  window._wizardActive = true;
  const items = window._lastInstallItems || [];
  if (items.length) void cmd('envInstall', { items });
  else showWizardScreen('welcome');
});
$('btnWizardCopyDiag').addEventListener('click', () => void cmd('envCopyDiagnostics'));
$('btnWizardFailEnv').addEventListener('click', () => {
  window._wizardActive = false;
  stopWizardTimer();
  showPage('env');
});
$('btnWizardLogToggle').addEventListener('click', () => {
  const el = $('wizardLog');
  el.classList.toggle('hidden');
  if (!el.classList.contains('hidden')) el.scrollTop = el.scrollHeight;
});
$('btnEnvWizard').addEventListener('click', () => {
  if (window._envJob && window._envJob.status === 'running') window._wizardActive = true;
  showPage('wizard');
});

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

// ---------- 轻量确认框（危险操作统一入口） ----------
// 不用 window.confirm：沙箱渲染进程里它可能被忽略。Esc=取消，默认焦点在「取消」。
function confirmDialog(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const overlay = $('confirmOverlay');
    const okBtn = $('btnConfirmOk');
    const cancelBtn = $('btnConfirmCancel');
    $('confirmTitle').textContent = o.title || '确认';
    $('confirmBody').textContent = o.body || '';
    okBtn.textContent = o.confirmText || '确定';
    okBtn.className = 'btn ' + (o.danger ? 'danger' : 'primary');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onBackdrop);
      window.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => { if (e.target === overlay) finish(false) };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false) } };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onBackdrop);
    window.addEventListener('keydown', onKey, true);
    overlay.classList.remove('hidden');
    try { cancelBtn.focus() } catch { /* noop */ } // 默认焦点在取消：危险操作不能一键误触
  });
}

// ---------- 通知分类开关（设置页 · 提醒内容） ----------
const NOTIFY_CATEGORY_VALUES = [
  { key: 'service', label: '服务异常' },
  { key: 'recovery', label: '服务恢复' },
  { key: 'update', label: '更新提醒' },
];

function renderNotifyCategories(cats) {
  const box = $('notifyCategoryChips');
  if (!box) return;
  const c = cats && typeof cats === 'object' ? cats : {};
  const sig = JSON.stringify(NOTIFY_CATEGORY_VALUES.map((i) => c[i.key] !== false));
  if (box.dataset.sig === sig) return; // 值没变就不重建，避免打断点击
  box.dataset.sig = sig;
  box.textContent = '';
  for (const item of NOTIFY_CATEGORY_VALUES) {
    const on = c[item.key] !== false;
    const chip = document.createElement('button');
    chip.className = 'chip' + (on ? ' checked' : '');
    chip.textContent = item.label;
    chip.title = (on ? '已开启' : '已关闭') + '：点击切换（关闭后该类系统通知不再弹出，日志仍逐条记录）';
    chip.addEventListener('click', () => { void cmd('setNotifyCategory', { key: item.key, value: !on }) });
    box.appendChild(chip);
  }
}

// ---------- 恢复与诊断页 ----------
const RECOVERY_REASON_LABELS = {
  'page-loaded': '页面加载成功',
  'survived-120s': '稳定运行 2 分钟',
  'recovery-drill': '自检演练',
  selftest: '自检',
  'selftest-2': '自检',
};

function fmtLocalTime(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toLocaleString('sv-SE', { hour12: false }) : String(iso || '');
}

function setRecoverySlotStatus(text, kind) {
  const el = $('recoverySlotStatus');
  if (el) {
    el.textContent = text || '';
    el.className = 'recovery-hint' + (kind ? ' ' + kind : '');
  }
}

function setRecoveryDiagStatus(text, kind) {
  const el = $('recoveryDiagStatus');
  if (el) {
    el.textContent = text || '';
    el.className = 'recovery-hint' + (kind ? ' ' + kind : '');
  }
}

// 单个检查点：紧凑一行（名字 · 时间/环境 · 目录 / 回退并重启），不再是一整张卡
function recoverySlotEl(s) {
  const el = document.createElement('div');
  el.className = 'recovery-row';

  const name = document.createElement('span');
  name.className = 'recovery-row-name' + (s.valid ? '' : ' muted');
  name.textContent = s.slotId + (s.valid ? '' : (s.exists ? ' · 损坏' : ' · 为空'));

  const meta = document.createElement('span');
  meta.className = 'recovery-row-meta';
  meta.textContent = s.valid
    ? ([
      fmtLocalTime(s.capturedAt),
      s.dshVersion ? 'DSH v' + s.dshVersion : '',
      s.port ? '端口 ' + s.port : '',
      RECOVERY_REASON_LABELS[s.reason] || s.reason || '',
    ].filter(Boolean).join(' · ') || '配置快照可用')
    : (s.exists ? '快照损坏或不完整，无法回退' : '还没有快照（服务正常启动后会自动记录）');

  const actions = document.createElement('span');
  actions.className = 'recovery-row-actions';
  const openBtn = document.createElement('button');
  openBtn.className = 'btn sm';
  openBtn.textContent = '目录';
  openBtn.title = '打开该检查点的目录';
  openBtn.addEventListener('click', () => { void cmd('openHealthSnapshot', { slotId: s.slotId }) });
  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'btn sm danger';
  restoreBtn.textContent = '回退并重启';
  restoreBtn.disabled = !s.valid;
  restoreBtn.addEventListener('click', () => { void doRestoreSlot(s) });
  actions.appendChild(openBtn);
  actions.appendChild(restoreBtn);

  el.appendChild(name);
  el.appendChild(meta);
  el.appendChild(actions);
  return el;
}
async function doRestoreSlot(s) {
  const ok = await confirmDialog({
    title: '回退到 ' + s.slotId + '？',
    body: '会中断正在运行的会话；当前配置会先备份为 .broken-* 文件（日志目录可查），不会丢东西。回退后启动器会自动重启服务。',
    confirmText: '回退并重启',
    danger: true,
  });
  if (!ok) return;
  setRecoverySlotStatus('正在回退并重启服务…', '');
  const r = await cmd('healthRestore', { slotId: s.slotId });
  if (r && r.ok) {
    setRecoverySlotStatus('✓ 已回退到 ' + s.slotId + (r.backupFile ? '，原配置备份为 ' + r.backupFile : '') + '，服务已重新启动', 'ok');
  } else {
    setRecoverySlotStatus('✕ ' + ((r && r.error) || '回退失败，请查看日志'), 'error');
  }
  const st = await cmd('getState');
  if (st) render(st);
}

function renderRecovery(state) {
  const r = (state && state.recovery) || {};

  // 需要注意的情况：有异常才用警示配色，正常时就一行"一切正常"
  const notes = [];
  if (r.lastExit === 'crashed') {
    notes.push('上次启动器未正常退出（最近一次启动 ' + (fmtLocalTime(r.lastCrashAt) || '未知时间') + '），诊断报告已保存到日志目录');
  }
  if (r.recoveredAt) {
    notes.push('已回退到健康配置（' + fmtLocalTime(r.recoveredAt) + '）' + (r.backupFile ? '，原配置已备份为 ' + r.backupFile : ''));
  }
  if (r.autoRestartStopped) {
    notes.push('自动恢复已停止：服务连续启动失败，请查看日志后手动处理');
  }
  const noteRow = $('recoveryStatusRow');
  if (noteRow) noteRow.classList.toggle('warn', notes.length > 0);
  const iconEl = $('recoveryStatusIcon');
  if (iconEl) iconEl.textContent = notes.length ? '⚠' : '✓';
  const detailEl = $('recoveryStatusDetail');
  if (detailEl) {
    detailEl.textContent = notes.length ? notes.join('；') : '没有未处理的异常。服务反复启动失败时，可用下面的检查点回退配置。';
  }

  // 健康检查点：紧凑行（最新在上；主进程侧有 5s 缓存）
  const wrap = $('recoverySlots');
  const slots = Array.isArray(r.checkpoints) ? r.checkpoints : [];
  if (wrap) {
    const sig = JSON.stringify(slots);
    if (wrap.dataset.sig !== sig) {
      wrap.dataset.sig = sig;
      wrap.textContent = '';
      if (!slots.length) {
        const empty = document.createElement('div');
        empty.className = 'recovery-hint';
        empty.textContent = '还没有检查点：服务正常启动一次后会自动记录。';
        wrap.appendChild(empty);
      } else {
        for (const s of slots) wrap.appendChild(recoverySlotEl(s));
      }
    }
  }

  // 服务状态 + 操作按钮
  const phase = (state && state.phase) || (state && state.running ? 'ready' : 'stopped');
  const busy = phase === 'starting' || phase === 'stopping' || phase === 'restarting' || !!(state && state.settling);
  const sState = $('recoveryServiceState');
  if (sState) {
    sState.textContent = state && state.running ? '运行中（PID ' + (state.pid || '-') + '）'
      : phase === 'starting' ? '正在启动…' : phase === 'stopping' ? '正在停止…' : '已停止';
  }
  const dot = $('diagServiceDot');
  if (dot) dot.className = 'dot' + (state && state.running ? ' running' : ' stopped');
  const bStart = $('btnRecoveryStart');
  const bStop = $('btnRecoveryStop');
  const bRestart = $('btnRecoveryRestart');
  if (bStart) bStart.disabled = !!(state && state.running) || busy;
  if (bStop) bStop.disabled = !(state && state.running) || busy;
  if (bRestart) bRestart.disabled = busy;
}
$('btnRecoveryRefresh').addEventListener('click', () => {
  void cmd('getState').then((s) => { if (s) render(s) });
});
$('btnRecoveryStart').addEventListener('click', () => { void cmd('start') });
$('btnRecoveryStop').addEventListener('click', () => { void cmd('stop') });
// 与主页按钮同一入口：停 → 起 → 刷新独立窗口（服务未运行时就退化为单纯启动）
$('btnRecoveryRestart').addEventListener('click', () => { void cmd('restartDsh') });
$('btnRecoveryDiag').addEventListener('click', async () => {
  setRecoveryDiagStatus('正在生成诊断报告…', '');
  const r = await cmd('diagnosticNow');
  if (r && r.ok) setRecoveryDiagStatus('✓ 诊断报告已保存到诊断目录（保留最近 3 份）', 'ok');
  else setRecoveryDiagStatus('✕ 生成失败，请查看日志', 'error');
});
$('btnRecoveryDiagDir').addEventListener('click', () => { void cmd('openDiagnosticsDir') });

// ---------- 事件绑定 ----------

$('btnOpen').addEventListener('click', () => {
  // 环境缺失时"打开 DeepSeek Harness"→ 直接跳转运行环境页（一键安装向导），不尝试打开独立窗口
  const env = window._envSummary;
  if (env && !env.ready) { showPage('env'); return; }
  cmd('openWeb');
});
$('urlText').addEventListener('click', () => {
  if (window._currentUrl) cmd('openUrlExternal');
});
// DSH 版本行：点击打开 npm 官方页面
$('dshVersion').addEventListener('click', () => cmd('openNpmDsh'));
// 启动/停止：启动失败不再静默 —— 按主进程回传的原因跳页或就地提示 8 秒
let toggleHintTimer = null;
function showToggleHint(text, kind) {
  const el = $('toggleHint');
  if (!el) return;
  el.textContent = text;
  el.className = 'recovery-hint' + (kind ? ' ' + kind : '');
  if (toggleHintTimer) clearTimeout(toggleHintTimer);
  toggleHintTimer = setTimeout(() => {
    const now = $('toggleHint');
    if (now) now.classList.add('hidden');
  }, 8000);
}
$('btnToggle').addEventListener('click', async () => {
  const btn = $('btnToggle');
  const wasServing = !!window._running; // 运行中点击 = 重启；未运行 = 启动（主进程同一入口，语义一致）
  btn.disabled = true;
  const r = await cmd('restartDsh');
  btn.disabled = false;
  if (r && r.ok) return;
  const reason = (r && r.reason) || 'start-failed';
  if (reason === 'env-not-ready') {
    // 环境未就绪：把用户直接送到"运行环境"页（那里就是一键安装入口）
    showToggleHint('运行环境未就绪：先完成环境安装，装好后会自动启动服务', 'error');
    showPage('env');
  } else if (reason === 'blocked') {
    showToggleHint((r && r.error) || '端口被其他程序占用：按上方警示卡一键换端口，或关闭占用程序', 'error');
  } else if (reason === 'busy') {
    showToggleHint('服务正在停止或交接中：请稍候再试', 'error');
  } else {
    showToggleHint(wasServing ? '重启失败，服务已停止：请查看日志后重试' : '服务启动失败：请查看日志（详细原因已写入 dshl.log）', 'error');
  }
});
// 崩溃提示卡「知道了」：主进程记账后立即隐藏（同一次崩溃不再重复提示）
$('btnCrashNoteClose').addEventListener('click', async () => {
  await cmd('ackCrashNotice');
  const el = $('crashNote');
  if (el) el.classList.add('hidden');
});
$('btnCrashNoteRecover').addEventListener('click', () => showPage('recovery'));
$('btnCrashNoteDiag').addEventListener('click', async () => {
  const btn = $('btnCrashNoteDiag');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导出中…';
  const r = await cmd('diagnosticNow');
  btn.textContent = r && r.ok ? '已导出 ✓' : '导出失败';
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 3000);
});
$('btnTest').addEventListener('click', () => cmd('testNotify'));
$('btnLogs').addEventListener('click', () => showPage('log'));

$('btnConsoleReturn').addEventListener('click', () => { void cmd('consoleClose'); });
document.querySelectorAll('#consoleNav .console-nav-item').forEach((el) => {
  el.addEventListener('click', () => showPage(el.dataset.page));
});
$('btnOpenLogsDir').addEventListener('click', () => cmd('openLogs'));


// 日志与反馈页：复制全部日志 / 清空显示（只清界面，不动日志文件）
$('btnLogCopyAll').addEventListener('click', async () => {
  const btn = $('btnLogCopyAll');
  const text = $('logFull').textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '已复制 ✓';
  } catch {
    btn.textContent = '复制失败';
  }
  setTimeout(() => { btn.textContent = '复制'; }, 2000);
});

$('btnLogClear').addEventListener('click', () => {
  $('logFull').textContent = '（已清空显示，新日志会继续追加）';
});
$('btnAuto').addEventListener('click', () => cmd('toggleAutostart'));
$('btnNotify').addEventListener('click', () => {
  const chip = $('btnNotify');
  cmd('setNotify', !chip.classList.contains('checked'));
});
$('btnOpenEnv').addEventListener('click', () => showPage('env'));
$('btnEnvBack').addEventListener('click', () => showPage('settings'));
$('btnReset').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '恢复默认设置？',
    body: '会重置缩放、主题、端口、更新渠道与通知开关，并把窗口恢复为默认尺寸；已安装的 Node / pnpm / DSH 与 DSH 自己的数据不受影响。',
    confirmText: '恢复默认',
    danger: true,
  });
  if (ok) void cmd('resetDefaults');
});

// 运行环境页
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

// 版本行内联检查结果提示：8 秒后自动消失（新状态到达会重置计时）
const versionHintTimers = {};
function flashVersionHint(el, text, title, key) {
  if (!el) return;
  if (versionHintTimers[key]) { clearTimeout(versionHintTimers[key]); versionHintTimers[key] = null; }
  el.textContent = text;
  el.title = title || '';
  if (text) versionHintTimers[key] = setTimeout(() => { el.textContent = ''; el.title = ''; versionHintTimers[key] = null; }, 8000);
}

// ---------- 自动更新（electron-updater → GitHub Releases） ----------
function renderUpdater(u) {
  if (!u) return;
  window._updater = u;
  const hasUpdate = (u.status === 'downloading' || u.status === 'downloaded') && !!u.latest;

  // 主页面最低端"启动器版本"行：检测到更新时同行显示"更新到 vX"按钮
  const updateBtn = $('btnUpdateNow');
  updateBtn.classList.toggle('hidden', !hasUpdate);
  updateBtn.disabled = u.status === 'downloading'; // 下载中禁用：此时点它只会"重新检查"，误导用户
  updateBtn.classList.toggle('update-ready', u.status === 'downloaded'); // 只对"已就绪"用绿色强调
  if (u.status === 'downloading') updateBtn.textContent = `下载中 ${u.percent || 0}%…`;
  else if (hasUpdate) updateBtn.textContent = `更新到 v${u.latest}`;
  // 悬停"检查更新"按钮：有可用更新时隐藏（避免与"更新到 vX"并存）；检查中显示"检查中…"并禁用
  const hoverCheck = $('btnUpCheckNow');
  if (hoverCheck) {
    hoverCheck.style.display = hasUpdate ? 'none' : '';
    hoverCheck.disabled = u.status === 'checking';
    hoverCheck.textContent = u.status === 'checking' ? '检查中…' : '检查更新';
  }
  // 版本行内联检查结果反馈（8 秒后自动消失，避免常驻）
  const rowHint = $('updRowHint');
  if (rowHint) {
    let text = '';
    if (u.status === 'checking') text = '正在检查更新…';
    else if (u.status === 'downloading') text = `发现新版本 v${u.latest}，下载中…`;
    else if (u.status === 'downloaded') text = `新版本 v${u.latest} 已就绪`;
    else if (u.status === 'up-to-date') text = '已是最新版本';
    else if (u.status === 'error') text = '检查更新失败';
    flashVersionHint(rowHint, text, text === '检查更新失败' ? (u.error || '') : '', 'upd');
  }
}

// 主页面底端链接
$('btnGithub').addEventListener('click', () => void cmd('openGithub'));
$('btnChangelog').addEventListener('click', () => void cmd('openChangelog'));
// 主页面"启动器版本"行按钮：已就绪 → 立即安装；否则 → 检查更新
$('btnUpdateNow').addEventListener('click', () => {
  const u = window._updater;
  if (u && u.status === 'downloaded') void cmd('updaterInstall');
  else void cmd('updaterCheck');
});
// 主页面"启动器版本"行：悬停"检查更新"按钮
$('btnUpCheckNow').addEventListener('click', () => void cmd('updaterCheck'));

// ---------- DSH 更新（检测全自动、更新全手动：点"立即更新"才执行） ----------
// 主页最低端"DSH版本"行按钮：只有检测到更新（或更新中/失败重试）才显示；
// 设置页"DSH版本与更新"行：检查按钮常驻，详情行显示检查/更新进度与结果；
// 源码安装（kind=source）不自动更新：按钮改为"打开源码目录"，需手动 git pull && pnpm run build
function renderDshUpdate(u) {
  window._dshUpdate = u || null;
  const status = u ? u.status : 'idle';
  const latest = u ? u.latest : '';
  const kind = u ? u.kind : '';
  const isSource = kind === 'source';

  // 主页面按钮
  const btn = $('btnDshUpdateNow');
  if (btn) {
    const show = status === 'available' || status === 'updating' || status === 'error';
    btn.classList.toggle('hidden', !show);
    if (show) {
      if (status === 'available' && isSource) {
        btn.disabled = false;
        btn.textContent = '手动更新';
        btn.title = `新版本 v${latest} 可用：当前为源码安装，点此打开源码目录（git pull && pnpm run build 后重启服务）`;
      } else if (status === 'available') {
        btn.disabled = false;
        btn.textContent = '立即更新';
        btn.title = u.prewarmed
          ? `新版本 v${latest} 可用（缓存已预热）：点击后约 10 秒完成（会重启服务，进行中的对话会中断）`
          : `新版本 v${latest} 可用：点击后约 1-2 分钟完成（会重启服务，进行中的对话会中断）`;
      } else if (status === 'updating') {
        btn.disabled = true;
        btn.textContent = '更新中…';
        btn.title = '更新完成后会自动重启服务';
      } else {
        btn.disabled = false;
        btn.textContent = '重试';
        btn.title = (u.error || '未知错误') + '（旧版本不受影响，仍可正常使用）';
      }
    }
  }

  // 悬停"检查更新"按钮：已有更新/更新中时隐藏；检查中显示"检查中…"并禁用
  // 失败态（error）保留这个按钮：更新被拦下（目标版本低于当前/缓存已作废）时，用户需要一条"重新检查"的路，
  // 否则失败态下只剩「重试」，而重试走的是同一条被拦下的判定。
  const hoverCheck = $('btnDshCheckHover');
  if (hoverCheck) {
    hoverCheck.style.display = (status === 'available' || status === 'updating') ? 'none' : '';
    hoverCheck.disabled = status === 'checking';
    hoverCheck.textContent = status === 'checking' ? '检查中…' : '检查更新';
  }
  // 版本行内联检查结果反馈（8 秒后自动消失，避免常驻）
  const rowHint = $('dshUpdRowHint');
  if (rowHint) {
    let text = '';
    if (status === 'checking') text = '正在检查更新…';
    else if (status === 'available') text = `发现新版本 v${latest}`;
    else if (status === 'updating') text = `更新中 v${latest}…`;
    else if (status === 'updated') text = `已更新到 v${u.current}`;
    else if (status === 'up-to-date') text = '已是最新版本';
    else if (status === 'error') text = '检查/更新失败';
    flashVersionHint(rowHint, text, text === '检查/更新失败' ? (u.error || '') : '', 'dsh');
  }

  // 设置页不再有"DSH版本与更新"行：版本、检查、更新入口都在主页面行内
}
$('btnDshUpdateNow').addEventListener('click', () => {
  const u = window._dshUpdate;
  if (!u) { void cmd('dshCheckNow'); return; }
  // 源码形态：打开源码目录手动更新；失败重试：源码=重新检查，其余=重试更新；其余情况=立即更新
  if (u.kind === 'source') void cmd('openDshDir');
  else if (u.status === 'error') void cmd('dshUpdateNow');
  else if (u.status === 'available') void cmd('dshUpdateNow');
  else void cmd('dshCheckNow');
});
// 主页面"DSH版本"行：悬停"检查更新"按钮
$('btnDshCheckHover').addEventListener('click', () => void cmd('dshCheckNow'));

// ---------- 插件页：state.plugins 数据驱动，新增插件无需改渲染逻辑 ----------
function pluginMatches(p, filter, query) {
  if (filter === 'installed' && !(p.installed || p.enabled)) return false;
  if (filter === 'available' && (p.installed || p.enabled)) return false;
  if (!query) return true;
  return [p.name, p.subtitle, p.description, p.id, p.category].some((v) => String(v || '').toLowerCase().includes(query));
}

function pluginCardEl(p) {
  const card = document.createElement('article');
  card.className = 'plugin-card' + (p.busy ? ' busy' : '');
  card.dataset.pluginId = p.id;

  // 标题行：名称 + 版本（参考「设置 → 插件」的排版）
  const head = document.createElement('div'); head.className = 'plugin-card-head';
  const name = document.createElement('span'); name.className = 'plugin-name'; name.textContent = p.name || p.id;
  const ver = String(p.version || '').trim();
  const nameText = ver ? (p.name || p.id) + ' v' + ver : (p.name || p.id);
  name.textContent = nameText;
  head.appendChild(name);

  // 包名（等宽字体，长名自动换行不撑破卡片）；默认代装的插件在后面缀上来源说明
  const subtitle = document.createElement('div'); subtitle.className = 'plugin-subtitle';
  const autoLabel = String(p.autoInstallLabel || '');
  subtitle.textContent = p.subtitle || p.id;
  if (autoLabel && autoLabel !== '手动安装') {
    // 「预装 (推荐开启)」渲染成绿色标签，其余来源说明保持灰色文本
    const sep = document.createElement('span'); sep.textContent = ' · ';
    subtitle.appendChild(sep);
    const tag = document.createElement('span');
    if (p.autoInstall && autoLabel === '预装 (推荐开启)') tag.className = 'plugin-badge-preinstall';
    tag.textContent = autoLabel;
    subtitle.appendChild(tag);
  }

  const desc = document.createElement('div'); desc.className = 'plugin-description'; desc.textContent = p.description || '';

  // 备注：只读展示 + 点击后在原位编辑（保存到 DSHL 配置，不影响 DSH）
  const note = document.createElement('div'); note.className = 'plugin-note';
  const noteText = document.createElement('textarea');
  noteText.className = 'text-input plugin-note-input';
  noteText.rows = 2;
  noteText.maxLength = 500;
  noteText.placeholder = '给这个插件写点备注，例如为什么装、给谁用…';
  noteText.value = p.note || '';
  note.appendChild(noteText);
  const noteSave = document.createElement('button');
  noteSave.className = 'btn plugin-note-save';
  noteSave.dataset.pluginNoteSave = '1';
  noteSave.textContent = '保存备注';
  note.appendChild(noteSave);

  // 备注入口放标题行右端：省掉一整行，卡片更紧凑（编辑器仍在下方按需展开）
  const noteToggle = document.createElement('button');
  noteToggle.className = 'btn plugin-note-toggle';
  noteToggle.dataset.pluginNoteToggle = '1';
  noteToggle.textContent = p.note ? '编辑备注' : '添加备注';
  head.appendChild(noteToggle);

  // 底部：启用开关 + 版本说明 + 操作按钮
  const footer = document.createElement('div'); footer.className = 'plugin-card-footer';
  const active = !!(p.installed || p.enabled);

  // 真实启停：手机连接走装/卸，npm 插件走 user patch layer（不卸载、可直接热切换）。
  // 不能识别加载项的插件仍退化为只读状态胶囊，避免出现点了没反应的开关。
  const switchWrap = document.createElement('label'); switchWrap.className = 'plugin-switch';
  const switchInput = document.createElement('input');
  switchInput.type = 'checkbox';
  switchInput.checked = !!p.enabled;
  switchInput.disabled = !!p.busy;
  if (p.toggleAction) switchInput.dataset.pluginAction = p.toggleAction;
  switchInput.dataset.pluginId = p.id;
  switchInput.title = p.busy ? '处理中…' : (p.enabled ? '关闭' : '开启');
  switchInput.setAttribute('aria-label', switchInput.title);
  const switchTrack = document.createElement('span'); switchTrack.className = 'plugin-switch-track';
  const switchThumb = document.createElement('span'); switchThumb.className = 'plugin-switch-thumb';
  switchTrack.appendChild(switchThumb);
  switchWrap.appendChild(switchInput); switchWrap.appendChild(switchTrack);

  // 只读状态胶囊：无法识别加载项、未安装或操作中时展示状态
  const statePill = document.createElement('span');
  statePill.className = 'plugin-state-pill ' + ((p.status && p.status.tone) || 'muted');
  statePill.textContent = (p.status && p.status.label) || (active ? '已启用' : '未安装');

  const actions = document.createElement('div'); actions.className = 'plugin-actions';
  // 版本提示：只有拿到 npm 侧最新版时才显示，避免「已是最新」是伪结论
  const latestKnown = !!(p.latestVersion && p.version && p.latestVersion === p.version);
  if (p.outdated && p.latestVersion) {
    const latest = document.createElement('span'); latest.className = 'plugin-latest';
    latest.textContent = '可更新到 v' + p.latestVersion;
    actions.appendChild(latest);
  } else if (latestKnown) {
    const latest = document.createElement('span'); latest.className = 'plugin-latest'; latest.textContent = '已是最新';
    actions.appendChild(latest);
  }
  const list = Array.isArray(p.actions) ? p.actions : [];
  if (!list.length && p.busy) {
    const wait = document.createElement('span'); wait.className = 'plugin-action-hint'; wait.textContent = '正在处理…'; actions.appendChild(wait);
  }
  for (const act of list) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (act.tone === 'primary' ? 'primary ' : act.tone === 'danger' ? 'danger ' : '') + 'plugin-action-btn';
    btn.dataset.pluginId = p.id;
    btn.dataset.pluginAction = act.action;
    if (act.confirmTitle) btn.dataset.confirmTitle = act.confirmTitle;
    if (act.confirmBody) btn.dataset.confirmBody = act.confirmBody;
    btn.textContent = act.label || act.action;
    if (p.busy) btn.disabled = true;
    actions.appendChild(btn);
  }
  footer.appendChild(p.toggleAction ? switchWrap : statePill); footer.appendChild(actions);

  const feedback = document.createElement('div'); feedback.className = 'plugin-feedback';
  const feedbackText = p.error ? '✕ ' + p.error : (p.lastChange ? '✓ ' + p.lastChange : '');
  feedback.textContent = feedbackText;
  feedback.classList.toggle('hidden', !feedbackText);

  card.appendChild(head); card.appendChild(subtitle); card.appendChild(desc);
  card.appendChild(note); card.appendChild(footer); card.appendChild(feedback);
  return card;
}
function renderPlugins(plugins, force) {
  const list = Array.isArray(plugins) ? plugins : [];
  const cards = $('pluginCards');
  if (!cards) return;
  window._plugins = list;
  const sig = JSON.stringify(list);
  if (!force && sig === window._lastPluginsJson) return;
  window._lastPluginsJson = sig;

  const query = ($('pluginSearch') && $('pluginSearch').value ? $('pluginSearch').value : '').trim().toLowerCase();
  const filter = window._pluginFilter || 'all';
  const visible = list.filter((p) => pluginMatches(p, filter, query));
  const installedCount = list.filter((p) => p.installed).length;
  const summary = $('pluginSummary');
  const installAll = window._pluginInstallAll;
  const summaryError = installAll && installAll.error ? ' · 上次一键安装有失败项' : '';
  if (summary) summary.textContent = list.length + ' 个插件 · ' + installedCount + ' 个已安装' + summaryError;
  cards.textContent = '';
  for (const p of visible) cards.appendChild(pluginCardEl(p));
  const empty = $('pluginEmpty');
  if (empty) empty.classList.toggle('hidden', visible.length > 0);
  renderInstallAll(installAll);
}

/**
 * 插件变更提示条：装了/卸了插件但还没重启时，内容区顶部常驻一条提醒 + 「立即重启生效」。
 * 状态由主进程持久化在配置里，所以关掉控制台再打开、甚至重启启动器都还在。
 */
function renderPendingRestart(info) {
  const bar = $('pendingRestartBar');
  if (!bar) return;
  const count = (info && info.count) || 0;
  const names = (info && Array.isArray(info.names)) ? info.names : [];
  bar.classList.toggle('hidden', !count);
  const content = $('consoleContent');
  if (content) content.classList.toggle('with-pending-bar', !!count);
  const text = $('pendingRestartText');
  const hint = $('pendingRestartHint');
  const btn = $('btnApplyRestart');
  if (hint) hint.textContent = '重启后才会生效';
  if (btn) {
    btn.disabled = false;
    btn.textContent = '立即重启生效';
    btn.title = '立即重启 DSH 服务并刷新页面';
  }
  if (!count) return;
  if (text) {
    const what = names.length ? names.join('、') : (count + ' 个插件');
    text.textContent = '插件已变更，需要重启服务：' + what;
  }
}

// 生效按钮：停服务 → 起服务 → 刷新窗口。
$('btnApplyRestart').addEventListener('click', async () => {
  const btn = $('btnApplyRestart');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '重启中…';
  const r = await cmd('pluginsApplyRestart');
  if (!r || !r.ok) {
    btn.disabled = false;
    btn.textContent = old;
  }
});

function renderInstallAll(info) {
  window._pluginInstallAll = info || null;
  const btn = $('btnPluginsInstallAll');
  if (!btn) return;
  const running = !!(info && info.running);
  const total = (info && info.target) || 0;
  const done = (info && info.done) || 0;
  if (running) {
    const current = info && info.current ? ' · ' + info.current : '';
    btn.textContent = '安装中 (' + done + '/' + total + ')' + current + '…';
    btn.disabled = true;
    return;
  }
  btn.textContent = '一键全部安装';
  btn.disabled = false;
}

function setPluginFilter(filter) {
  window._pluginFilter = filter;
  document.querySelectorAll('#pluginFilters [data-plugin-filter]').forEach((el) => {
    el.classList.toggle('checked', el.dataset.pluginFilter === filter);
  });
  renderPlugins(window._plugins || [], true);
}

// 卡片内所有交互走这里：操作按钮 / 备注开关 / 开关式插件的启停
$('pluginCards').addEventListener('click', async (e) => {
  const noteSave = e.target.closest('button[data-plugin-note-save]');
  if (noteSave) {
    const card = noteSave.closest('.plugin-card');
    const id = card && card.dataset.pluginId;
    const input = card && card.querySelector('.plugin-note-input');
    noteSave.disabled = true;
    noteSave.textContent = '保存中…';
    const r = await cmd('pluginSetNote', { id, text: input ? input.value : '' });
    const fresh = await cmd('pluginsGetState');
    if (fresh) renderPlugins(fresh, true);
    if (!r || !r.ok) {
      noteSave.textContent = '保存失败';
      noteSave.disabled = false;
    }
    return;
  }

  const noteToggle = e.target.closest('button[data-plugin-note-toggle]');
  if (noteToggle) {
    const card = noteToggle.closest('.plugin-card');
    if (card) card.classList.toggle('note-open');
    const input = card && card.querySelector('.plugin-note-input');
    if (input && card.classList.contains('note-open')) input.focus();
    return;
  }

  const btn = e.target.closest('button[data-plugin-action]');
  if (!btn) return;
  const id = btn.dataset.pluginId;
  const action = btn.dataset.pluginAction;
  if (btn.dataset.confirmTitle) {
    const ok = await confirmDialog({
      title: btn.dataset.confirmTitle,
      body: btn.dataset.confirmBody || '',
      confirmText: btn.textContent,
      danger: btn.classList.contains('danger'),
    });
    if (!ok) return;
  }
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  const r = await cmd('pluginAction', { id, action });
  const fresh = await cmd('pluginsGetState');
  if (fresh) renderPlugins(fresh, true);
  if (!r || !r.ok) {
    const card = btn.closest('.plugin-card');
    const feedback = card && card.querySelector('.plugin-feedback');
    if (feedback) {
      feedback.textContent = '✕ ' + ((r && r.error) || '操作失败，请查看日志');
      feedback.classList.remove('hidden');
    }
    btn.disabled = false;
    btn.textContent = old;
  }
});

// 开关式插件（如手机连接）：勾选即开启、取消即关闭并卸载
$('pluginCards').addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-plugin-action]');
  if (!input) return;
  const id = input.dataset.pluginId;
  const turnOn = input.checked;
  const action = turnOn ? 'enable' : 'disable';
  input.disabled = true;
  const r = await cmd('pluginAction', { id, action });
  if (r && r.ok) {
    const verb = turnOn ? '已开启' : '已关闭';
    showConsoleToast(r.restartPending ? `插件${verb}；点顶部「立即重启生效」后生效` : `插件${verb}`);
  }
  const fresh = await cmd('pluginsGetState');
  if (fresh) renderPlugins(fresh, true);
  if (!r || !r.ok) {
    input.checked = !turnOn;
    input.disabled = false;
    const card = input.closest('.plugin-card');
    const feedback = card && card.querySelector('.plugin-feedback');
    if (feedback) {
      feedback.textContent = '✕ ' + ((r && r.error) || '操作失败，请查看日志');
      feedback.classList.remove('hidden');
    }
  }
});

$('btnPluginsRefresh').addEventListener('click', async () => {
  const btn = $('btnPluginsRefresh');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    const fresh = await cmd('pluginCheckUpdates');
    if (fresh) renderPlugins(fresh, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});

// 一键全部安装：只装未安装的插件，进度由主进程 state 推送驱动
$('btnPluginsInstallAll').addEventListener('click', async () => {
  const btn = $('btnPluginsInstallAll');
  const ok = await confirmDialog({
    title: '一键安装全部插件？',
    body: '会依次装好所有尚未安装的插件；中途不重启，装完后点顶部「立即重启生效」一次性生效。',
    confirmText: '开始安装',
  });
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = '启动中…';
  const r = await cmd('pluginsInstallAll');
  if (!r || !r.ok) {
    btn.textContent = (r && r.error) || '启动失败';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '一键全部安装'; }, 2500);
  }
});


$('pluginSearch').addEventListener('input', () => renderPlugins(window._plugins || [], true));
document.querySelectorAll('#pluginFilters [data-plugin-filter]').forEach((el) => {
  el.addEventListener('click', () => setPluginFilter(el.dataset.pluginFilter));
});
// 状态卡上的单项安装按钮（事件委托：卡片由 render 重建）
$('envCards').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-env-item]');
  if (!btn) return;
  const item = btn.getAttribute('data-env-item');
  const items = item === 'dsh' ? ['dsh'] : item === 'node' ? ['node'] : ['plugin'];
  void cmd('envInstall', { items });
});

// ---------- 反馈问题对话框 ----------
function showFeedbackStatus(text, kind) {
  const el = $('feedbackStatus');
  el.textContent = text;
  el.className = 'modal-status' + (kind ? ' ' + kind : '');
}
// 反馈表单已从弹窗搬进「日志与反馈」页：入口只负责跳页并聚焦
function openFeedback() {
  showPage('logs');
  showFeedbackStatus('', '');
  const box = $('feedbackText');
  if (box) {
    box.focus();
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
$('btnFeedback').addEventListener('click', openFeedback);
$('btnFeedbackCopy').addEventListener('click', async () => {
  const text = $('feedbackText').value.trim();
  if (!text) { showFeedbackStatus('请先填写问题描述', 'error'); return; }
  const pack = await cmd('feedbackBuild', { text, contact: $('feedbackContact').value, includeLogs: $('feedbackLogs').checked });
  if (pack && pack.body) {
    await cmd('clipboardWrite', pack.body);
    showFeedbackStatus('已复制完整反馈内容（含版本/环境/日志），粘贴到任意地方发送即可', 'ok');
  } else {
    showFeedbackStatus('生成失败', 'error');
  }
});
$('btnFeedbackSend').addEventListener('click', async () => {
  const text = $('feedbackText').value.trim();
  if (!text) { showFeedbackStatus('请先填写问题描述', 'error'); return; }
  showFeedbackStatus('正在提交…');
  const r = await cmd('feedbackSend', { text, contact: $('feedbackContact').value, includeLogs: $('feedbackLogs').checked });
  if (!r) { showFeedbackStatus('提交失败：无响应', 'error'); return; }
  if (r.ok) {
    showFeedbackStatus('已发送到飞书反馈群（作者会即时收到），感谢反馈！', 'ok');
    return;
  }
  if (r.needWebhook) {
    showFeedbackStatus('未配置反馈通道：请用"复制全部"手动提交，或联系作者', 'error');
    return;
  }
  showFeedbackStatus(r.error || '提交失败', 'error');
});
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('confirmOverlay').classList.contains('hidden')) return; // 确认框的捕获监听器优先处理
  void cmd('consoleClose');
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
    if (p && p.lines && window._wizardActive) appendWizardLog(p.lines);
  } catch (err) { console.error('[dshl] env push error:', err); }
});

// 主进程 → 控制台定向跳页（托盘「恢复…」等入口）
window.dshBridge.onConsolePage((json) => {
  try {
    const p = JSON.parse(json);
    if (p && p.page) showPage(p.page);
  } catch (err) { console.error('[dshl] console page push error:', err); }
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
