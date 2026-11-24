/* 卡面「跟手镭射」交互（仅桌面精确指针 + 未开启"减弱动态"时启用）
 *
 * 原理：在 #grid 上做事件委托，pointermove 命中卡片后，
 * 由 rAF 把指针位置写入该卡片的 CSS 变量：
 *   --mx / --my  光斑位置（配合 .plate-inner::before 的径向高光）
 *   --rx / --ry  微倾斜角度（配合 .plate-face 的 rotateX/rotateY）
 * 只写 CSS 变量、不触发布局；移出卡片即清空归位。
 * 动态插入的卡片（翻页加载）无需重新绑定，委托天然覆盖。
 */
(function () {
  'use strict';

  var mqFine = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)') : null;
  var mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (!mqFine || !mqFine.matches || (mqReduce && mqReduce.matches)) return;

  var grid = document.getElementById('grid');
  if (!grid || !window.requestAnimationFrame) return;

  var MAX_TILT = 4.2;   // 最大倾角（度）：克制到「纸片被气流轻轻托起」的程度
  var plate = null;     // 当前命中的卡片
  var rect = null;      // 进入卡片时缓存的外框（不含倾斜变形，避免反馈抖动）
  var raf = 0;
  var px = 0, py = 0;

  function clearVars(p) {
    p.style.removeProperty('--rx');
    p.style.removeProperty('--ry');
    p.style.removeProperty('--mx');
    p.style.removeProperty('--my');
    p.classList.remove('is-tilt');
  }

  function leave() {
    if (raf) { window.cancelAnimationFrame(raf); raf = 0; }
    if (plate) { clearVars(plate); plate = null; rect = null; }
  }

  function frame() {
    raf = 0;
    if (!plate || !rect) return;
    var nx = (px - rect.left) / rect.width;
    var ny = (py - rect.top) / rect.height;
    if (nx < 0) nx = 0; else if (nx > 1) nx = 1;
    if (ny < 0) ny = 0; else if (ny > 1) ny = 1;
    plate.style.setProperty('--rx', ((ny - .5) * -2 * MAX_TILT).toFixed(2) + 'deg');
    plate.style.setProperty('--ry', ((nx - .5) * 2 * MAX_TILT).toFixed(2) + 'deg');
    plate.style.setProperty('--mx', (nx * 100).toFixed(1) + '%');
    plate.style.setProperty('--my', (ny * 100).toFixed(1) + '%');
  }

  // 从事件目标向上找卡片；骨架屏不参与倾斜
  function closestPlate(el) {
    while (el && el !== grid) {
      if (el.nodeType === 1 && el.classList &&
          el.classList.contains('plate') && !el.classList.contains('skeleton')) return el;
      el = el.parentNode;
    }
    return null;
  }

  grid.addEventListener('pointermove', function (e) {
    var p = closestPlate(e.target);
    if (p !== plate) {
      leave();
      if (p) {
        plate = p;
        rect = p.getBoundingClientRect();
        p.classList.add('is-tilt');
      }
    }
    if (plate) {
      px = e.clientX; py = e.clientY;
      if (!raf) raf = window.requestAnimationFrame(frame);
    }
  }, { passive: true });

  grid.addEventListener('pointerleave', leave);
  window.addEventListener('blur', leave);
  // 滚动会让缓存的外框失准：先归位，指针再动时重新进入
  window.addEventListener('scroll', function () { if (plate) leave(); }, { passive: true });
})();
