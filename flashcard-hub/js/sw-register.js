/* Service Worker 注册器：注册失败静默降级，不影响任何现有功能 */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  // 原生壳资源全部随 APK 打包在本地，无需 SW 网络缓存；且旧 SW 会在覆盖
  // 安装后用陈旧脚本覆盖新版本（上传修复装了却不生效的根因）。原生环境
  // 由 index/detail/play 头部内联脚本负责清理历史 SW，这里不再注册。
  var cap = window.Capacitor;
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () {
      /* 注册失败（如非 HTTPS、存储被禁用）→ 站点按原方式运行 */
    });
  });
})();
