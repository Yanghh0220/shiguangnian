/* 闪卡收藏 · 原生壳与移动网络状态
 * 无 Capacitor 时自动退化为普通网页，不改变现有页面逻辑。
 */
(function () {
  'use strict';

  window.FC = window.FC || {};
  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  var plugins = (cap && cap.Plugins) || {};

  function hideSplash() {
    if (!isNative || !plugins.SplashScreen) return;
    try {
      var p = plugins.SplashScreen.hide({ fadeOutDuration: 180 });
      if (p && p.catch) p.catch(function () { /* WebView 已可见时忽略 */ });
    } catch (e) { /* 忽略 */ }
  }

  function openExternal(url) {
    if (!url) return Promise.resolve();
    if (isNative && plugins.Browser && /^https?:\/\//i.test(url)) {
      return plugins.Browser.open({ url: url, presentationStyle: 'fullscreen' });
    }
    window.location.href = url;
    return Promise.resolve();
  }

  function syncBanner() {
    var bar = document.getElementById('network-status');
    if (!bar) return;
    var cached = !!(window.FC.offline && FC.offline.isActive());
    var offline = !navigator.onLine || cached;
    bar.classList.toggle('show', offline);
    document.body.classList.toggle('has-network-banner', offline);
    var text = bar.querySelector('.network-text');
    var btn = bar.querySelector('button');
    if (text) {
      text.textContent = cached
        ? '正在浏览本机缓存，修改与上传暂不可用。'
        : '当前无网络，登录与云端同步暂不可用。';
    }
    if (btn) btn.textContent = navigator.onLine ? '重新同步' : '重试联网';
  }

  function mountBanner() {
    if (document.getElementById('network-status')) return;
    var bar = document.createElement('div');
    bar.id = 'network-status';
    bar.className = 'network-status';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span class="network-dot" aria-hidden="true"></span>' +
      '<span class="network-text"></span><button type="button">重试联网</button>';
    bar.querySelector('button').addEventListener('click', function () {
      if (!navigator.onLine) {
        if (FC.toast) FC.toast('仍未连接网络，请检查系统网络设置', 'err');
        return;
      }
      window.location.reload();
    });
    document.body.appendChild(bar);
    syncBanner();
  }

  function closeTopLayer() {
    var ids = ['dv-close', 'viewer-close', 'confirm-cancel', 'rename-close', 'upload-close'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (!el) continue;
      var layer = el.closest('.open, .show, [role="alertdialog"]');
      if (layer && (layer.classList.contains('open') || layer.classList.contains('show') ||
          (layer.id === 'confirm-box' && layer.style.display !== 'none'))) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function bindNative() {
    if (!isNative) return;
    document.documentElement.classList.add('native-app');
    if (navigator.storage && navigator.storage.persist) {
      try { navigator.storage.persist().catch(function () { /* 用户/系统拒绝时使用默认存储策略 */ }); }
      catch (e) { /* 忽略 */ }
    }
    if (plugins.App) {
      plugins.App.addListener('backButton', function (evt) {
        if (closeTopLayer()) return;
        var page = location.pathname.split('/').pop() || 'index.html';
        if (page !== 'index.html') {
          if (evt && evt.canGoBack) history.back();
          else location.href = 'index.html';
          return;
        }
        if (evt && evt.canGoBack) history.back();
        else plugins.App.exitApp();
      });
    }
    // 最迟 12 秒解除原生启动图，避免异常时永久停留在 Splash。
    setTimeout(hideSplash, 12000);
  }

  document.addEventListener('click', function (e) {
    if (!isNative) return;
    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    try {
      if (new URL(href).origin === location.origin) return;
    } catch (err) { return; }
    e.preventDefault();
    openExternal(href).catch(function () { FC.toast('无法打开系统浏览器', 'err'); });
  });

  /* 真机诊断：连点顶部品牌 5 次弹出网络诊断浮层（一张截图即可定位问题）。
   * 只在原生环境生效，正常用户不会触发，不干扰日常使用。 */
  function bindDiagnose() {
    var taps = 0, timer = null;
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      // 登录页没有顶部 .brand，扩展诊断入口到登录卡标题 / 侧边印章，
      // 否则真机登录失败时用户根本打不开浮层，拿不到排障信息。
      var hit = e.target.closest('.brand, .login-card h1, .aside-seal, .aside-mark, .login-err-raw');
      if (!hit) return;
      taps++;
      clearTimeout(timer);
      // 真机触摸比鼠标慢，5 次/1.2s 实际打不开 → 放宽到 3 次/4s
      timer = setTimeout(function () { taps = 0; }, 4000);
      if (taps < 3) return;
      taps = 0;
      showDiagnose();
    });
  }

  function showDiagnose() {
    var box = document.getElementById('fc-diagnose');
    if (box) box.remove();
    box = document.createElement('div');
    box.id = 'fc-diagnose';
    box.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(20,18,16,.96);' +
      'color:#f4efe6;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;padding:20px;' +
      'overflow:auto;word-break:break-all;-webkit-overflow-scrolling:touch';
    box.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<b style="font-size:15px">拾光年 · 网络诊断</b>' +
      '<button id="fc-diag-close" style="background:#fff;color:#222;border:0;border-radius:6px;padding:6px 14px;font-size:13px">关闭</button></div>' +
      '<div id="fc-diag-body">正在检测…</div>';
    document.body.appendChild(box);
    box.querySelector('#fc-diag-close').onclick = function () { box.remove(); };
    var body = box.querySelector('#fc-diag-body');
    if (window.FC_NativeHttp && typeof FC_NativeHttp.diagnose === 'function') {
      FC_NativeHttp.diagnose().then(function (txt) { body.textContent = txt; });
    } else {
      body.textContent = '诊断模块未加载（native-http.js 缺失或脚本顺序错误）';
    }
  }

  window.addEventListener('online', syncBanner);
  window.addEventListener('offline', syncBanner);
  document.addEventListener('fc:offline-state', syncBanner);
  document.addEventListener('DOMContentLoaded', function () {
    mountBanner(); bindNative(); bindDiagnose();
  });

  FC.isNative = isNative;
  FC.openExternal = openExternal;
  FC.nativeReady = hideSplash;
  FC.showDiagnose = showDiagnose;   // 供登录错误红条上的按钮直接调用
})();
