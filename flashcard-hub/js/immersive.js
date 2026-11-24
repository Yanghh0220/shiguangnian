/* ============================================================
 * immersive.js — 首页「沉浸浏览」模式
 *
 * 随机序列：把当前筛选命中的卡片用 Fisher–Yates 洗成「一轮」，
 *   一轮内每张卡恰好出现一次；走到尽头自动重新洗牌，
 *   且新一轮的首 / 尾不与当前卡重复（避免连续出现同一张）。
 *   往回滑沿同一轮逆序回溯，不额外抽卡，因此同样不会重复。
 *   数据层另由 home.js 分页拉取时按 id 去重，双重保证不重不漏。
 *
 * 交互：触摸上下滑跟手 + 阈值 / 速度吸附；桌面滚轮、方向键、按钮同样可切换。
 * 动画：整条轨道只做 2D translateY，绝不引入 3D / blend / filter
 *      （X5 等老内核在 3D 合成上下文里会整卡不渲染）。
 * ============================================================ */

(function () {
  'use strict';

  var FC = window.FC || (window.FC = {});
  var opts = null;
  var active = false;
  var rows = [];        // 当前筛选命中的全部卡片（已按 id 去重）
  var rounds = [];      // 已生成的轮次，往回滑可精确回溯到上一轮
  var rIdx = 0;         // 当前轮在 rounds 中的位置
  var deck = [];        // 当前一轮的随机顺序（恒等于 rounds[rIdx]）
  var pos = 0;          // 当前卡在一轮中的位置
  var nav = { prev: null, next: null };
  var animating = false;
  var dragging = false;
  var suppressClick = false;
  var loadSeq = 0;
  var wheelLock = 0;
  var settleTimer = 0;
  var el = {};
  var drag = { x: 0, y: 0, dy: 0, t: 0, axis: '' };

  function $(id) { return document.getElementById(id); }
  function pad2(n) { var s = String(n); return s.length < 2 ? '0' + s : s; }
  function idOf(c) { return c ? c.id : null; }
  function current() { return deck[pos] || null; }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 按 id 去重：分页拉取时即便排序键相同导致页间重叠，也绝不让一张卡进两次
  function dedupe(list) {
    var seen = {}, out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var c = list[i];
      if (!c || c.id == null || seen[c.id]) continue;
      seen[c.id] = 1;
      out.push(c);
    }
    return out;
  }

  function swap(a, i, j) { var t = a[i]; a[i] = a[j]; a[j] = t; }

  /* 生成新一轮。avoidHead / avoidTail 用于换轮边界去重：
   * 向下翻到尽头时，新一轮第一张不能等于当前卡；
   * 向上翻到开头时，新一轮最后一张不能等于当前卡。 */
  function buildRound(avoidHead, avoidTail) {
    var arr = shuffle(rows.slice());
    if (arr.length < 2) return arr;
    for (var n = 0; n < 12; n++) {
      var badH = avoidHead != null && arr[0].id === avoidHead;
      var badT = avoidTail != null && arr[arr.length - 1].id === avoidTail;
      if (!badH && !badT) return arr;
      if (badH) swap(arr, 0, 1 + Math.floor(Math.random() * (arr.length - 1)));
      if (badT) swap(arr, arr.length - 1, Math.floor(Math.random() * (arr.length - 1)));
    }
    return arr;
  }

  /* 返回「若往 dir 方向切一张」的完整计划（纯函数，不改动轮次历史）。
   * 预渲染与真正落下共用同一个计划，避免手指跟随时看到 A、落下后变成 B。
   * 已走过的轮次保存在 rounds 里：向下翻到尽头优先复用「下一轮」历史，
   * 向上翻到开头优先回到上一轮末尾，只有走出历史才生成新的随机轮。 */
  function planFor(dir) {
    var cur = idOf(current());
    if (dir > 0) {
      if (pos + 1 < deck.length) return { card: deck[pos + 1], pos: pos + 1, rIdx: rIdx };
      var nd = (rIdx + 1 < rounds.length) ? rounds[rIdx + 1] : buildRound(cur, null);
      return { card: nd[0], pos: 0, rIdx: rIdx + 1, newRound: nd, insert: 'push' };
    }
    if (pos > 0) return { card: deck[pos - 1], pos: pos - 1, rIdx: rIdx };
    if (rIdx > 0) {
      var pd = rounds[rIdx - 1];
      return { card: pd[pd.length - 1], pos: pd.length - 1, rIdx: rIdx - 1 };
    }
    // 历史已经到头：新建一轮插在最前面，其末尾不能与当前卡重复
    var fresh = buildRound(null, cur);
    return { card: fresh[fresh.length - 1], pos: fresh.length - 1, rIdx: 0, newRound: fresh, insert: 'unshift' };
  }

  function computeNav() {
    if (deck.length < 2) return { prev: null, next: null };
    return { prev: planFor(-1), next: planFor(1) };
  }

  function applyPlan(plan) {
    if (plan.newRound) {
      if (plan.insert === 'push') rounds.push(plan.newRound);
      else rounds.unshift(plan.newRound);
    }
    rIdx = plan.rIdx;
    pos = plan.pos;
    // 历史只留最近 20 轮，避免长时间浏览无限堆积；从远离当前轮的一端裁剪
    while (rounds.length > 20) {
      if (rIdx > 0) { rounds.shift(); rIdx--; }
      else rounds.pop();
    }
    deck = rounds[rIdx];
  }

  // keepCurrent=true：刷新卡组后仍把当前卡放在新一轮首位，避免界面突然跳卡
  function setRows(list, keepCurrent) {
    var keep = keepCurrent ? current() : null;
    rows = dedupe(list);
    var head = null;
    if (keep) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === keep.id) { head = rows[i]; break; }
      }
    }
    if (head) {
      var rest = [];
      for (var k = 0; k < rows.length; k++) if (rows[k].id !== head.id) rest.push(rows[k]);
      deck = [head].concat(shuffle(rest));
    } else {
      deck = shuffle(rows.slice());
    }
    pos = 0;
    rounds = [deck];
    rIdx = 0;
    nav = computeNav();
  }

  /* ---------------- 渲染 ---------------- */

  function slideHtml(posn, card) {
    return '<div class="im-slide" data-pos="' + posn + '"' +
           (posn === 0 ? '' : ' aria-hidden="true"') + '>' +
           opts.cardHtml(card, 0) + '</div>';
  }

  function paint() {
    if (!active || !opts || !opts.cardHtml) return;
    var html = '';
    if (nav.prev) html += slideHtml(-1, nav.prev.card);
    if (current()) html += slideHtml(0, current());
    if (nav.next) html += slideHtml(1, nav.next.card);
    el.track.innerHTML = html;

    // 与图录模式共用同一套卡片渲染：封面加载与三级回退逻辑完全复用
    var plates = el.track.querySelectorAll('.plate');
    for (var i = 0; i < plates.length; i++) {
      if (opts.bindThumb) opts.bindThumb(plates[i]);
    }
    // 相邻卡只是过渡用的视觉层，不该被键盘 Tab 或读屏器当成当前卡
    var hidden = el.track.querySelectorAll('.im-slide:not([data-pos="0"]) a, .im-slide:not([data-pos="0"]) button');
    for (var h = 0; h < hidden.length; h++) hidden[h].setAttribute('tabindex', '-1');

    updateHud();
  }

  function updateHud() {
    var n = deck.length;
    el.index.textContent = pad2(n ? pos + 1 : 0);
    el.total.textContent = pad2(n);
    el.prev.disabled = n < 2;
    el.next.disabled = n < 2;
    el.shuffle.disabled = n < 2;
    el.hint.textContent = n < 2
      ? (n === 1 ? '册子里只有这一张 · 切回图录继续收藏' : '换个筛选条件，或回到图录导入闪卡')
      : '上滑 / 下滑 切换闪卡 · 顺序随机，不重复';
  }

  function sizeStage() {
    var h = el.stage.clientHeight, w = el.stage.clientWidth;
    if (!h || !w) return;
    // 卡面 3:4，下面还有一行图注：让「卡宽 * 4/3 + 30」不超过舞台高度
    var cw = Math.min(w * 0.84, (h - 40) * 0.75, 380);
    cw = Math.max(120, Math.round(cw));
    el.stage.style.setProperty('--im-card-w', cw + 'px');
  }

  function showState(title, desc, btnText, handler) {
    el.track.innerHTML = '';
    resetTrack();
    el.stateTitle.textContent = title;
    el.stateDesc.textContent = desc;
    el.stateBtn.textContent = btnText;
    el.stateBtn.onclick = handler;
    el.state.classList.add('show');
    el.index.textContent = '00';
    el.total.textContent = '00';
    el.prev.disabled = true;
    el.next.disabled = true;
    el.shuffle.disabled = true;
  }

  function hideState() { el.state.classList.remove('show'); }

  function render() {
    hideState();
    if (!rows.length) {
      var copy = opts.emptyCopy ? opts.emptyCopy() : null;
      showState(
        (copy && copy.title) || '册子还是空的',
        (copy && copy.desc) || '把生成好的全息闪卡 HTML 文件登记进来，就能开始随序翻阅。',
        (copy && copy.btn) || '切回图录',
        function () { if (opts.switchToGrid) opts.switchToGrid(); }
      );
      return;
    }
    resetTrack();
    sizeStage();
    paint();
  }

  /* ---------------- 切换动画（纯 2D） ---------------- */

  function resetTrack() {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    el.track.style.transition = 'none';
    el.track.style.transform = 'translateY(0)';
    void el.track.offsetHeight;      // 强制落定，下一次过渡才从 0 起算
    el.track.style.transition = '';
  }

  function snapBack() {
    el.track.style.transition = 'none';
    void el.track.offsetHeight;                 // 落定跟手位移
    el.track.style.transition = '';
    void el.track.offsetHeight;                 // 落定「已启用过渡」这一状态
    el.track.style.transform = 'translateY(0)';
  }

  function settle(dir, plan) {
    animating = true;
    // 先把跟手位移落定，再启用过渡，保证动画从手指离开的位置开始
    el.track.style.transition = 'none';
    void el.track.offsetHeight;
    el.track.style.transition = '';
    void el.track.offsetHeight;
    el.track.style.transform = dir > 0 ? 'translateY(-100%)' : 'translateY(100%)';

    var done = false;
    function onEnd(e) { if (e && e.target !== el.track) return; finish(); }
    function finish() {
      if (done) return;
      done = true;
      el.track.removeEventListener('transitionend', onEnd);
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
      applyPlan(plan);
      animating = false;
      resetTrack();
      nav = computeNav();
      paint();
    }
    el.track.addEventListener('transitionend', onEnd);
    // 老内核 / 减弱动态下 transitionend 可能不触发，用定时器兜底
    settleTimer = setTimeout(finish, 430);
  }

  function go(dir) {
    if (!active || animating || dragging || deck.length < 2) return;
    var plan = dir > 0 ? nav.next : nav.prev;
    if (!plan || !plan.card) return;
    settle(dir, plan);
  }

  /* ---------------- 手势 ---------------- */

  function dragStart(x, y) {
    if (!active || animating || deck.length < 2) return false;
    dragging = true;
    drag.x = x; drag.y = y; drag.dy = 0; drag.t = Date.now(); drag.axis = '';
    suppressClick = false;
    el.track.style.transition = 'none';
    return true;
  }

  function dragMove(x, y, ev) {
    if (!dragging) return false;
    var dx = x - drag.x, dy = y - drag.y;
    if (!drag.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return true;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (drag.axis === 'x') return false;      // 横向手势交还页面
    if (ev && ev.cancelable) ev.preventDefault();
    drag.dy = dy;
    if (Math.abs(dy) > 6) suppressClick = true;
    el.track.style.transform = 'translateY(' + (dy * 0.9) + 'px)';
    return true;
  }

  function dragEnd() {
    if (!dragging) return;
    dragging = false;
    var dy = drag.dy, dt = Math.max(1, Date.now() - drag.t);
    var h = el.stage.clientHeight || 400;
    var threshold = Math.min(72, h * 0.16);
    var fast = Math.abs(dy) / dt > 0.45 && Math.abs(dy) > 24;
    if (drag.axis === 'y' && (Math.abs(dy) > threshold || fast)) {
      go(dy < 0 ? 1 : -1);
    } else {
      snapBack();
    }
    // click 在 touchend 之后才到，留一小段窗口拦截拖动造成的误跳转
    setTimeout(function () { suppressClick = false; }, 420);
  }

  function bindEvents() {
    // 触摸：touchmove 必须非 passive 才能 preventDefault，避免页面跟着滚
    el.stage.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      dragStart(t.clientX, t.clientY);
    }, { passive: true });
    el.stage.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1 || !dragging) return;
      var t = e.touches[0];
      dragMove(t.clientX, t.clientY, e);
    }, { passive: false });
    el.stage.addEventListener('touchend', dragEnd, { passive: true });
    el.stage.addEventListener('touchcancel', dragEnd, { passive: true });

    // 桌面鼠标拖动
    el.stage.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (dragStart(e.clientX, e.clientY)) e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) { dragMove(e.clientX, e.clientY, e); });
    document.addEventListener('mouseup', dragEnd);

    // 拖动过就不让卡片链接误跳转（捕获阶段拦截）
    el.stage.addEventListener('click', function (e) {
      if (!suppressClick) return;
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
    }, true);

    // 滚轮：一次手势只切一张，锁 520ms 防止触控板连续惯性触发
    el.stage.addEventListener('wheel', function (e) {
      if (!active || animating || deck.length < 2 || e.ctrlKey) return;
      var d = e.deltaY;
      if (!d) return;
      if (e.cancelable) e.preventDefault();
      var now = Date.now();
      if (now < wheelLock || Math.abs(d) < 8) return;
      wheelLock = now + 520;
      go(d > 0 ? 1 : -1);
    }, { passive: false });

    document.addEventListener('keydown', function (e) {
      if (!active || animating) return;
      var t = e.target || {};
      var tag = String(t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || t.isContentEditable) return;
      if (document.querySelector('.modal-overlay.open')) return;
      if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    });

    el.prev.addEventListener('click', function () { go(-1); });
    el.next.addEventListener('click', function () { go(1); });
    el.shuffle.addEventListener('click', function () {
      if (!active || rows.length < 2 || animating) return;
      setRows(rows, true);       // 保留当前卡，其余重新洗牌
      resetTrack();
      paint();
      if (FC.toast) FC.toast('已重新洗牌', 'ok');
    });

    window.addEventListener('resize', function () { if (active) sizeStage(); });
    if (window.ResizeObserver) {
      try { new ResizeObserver(function () { if (active) sizeStage(); }).observe(el.stage); }
      catch (e) { /* 老内核无 ResizeObserver，resize 兜底已足够 */ }
    }
  }

  /* ---------------- 生命周期 ---------------- */

  async function load(showLoading) {
    var seq = ++loadSeq;
    if (showLoading) {
      showState('正在清点…', '正在整理这一册的闪卡顺序。', '重试', function () { load(true); });
    }
    try {
      var list = await opts.loadRows();
      if (seq !== loadSeq || !active) return;      // 过期请求不覆盖新状态
      setRows(list, true);
      render();
    } catch (e) {
      if (seq !== loadSeq || !active) return;
      var msg = FC.errText ? FC.errText(e, '加载闪卡失败') : '加载闪卡失败';
      showState('没能取到目录', msg, '重试', function () { load(true); });
    }
  }

  async function enter() {
    if (active) { await load(false); return; }
    active = true;
    sizeStage();
    await load(true);
  }

  function leave() {
    active = false;
    loadSeq++;
    animating = false;
    dragging = false;
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    el.track.innerHTML = '';
    resetTrack();
    hideState();
  }

  async function reload() { if (active) await load(false); }

  function init(o) {
    if (opts) return;
    opts = o || {};
    el = {
      stage: $('im-stage'), track: $('im-track'), state: $('im-state'),
      stateTitle: $('im-state-title'), stateDesc: $('im-state-desc'), stateBtn: $('im-state-btn'),
      index: $('im-index'), total: $('im-total'), hint: $('im-hint'),
      prev: $('im-prev'), next: $('im-next'), shuffle: $('im-shuffle')
    };
    if (!el.stage || !el.track) return;
    bindEvents();
    updateHud();
  }

  FC.immersive = {
    init: init,
    enter: enter,
    leave: leave,
    reload: reload,
    isActive: function () { return active; },
    // 自动化验证用的只读状态 / 驱动入口，不参与正常交互
    _test: {
      state: function () {
        return {
          rows: rows.map(idOf), deck: deck.map(idOf), pos: pos, active: active,
          rIdx: rIdx, roundCount: rounds.length,
          prev: nav.prev && nav.prev.card.id, next: nav.next && nav.next.card.id
        };
      },
      go: go,
      setRows: setRows,
      render: render
    }
  };
})();
