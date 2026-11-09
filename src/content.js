(function () {
  'use strict';

  if (window.__dsCodeNavInit) return;
  window.__dsCodeNavInit = true;

  // ============================================================
  // 常量
  // ============================================================
  const HIGHLIGHT_CLASS = 'ds-code-nav-highlight';
  const VIEWPORT_ANCHOR_RATIO = 0.25; // 滚动落点 / 当前块判定线：视口上方 25%
  const SCROLL_TIMEOUT_MS = 900;
  const HIGHLIGHT_DURATION_MS = 1500;
  const UPDATE_THROTTLE_MS = 120;
  const MO_DEBOUNCE_MS = 200;

  // ============================================================
  // 锚点发现
  // ============================================================

  function isCopyButton(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    if (tag !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;

    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const testid = el.getAttribute('data-testid') || '';
    const cls = typeof el.className === 'string' ? el.className : '';
    const text = (el.textContent || '').trim();

    if (/复制|copy/i.test(`${aria} ${title} ${testid} ${cls} ${text}`)) return true;

    // 图标按钮兜底：svg 内部含 copy 标识
    const svg = el.querySelector('svg');
    if (svg) {
      const svgClass = typeof svg.getAttribute === 'function' ? (svg.getAttribute('class') || '') : '';
      const svgAria = typeof svg.getAttribute === 'function' ? (svg.getAttribute('aria-label') || '') : '';
      const svgHTML = svg.innerHTML || '';
      if (/copy/i.test(`${svgClass} ${svgAria} ${svgHTML}`)) return true;
    }
    return false;
  }

  /**
   * 从复制按钮向上找最近的、只含一个 pre 的祖先作为代码块容器。
   * 返回 null 表示该按钮不属于代码块（例如消息级操作栏）。
   */
  function resolveContainer(btn) {
    let el = btn.parentElement;
    let depth = 0;
    let firstWithPre = null;

    while (el && el !== document.body && depth < 15) {
      if (el.tagName === 'PRE') return el;

      if (typeof el.querySelector === 'function' && el.querySelector('pre')) {
        if (!firstWithPre) firstWithPre = el;
        const count = el.querySelectorAll('pre').length;
        if (count === 1) return el;
      }
      el = el.parentElement;
      depth++;
    }
    return firstWithPre; // 含多个 pre 的兜底容器（少见）
  }

  function compareDomOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  /**
   * 实时收集锚点（按 DOM 顺序）。
   * 优先使用复制按钮；若页面完全没有复制按钮，退化为 pre 兜底。
   */
  function collectAnchors() {
    const anchors = [];
    const seen = new Set();

    const candidates = document.querySelectorAll('button, [role="button"]');
    for (const btn of candidates) {
      if (!isCopyButton(btn)) continue;
      const container = resolveContainer(btn);
      if (!container || seen.has(container)) continue;
      // 过滤不可见 / 未渲染元素
      if (container.getClientRects().length === 0) continue;
      seen.add(container);
      anchors.push({ button: btn, container });
    }

    if (anchors.length === 0) {
      for (const pre of document.querySelectorAll('pre')) {
        if (pre.getClientRects().length === 0) continue;
        anchors.push({ button: null, container: pre });
      }
    } else {
      anchors.sort((a, b) => compareDomOrder(a.container, b.container));
    }

    return anchors;
  }

  // ============================================================
  // 当前块判定
  // ============================================================

  function getCurrentIndex(anchors) {
    if (anchors.length === 0) return -1;
    const line = window.innerHeight * VIEWPORT_ANCHOR_RATIO;
    let idx = -1;
    for (let i = 0; i < anchors.length; i++) {
      const top = anchors[i].container.getBoundingClientRect().top;
      if (top <= line) idx = i;
      else break;
    }
    return idx;
  }

  // ============================================================
  // 滚动定位
  // ============================================================

  function getScrollParent(el) {
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const style = getComputedStyle(parent);
      const oy = style.overflowY;
      if (
        (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
        parent.scrollHeight > parent.clientHeight + 1
      ) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollToContainer(container) {
    const scrollParent = getScrollParent(container);
    const isWindow =
      scrollParent === document.scrollingElement ||
      scrollParent === document.documentElement ||
      scrollParent === document.body;

    const offset = window.innerHeight * VIEWPORT_ANCHOR_RATIO;
    const rect = container.getBoundingClientRect();
    const currentScrollTop = isWindow ? window.scrollY : scrollParent.scrollTop;
    const targetTop = Math.max(0, currentScrollTop + rect.top - offset);

    const scroller = isWindow ? window : scrollParent;

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { scroller.removeEventListener('scrollend', finish); } catch (e) { /* noop */ }
        resolve();
      };

      try { scroller.addEventListener('scrollend', finish, { once: true }); } catch (e) { /* 老浏览器不支持 */ }
      setTimeout(finish, SCROLL_TIMEOUT_MS);

      if (isWindow) {
        window.scrollTo({ top: targetTop, behavior: 'smooth' });
      } else {
        scrollParent.scrollTo({ top: targetTop, behavior: 'smooth' });
      }
    });
  }

  function highlight(container) {
    container.classList.remove(HIGHLIGHT_CLASS);
    // 强制重排，确保动画可以重新触发
    void container.offsetWidth;
    container.classList.add(HIGHLIGHT_CLASS);
    clearTimeout(container.__dsNavTimer);
    container.__dsNavTimer = setTimeout(() => {
      container.classList.remove(HIGHLIGHT_CLASS);
    }, HIGHLIGHT_DURATION_MS);
  }

  // ============================================================
  // 状态
  // ============================================================
  let scrollId = 0;
  let prevBtn = null;
  let nextBtn = null;
  let counterEl = null;
  let barEl = null;
  let hostEl = null;

  // ============================================================
  // 页面级样式（高亮用）
  // ============================================================
  function injectPageStyle() {
    const style = document.createElement('style');
    style.textContent = `
.${HIGHLIGHT_CLASS} {
  animation: dsCodeNavFlash 1.4s ease-out !important;
}
@keyframes dsCodeNavFlash {
  0% {
    box-shadow: inset 0 0 0 2px rgba(79, 140, 255, 0.95),
                0 0 0 0 rgba(79, 140, 255, 0.35);
  }
  50% {
    box-shadow: inset 0 0 0 2px rgba(79, 140, 255, 0.5),
                0 0 0 8px rgba(79, 140, 255, 0);
  }
  100% {
    box-shadow: inset 0 0 0 2px rgba(79, 140, 255, 0),
                0 0 0 0 rgba(79, 140, 255, 0);
  }
}`;
    document.head.appendChild(style);
  }

  // ============================================================
  // UI
  // ============================================================

  const UI_STYLE = `
:host { all: initial; }
.nav-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: rgba(28, 28, 32, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #f2f2f2;
  user-select: none;
  cursor: grab;
  transition: opacity 0.2s ease;
}
.nav-bar.dragging { cursor: grabbing; }
.nav-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #f2f2f2;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
  padding: 0;
}
.nav-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.2); }
.nav-btn:active:not(:disabled) { background: rgba(255, 255, 255, 0.28); }
.nav-btn:disabled { opacity: 0.28; cursor: not-allowed; }
.counter {
  font-size: 12px;
  min-width: 46px;
  text-align: center;
  opacity: 0.85;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
`;

  function createUI() {
    hostEl = document.createElement('div');
    hostEl.id = 'ds-code-nav-host';
    hostEl.style.cssText =
      'position: fixed; z-index: 2147483647; right: 20px; bottom: 140px;';
    document.body.appendChild(hostEl);

    const shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
<style>${UI_STYLE}</style>
<div class="nav-bar" part="bar">
  <button class="nav-btn prev" type="button" title="上一段代码" aria-label="上一段代码">↑</button>
  <span class="counter">0 / 0</span>
  <button class="nav-btn next" type="button" title="下一段代码" aria-label="下一段代码">↓</button>
</div>`;

    barEl = shadow.querySelector('.nav-bar');
    prevBtn = shadow.querySelector('.prev');
    nextBtn = shadow.querySelector('.next');
    counterEl = shadow.querySelector('.counter');

    // 阻止事件穿透到页面（避免触发 DeepSeek 的全局鼠标逻辑）
    for (const el of [barEl, prevBtn, nextBtn]) {
      el.addEventListener('mousedown', (e) => e.stopPropagation());
      el.addEventListener('mouseup', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => e.stopPropagation());
    }

    prevBtn.addEventListener('click', handlePrev);
    nextBtn.addEventListener('click', handleNext);

    setupDrag();
  }

  function setupDrag() {
    let drag = null;

    barEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.nav-btn')) return; // 按钮不参与拖拽
      e.preventDefault();
      const rect = hostEl.getBoundingClientRect();
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: rect.left,
        origTop: rect.top
      };
      barEl.classList.add('dragging');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    function onMove(e) {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      hostEl.style.left = `${drag.origLeft + dx}px`;
      hostEl.style.top = `${drag.origTop + dy}px`;
      hostEl.style.right = 'auto';
      hostEl.style.bottom = 'auto';
    }

    function onUp() {
      if (!drag) return;
      drag = null;
      barEl.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
  }

  function updateUI() {
    const anchors = collectAnchors();
    const total = anchors.length;
    const cur = total === 0 ? -1 : getCurrentIndex(anchors);

    const prevDisabled = cur <= 0;
    const nextDisabled = total === 0 || cur >= total - 1;

    prevBtn.disabled = prevDisabled;
    nextBtn.disabled = nextDisabled;

    if (total === 0) {
      counterEl.textContent = '0 / 0';
      barEl.style.opacity = '0.45';
    } else {
      counterEl.textContent = cur === -1 ? `– / ${total}` : `${cur + 1} / ${total}`;
      barEl.style.opacity = '1';
    }
  }

  // ============================================================
  // 跳转
  // ============================================================

  async function goTo(index, anchors) {
    const anchor = anchors[index];
    if (!anchor) return;

    const myId = ++scrollId;
    prevBtn.disabled = true;
    nextBtn.disabled = true;

    try {
      await scrollToContainer(anchor.container);
    } finally {
      if (myId === scrollId) {
        highlight(anchor.container);
        updateUI();
      }
    }
  }

  async function handlePrev() {
    const anchors = collectAnchors();
    const cur = getCurrentIndex(anchors);
    if (cur <= 0) return;
    await goTo(cur - 1, anchors);
  }

  async function handleNext() {
    const anchors = collectAnchors();
    const total = anchors.length;
    if (total === 0) return;
    const cur = getCurrentIndex(anchors);
    if (cur >= total - 1) return;
    await goTo(cur + 1, anchors);
  }

  // ============================================================
  // 事件监听与同步
  // ============================================================
  let lastUpdate = 0;
  let rafPending = false;

  function scheduleUpdate() {
    const now = Date.now();
    if (now - lastUpdate < UPDATE_THROTTLE_MS) return;
    lastUpdate = now;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updateUI();
    });
  }

  function bindEvents() {
    // 页面内滚动容器滚动不冒泡，用捕获阶段监听
    document.addEventListener('scroll', scheduleUpdate, { passive: true, capture: true });
    window.addEventListener('resize', scheduleUpdate, { passive: true });

    let moTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(moTimer);
      moTimer = setTimeout(updateUI, MO_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================
  // 启动
  // ============================================================
  function init() {
    injectPageStyle();
    createUI();
    bindEvents();
    updateUI();
    // 页面内容延迟渲染 / 动态加载时再刷新几次
    setTimeout(updateUI, 800);
    setTimeout(updateUI, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();