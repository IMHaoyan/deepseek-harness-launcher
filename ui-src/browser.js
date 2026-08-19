// DSHL 浏览器壳脚本：纯 tab 条渲染 + 意图上报（页面视图由主进程 WebContentsView 原生挂载，零闪烁）
'use strict';

const $ = (id) => document.getElementById(id);
const send = (name, payload) => window.browserBridge.send(name, payload);

let state = { tabs: [], activeId: null, rightId: null, splitOn: false, splitRatio: 0.5, maximized: false, tabsEnabled: false };

function render() {
  const tabsEnabled = state.tabsEnabled !== false;

  // 标签列表：功能开启才渲染
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

  // 精简形态（功能关闭）：标题栏只有 标题 + 最小化/最大化/关闭
  $('tabs').style.display = tabsEnabled ? '' : 'none';
  $('btnNew').style.display = tabsEnabled ? '' : 'none';
  $('btnSplit').style.display = tabsEnabled ? '' : 'none';

  // 白屏修复按钮：活动标签为空白（加载失败）时显示
  const active = state.tabs.find((t) => t.id === state.activeId);
  $('btnFix').classList.toggle('hidden', !(active && active.blank));
  const titleOnly = $('titleOnly');
  if (titleOnly) {
    const active = state.tabs.find((t) => t.id === state.activeId);
    const text = active?.title || 'DeepSeek Harness';
    titleOnly.textContent = text;
    titleOnly.title = text;
    titleOnly.classList.toggle('hidden', tabsEnabled);
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

// ---------- 快捷键（焦点在壳上时；焦点在页面内时由主进程 before-input-event 处理） ----------
window.addEventListener('keydown', (e) => {
  if (state.tabsEnabled === false) return; // 功能关闭：标签/分屏快捷键一并禁用
  const key = (e.key || '').toLowerCase();
  if (e.ctrlKey && key === '\\') { e.preventDefault(); send('splitToggle'); }
  else if (e.ctrlKey && e.key === 'Delete') { e.preventDefault(); send('closePane'); }
  else if (e.shiftKey && e.altKey && key === 's') { e.preventDefault(); send('swapPanes'); }
});

// ---------- 按钮 ----------
$('btnNew').addEventListener('click', () => send('tabNew'));
$('btnSplit').addEventListener('click', () => send('splitToggle'));
$('btnFix').addEventListener('click', () => send('fixPane', { id: state.activeId }));
$('btnMin').addEventListener('click', () => send('winMin'));
$('btnMax').addEventListener('click', () => send('winMax'));
$('btnClose').addEventListener('click', () => send('winClose'));

// ---------- 初始化 ----------
window.browserBridge.onState((s) => { state = s; document.body.classList.add('ready'); render(); });
