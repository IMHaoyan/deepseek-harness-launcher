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
  $('pageBalance').classList.toggle('hidden', name !== 'balance');
  $('pageWizard').classList.toggle('hidden', name !== 'wizard');
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
  const dshUpdStatusEl = $('dshUpdaterStatus'); // 设置页"DSH版本与更新"行的版本值
  if (dshUpdStatusEl) {
    dshUpdStatusEl.textContent = dshVerText;
    dshUpdStatusEl.title = dshV && state.env && state.env.dsh && state.env.dsh.dir
      ? `v${dshV} · ${dshKindLabel || ''} · ${state.env.dsh.dir}` : '';
  }

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
  renderToggleChip('btnTabsEnabled', !!state.tabsEnabled, '开启', '关闭');

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
    // 首次检测到未就绪：自动进入新手向导（欢迎屏有"跳过向导，手动配置"入口；仅自动一次，不打断用户后续操作）
    if (!window._envAutoShown) {
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
$('btnWizardSkip').addEventListener('click', () => {
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
$('btnToggle').addEventListener('click', () => cmd(window._running ? 'stop' : 'start'));
$('btnTest').addEventListener('click', () => cmd('testNotify'));
$('btnLogs').addEventListener('click', () => showPage('log'));
$('btnBack').addEventListener('click', () => showPage('main'));
$('btnSettings').addEventListener('click', () => showPage('settings'));
$('btnSettingsBack').addEventListener('click', () => showPage('main'));
$('btnOpenLogsDir').addEventListener('click', () => cmd('openLogs'));
$('btnAuto').addEventListener('click', () => cmd('toggleAutostart'));
$('btnNotify').addEventListener('click', () => {
  const chip = $('btnNotify');
  cmd('setNotify', !chip.classList.contains('checked'));
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
  const current = u.current || '-';
  const hasUpdate = (u.status === 'downloading' || u.status === 'downloaded') && !!u.latest;

  // 主页面最低端"启动器版本"行：检测到更新时同行显示"更新到 vX"按钮
  const updateBtn = $('btnUpdateNow');
  updateBtn.classList.toggle('hidden', !hasUpdate);
  if (hasUpdate) updateBtn.textContent = `更新到 v${u.latest}`;
  // 悬停"检查更新"按钮：有可用更新时隐藏（避免与"更新到 vX"并存）
  const hoverCheck = $('btnUpCheckNow');
  if (hoverCheck) hoverCheck.style.display = hasUpdate ? 'none' : '';

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
// 主页面"启动器版本"行按钮：已就绪 → 立即安装；否则 → 检查更新
$('btnUpdateNow').addEventListener('click', () => {
  const u = window._updater;
  if (u && u.status === 'downloaded') void cmd('updaterInstall');
  else void cmd('updaterCheck');
});
// 版本与更新按钮（设置页）：已就绪 → 立即安装；否则 → 检查更新
$('btnUpdaterCheck').addEventListener('click', () => {
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
        btn.title = `新版本 v${latest} 可用：点击后约 1 分钟完成（会重启服务，进行中的对话会中断）`;
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

  // 悬停"检查更新"按钮：已有更新/更新中/失败重试时隐藏（避免与"立即更新/重试"并存）
  const hoverCheck = $('btnDshCheckHover');
  if (hoverCheck) hoverCheck.style.display = (status === 'available' || status === 'updating' || status === 'error') ? 'none' : '';

  // 设置页"DSH版本与更新"行
  const checkBtn = $('btnDshCheck');
  if (checkBtn) {
    const ready = status === 'available' && !isSource;
    const openDir = status === 'available' && isSource;
    checkBtn.disabled = status === 'checking' || status === 'updating';
    checkBtn.textContent = openDir ? '打开源码目录'
      : ready ? `更新到 v${latest}`
      : status === 'checking' ? '检查中…'
      : status === 'updating' ? '更新中…'
      : '检查更新';
    checkBtn.classList.toggle('update-ready', ready);
  }
  const detailRow = $('dshUpdaterDetailRow');
  const detail = $('dshUpdaterDetail');
  if (detailRow && detail) {
    let text = '';
    if (status === 'checking') text = '正在检查更新…';
    else if (status === 'available' && isSource) text = `发现新版本 v${latest}：当前为源码安装，启动器不自动更新——请打开源码目录执行 git pull && pnpm run build，构建完成后重启服务生效`;
    else if (status === 'available') text = `发现新版本 v${latest}：点"更新到 v${latest}"立即更新（约 1 分钟，会重启服务）`;
    else if (status === 'updating') text = `正在更新 v${latest}…（完成后自动重启服务）`;
    else if (status === 'updated') text = `已更新到 v${u.current}`;
    else if (status === 'up-to-date') text = '已是最新版本';
    else if (status === 'error') text = '检查/更新失败：' + (u.error || '未知错误');
    detail.textContent = text;
    detailRow.classList.toggle('hidden', !text);
  }
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
// 设置页 DSH 检查按钮：源码形态 → 打开源码目录；已有更新/失败重试（非源码）→ 立即更新；否则 → 手动检查（跳过 24h 节流）
$('btnDshCheck').addEventListener('click', () => {
  const u = window._dshUpdate;
  if (u && u.status === 'available' && u.kind === 'source') void cmd('openDshDir');
  else if (u && (u.status === 'available' || (u.status === 'error' && u.kind !== 'source'))) void cmd('dshUpdateNow');
  else void cmd('dshCheckNow');
});
// 主页面"DSH版本"行：悬停"检查更新"按钮
$('btnDshCheckHover').addEventListener('click', () => void cmd('dshCheckNow'));

// ---------- 余额（cc-switch 风格：主页只显示金额 + ↻ + ⚙；⚙ 进入设置页测试并保存） ----------
const BALANCE_INTERVAL_MS = 3 * 60 * 1000
let balanceTimer = null

async function refreshBalanceConfig() {
  const s = await cmd('balanceGet')
  if (!s) return
  window._balanceCfg = s
  const keyEl = $('balanceKey')
  keyEl.value = s.key || '' // 明文显示当前生效的密钥（已保存或 DSH 配置）
  keyEl.placeholder = s.key ? '' : 'sk-...（未找到密钥：请填入，或配置 DSH 的 DEEPSEEK_API_KEY）'
  const urlEl = $('balanceBaseUrl')
  if (!s.baseUrl) {
    urlEl.value = ''
    urlEl.placeholder = s.dshBaseUrl ? `自动：DSH 配置（${s.dshBaseUrl}）` : '自动：官方 api.deepseek.com'
  } else {
    urlEl.value = s.baseUrl
  }
  const hint = $('balanceCurrentHint')
  if (s.keySource === 'saved') hint.textContent = '当前：已保存的自定义设置' + (s.baseUrl ? ` · ${s.baseUrl}` : ' · 官方接口')
  else if (s.keySource === 'dsh') hint.textContent = `当前：自动读取 DSH 配置${s.dshBaseUrl ? ' · ' + s.dshBaseUrl : ''}`
  else hint.textContent = '当前：未找到密钥（请填写，或配置 DSH 的 DEEPSEEK_API_KEY）'
}

function renderBalanceResult(r) {
  const valueEl = $('balanceValue')
  if (!r || !r.ok) {
    valueEl.className = 'value strong status-value stopped'
    valueEl.textContent = '查询失败'
    valueEl.title = (r && r.error) || '未知错误'
    return
  }
  const d = r.data
  const fmt = (n) => (n == null ? '-' : Number(n).toFixed(2))
  const first = d.balance_infos[0]
  const total = first && first.total != null ? fmt(first.total) : null
  const avail = d.is_available
  valueEl.className = 'value strong status-value ' + (avail ? 'running' : 'stopped')
  valueEl.textContent = total != null ? `¥${total}` : '--'
  valueEl.title = `${avail ? '可用' : '不可用（余额不足）'} · ${d.balance_infos.map((i) => `${i.currency} 总额 ${fmt(i.total)}（充值 ${fmt(i.toppedUp)} / 赠送 ${fmt(i.granted)}）`).join('；')} · 接口 ${d.endpoint}`
}

async function queryBalance() {
  const valueEl = $('balanceValue')
  valueEl.className = 'value strong status-value'
  valueEl.textContent = '…'
  const r = await cmd('balanceQuery', {
    key: $('balanceKey').value.trim(),
    baseUrl: $('balanceBaseUrl').value.trim(),
  })
  renderBalanceResult(r)
}

function startBalanceTimer() {
  if (balanceTimer) clearInterval(balanceTimer)
  balanceTimer = setInterval(() => void queryBalance(), BALANCE_INTERVAL_MS)
}

$('btnBalanceRefresh').addEventListener('click', () => void queryBalance())
// 设置页"余额接口设置"入口：刷新配置快照后进入余额设置页
$('btnBalanceOpenSettings').addEventListener('click', () => {
  $('balanceTestStatus').className = 'balance-test-status'
  $('balanceTestStatus').textContent = ''
  void refreshBalanceConfig()
  showPage('balance')
})
// 主页面"充值"按钮：打开 DeepSeek 开放平台充值页
$('btnRecharge').addEventListener('click', () => void cmd('openRecharge'))
$('btnBalanceBack').addEventListener('click', () => showPage('main'))
$('btnBalanceTest').addEventListener('click', async () => {
  const st = $('balanceTestStatus')
  st.className = 'balance-test-status'
  st.textContent = '测试中…'
  const key = $('balanceKey').value.trim()
  const baseUrl = $('balanceBaseUrl').value.trim()
  const r = await cmd('balanceQuery', { key, baseUrl })
  if (r && r.ok) {
    await cmd('balanceSave', { key, baseUrl }) // 连通（正确获取到余额）→ 自动保存
    const fmt = (n) => (n == null ? '-' : Number(n).toFixed(2))
    const first = r.data.balance_infos[0]
    const total = first && first.total != null ? fmt(first.total) : '-'
    st.className = 'balance-test-status ok'
    st.textContent = `✓ 连接成功，已自动保存：余额 ¥${total}（${r.data.is_available ? '可用' : '不可用'}）`
    void refreshBalanceConfig()
  } else {
    st.className = 'balance-test-status error'
    st.textContent = '✕ ' + ((r && r.error) || '测试失败')
  }
})
$('btnBalanceClear').addEventListener('click', async () => {
  await cmd('balanceClear')
  $('balanceKey').value = ''
  $('balanceBaseUrl').value = ''
  $('balanceTestStatus').className = 'balance-test-status'
  $('balanceTestStatus').textContent = ''
  void refreshBalanceConfig() // 清除后自动回显 DSH 配置（若有）
  void queryBalance()
})
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
function openFeedback() {
  showFeedbackStatus('', '');
  $('feedbackOverlay').classList.remove('hidden');
  $('feedbackText').focus();
}
function closeFeedback() { $('feedbackOverlay').classList.add('hidden'); }
$('btnFeedback').addEventListener('click', openFeedback);
$('btnFeedbackCancel').addEventListener('click', closeFeedback);
$('feedbackOverlay').addEventListener('mousedown', (e) => {
  if (e.target === $('feedbackOverlay')) closeFeedback();
});
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
  if (e.key === 'Escape' && !$('feedbackOverlay').classList.contains('hidden')) closeFeedback();
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
    await refreshBalanceConfig();
    startBalanceTimer();
    void queryBalance(); // 面板加载即查询一次，此后每 3 分钟自动刷新
  } catch (err) { console.error('[dshl] initial state failed:', err); }
})();
