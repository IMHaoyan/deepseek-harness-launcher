// DSHL 浏览器壳脚本：纯 tab 条渲染 + 意图上报（页面视图由主进程 WebContentsView 原生挂载，零闪烁）
'use strict';

const $ = (id) => document.getElementById(id);
const send = (name, payload) => window.browserBridge.send(name, payload);

let state = { tabs: [], activeId: null, rightId: null, splitOn: false, splitRatio: 0.5, maximized: false, tabsEnabled: false, consoleOpen: false };
let restartErrTimer = null; // 重启失败的红字提示窗口：期间 render 不覆盖按钮文案

function render() {
  // 标签/分屏恒关（设置页开关已移除）：标题栏只保留 标题 + 最小化/最大化/关闭
  const tabsEnabled = state.tabsEnabled !== false;

  const tabsEl = $('tabs');
  tabsEl.textContent = '';
  if (tabsEnabled) {
    for (const t of state.tabs) {
      const btn = document.createElement('div');
      btn.className = 'tab' + (t.id === state.activeId ? ' active' : '');
      const title = document.createElement('span');
      title.className = 't-title';
      title.textContent = t.title || 'DeepSeek Harness';
      const close = document.createElement('button');
      close.className = 't-close';
      close.title = '关闭标签页';
      close.textContent = '×';
      btn.appendChild(title);
      btn.appendChild(close);
      btn.addEventListener('click', () => send('tabActivate', { id: t.id }));
      close.addEventListener('click', (e) => { e.stopPropagation(); send('tabClose', { id: t.id }); });
      tabsEl.appendChild(btn);
    }
  }

  // 精简形态：标题栏只显示当前页标题
  $('tabs').style.display = tabsEnabled ? '' : 'none';
  $('btnNew').style.display = tabsEnabled ? '' : 'none';
  $('btnSplit').style.display = tabsEnabled ? '' : 'none';

  // 控制台打开时隐藏刷新/重启：控制台内部有自己的操作；关闭后恢复 DSH 快捷动作。
  const active = state.tabs.find((t) => t.id === state.activeId);
  const consoleOpen = !!state.consoleOpen;
  $('btnReload').classList.toggle('hidden', consoleOpen);
  $('btnReload').classList.toggle('warn', !!(active && active.blank));
  $('btnRestart').classList.toggle('hidden', consoleOpen);

  // 重启 DSH 按钮：与控制台同源（未运行=启动 / 运行中=重启）。启停/交接/重启期间禁用并显示进度文案，
  // 避免连点出第二条流程；失败态由 flashRestartError 短时接管（此间不覆盖）。
  const btnRestart = $('btnRestart');
  if (btnRestart && !restartErrTimer) {
    const phase = state.service || 'ready';
    const busy = phase === 'starting' || phase === 'stopping' || phase === 'restarting';
    btnRestart.disabled = busy;
    setRestartLabel(busy
      ? (phase === 'stopping' ? '停止中…' : phase === 'restarting' ? '重启中…' : '启动中…')
      : (phase === 'stopped' ? '启动' : '重启'));
    btnRestart.title = phase === 'stopped'
      ? '启动 DSH 服务'
      : '重启 DSH 服务（停止 → 启动 → 刷新窗口；会中断正在跑的会话）';
  }
  const titleOnly = $('titleOnly');
  const titleText = $('titleText');
  if (titleOnly && titleText) {
    const text = consoleOpen ? 'DSHL 控制台' : ((active && active.title) || 'DeepSeek Harness');
    titleText.textContent = text;
    // 控制台显示启动器版本；DSH 页面悬停只给当前运行的 DSH 版本号。
    titleText.title = consoleOpen ? (state.launcherVersion ? 'v' + state.launcherVersion : '') : (state.dshVersionText || '');
  }
  const btnConsole = $('btnConsole');
  if (btnConsole) {
    btnConsole.classList.toggle('active', consoleOpen);
    btnConsole.setAttribute('aria-pressed', consoleOpen ? 'true' : 'false');
    btnConsole.title = consoleOpen ? '返回 DeepSeek Harness' : '打开启动器控制台';
    btnConsole.setAttribute('aria-label', btnConsole.title);
  }

  $('btnSplit').classList.toggle('on', state.splitOn);
  $('divider').classList.toggle('hidden', !state.splitOn);

  // 最大化/还原按钮：Edge 式细线图标实时切换（□ ↔ 双层还原）
  const iconMax = $('iconMax');
  const iconRestore = $('iconRestore');
  if (iconMax && iconRestore) {
    iconMax.hidden = !!state.maximized;
    iconRestore.hidden = !state.maximized;
    $('btnMax').title = state.maximized ? '还原' : '最大化';
  }
  document.documentElement.style.setProperty('--ratio', String(state.splitRatio));
}

// ---------- 分隔条拖拽（rAF 节流上报比例） ----------
let dragging = false;
let ratioPending = false;

$('divider').addEventListener('pointerdown', (e) => {
  dragging = true;
  $('divider').classList.add('dragging');
  $('divider').setPointerCapture(e.pointerId);
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const r = Math.min(0.8, Math.max(0.2, e.clientX / window.innerWidth));
  document.documentElement.style.setProperty('--ratio', String(r));
  if (ratioPending) return;
  ratioPending = true;
  requestAnimationFrame(() => {
    ratioPending = false;
    send('splitRatio', r);
  });
});

window.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  $('divider').classList.remove('dragging');
});

// 重启失败的就地提示：按钮红字 5s（环境未就绪 / 端口被占用时主进程还会把DSHL 控制台带到前台）
const RESTART_ERR_TEXT = {
  'env-not-ready': '运行环境未就绪：已打开 DSHL 控制台，请先完成环境安装',
  blocked: '端口被其他程序占用：已打开 DSHL 控制台，可一键换端口',
  'start-failed': '服务启动失败：打开 DSHL 控制台查看日志',
  busy: '服务正在停止或交接中：请稍候再试',
};

// 文案写在按钮内的 span 上（图标是 SVG，不能被 textContent 冲掉）
function setRestartLabel(text, btn) {
  const target = $('btnRestartLabel') || btn || $('btnRestart');
  if (target) target.textContent = text;
}

function parseResult(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

function flashRestartError(reason) {
  const btn = $('btnRestart');
  if (!btn) return;
  // busy 不是失败（另一个停止/交接流程在途）：只提示稍候，不染红
  const soft = reason === 'busy';
  if (!soft) btn.classList.add('failed');
  setRestartLabel(soft ? '请稍候' : '重启失败', btn);
  btn.title = RESTART_ERR_TEXT[reason] || '重启失败：打开 DSHL 控制台查看日志';
  btn.disabled = true;
  if (restartErrTimer) clearTimeout(restartErrTimer);
  restartErrTimer = setTimeout(() => {
    restartErrTimer = null;
    btn.classList.remove('failed');
    render();
  }, 5000);
}

// ---------- 快捷键（焦点在壳上时；焦点在页面内时由主进程 before-input-event 处理） ----------
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.consoleOpen) { e.preventDefault(); send('consoleToggle'); return; }
  if (state.tabsEnabled === false) return; // 功能恒关：标签/分屏快捷键一并禁用
  const key = (e.key || '').toLowerCase();
  if (e.ctrlKey && key === '\\') { e.preventDefault(); send('splitToggle'); }
  else if (e.ctrlKey && e.key === 'Delete') { e.preventDefault(); send('closePane'); }
  else if (e.shiftKey && e.altKey && key === 's') { e.preventDefault(); send('swapPanes'); }
});

// ---------- 按钮 ----------
$('btnNew').addEventListener('click', () => send('tabNew'));
$('btnSplit').addEventListener('click', () => send('splitToggle'));
$('btnReload').addEventListener('click', () => send('fixPane', { id: state.activeId }));
// 重启 DSH：与控制台同一入口（停 → 起 → 刷新窗口）；失败就地提示，绝不静默
$('btnRestart').addEventListener('click', async () => {
  const btn = $('btnRestart');
  if (btn.disabled) return;
  btn.disabled = true; // 状态推送到达前先自锁，避免连点
  const r = parseResult(await send('restartDsh'));
  // 成功：保持禁用，等主进程状态推送把它切到"重启中…/重启"（避免二次点击叠出第二条流程）
  if (r && r.ok === false) flashRestartError(r.reason);
});
$('btnConsole').addEventListener('click', () => send('consoleToggle'));
$('btnMin').addEventListener('click', () => send('winMin'));
$('btnMax').addEventListener('click', () => send('winMax'));
$('btnClose').addEventListener('click', () => send('winClose'));

// ---------- 初始化 ----------
window.browserBridge.onState((s) => { state = s; document.body.classList.add('ready'); render(); });
