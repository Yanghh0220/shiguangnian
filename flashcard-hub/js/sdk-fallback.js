/* SDK 兜底器：本地 vendor SDK 加载失败时，改从 CDN 异步加载（替代原 document.write 阻塞式写法）
 * 触发条件：window load 时 WorkBuddyCloud 仍未定义（本地 vendor 404 或被网关拦截）
 * 防循环：sessionStorage 记录本次会话已兜底过，CDN 加载成功后刷新页面走正常初始化；
 *         若刷新后仍失败则不再重试，交由 cloud.js 的错误横幅提示（避免无限刷新）
 */
(function () {
  'use strict';
  var FLAG = 'fcSdkFallbackAttempted';
  var CDN_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

  function attempted() {
    try { return sessionStorage.getItem(FLAG) === '1'; } catch (e) { return false; }
  }

  function check() {
    if (typeof window.WorkBuddyCloud !== 'undefined') return; // 本地 SDK 正常
    if (attempted()) return; // 本会话已兜底过仍失败，不再重试
    try { sessionStorage.setItem(FLAG, '1'); } catch (e) { /* 隐私模式忽略 */ }
    var s = document.createElement('script');
    s.src = CDN_URL;
    s.onload = function () { location.reload(); }; // CDN 到手后刷新，走正常启动流程
    s.onerror = function () { /* 双通道均失败，静默，交给错误横幅 */ };
    document.head.appendChild(s);
  }

  if (document.readyState === 'complete') {
    check();
  } else {
    window.addEventListener('load', check);
  }
})();
