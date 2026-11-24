/* 闪卡收藏 · Service Worker
 * 目标：解决网关无 Cache-Control 导致回访用户重复下载全部静态资源的问题（客户端等价实现）
 *
 * 拦截策略（仅同源 GET，其余直通）：
 *  1. 页面导航（mode=navigate）：网络优先，4s 未响应回退缓存（抗网关长尾），成功后异步更新缓存
 *  2. 静态资源（style/script/image/font）：缓存优先；资源 URL 均带 ?v= 指纹，发版改版本号即自然失效
 *  3. 其余同源请求（API fetch/XHR，destination='empty'）：不拦截，行为与无 SW 时完全一致
 *
 * 发版规范：改动任何被缓存资源后，必须递增下方 CACHE_VERSION（activate 时自动清旧缓存）；
 *          同时更新 HTML 中的 ?v= 版本号。
 */
var CACHE_VERSION = 'fc-static-20261118c';
var NAV_TIMEOUT_MS = 4000;
var CORE_ASSETS = [
  './', './index.html', './detail.html', './play.html',
  './css/styles.css', './css/mobile.css',
  './js/vendor/workbuddy-cloud-sdk.global.js', './js/sdk-fallback.js',
  './js/cloud.js', './js/offline.js', './js/mobile.js', './js/cover.js',
  './js/auth.js', './js/merge.js', './js/immersive.js', './js/home.js',
  './js/platefx.js', './js/detail.js', './js/play.js', './js/sw-register.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(CORE_ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k !== CACHE_VERSION ? caches.delete(k) : Promise.resolve();
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return; // 跨域（CDN/对象存储/签名链接）直通

  var isPage = req.mode === 'navigate';
  var isStatic = req.destination === 'style' || req.destination === 'script' ||
                 req.destination === 'image' || req.destination === 'font';

  if (isPage) {
    e.respondWith(networkFirstWithTimeout(req));
  } else if (isStatic) {
    e.respondWith(cacheFirst(req));
  }
  // 其余同源请求直通（不调用 respondWith）

  function cacheFirst(r) {
    return caches.match(r).then(function (hit) {
      if (hit) return hit;
      // 预缓存使用不带指纹的 URL；HTML 中 ?v= 请求可命中同一份最新外壳。
      return caches.match(r, { ignoreSearch: true }).then(function (versionless) {
        if (versionless) return versionless;
        return fetch(r).then(function (resp) {
          if (resp && resp.ok) putCache(r, resp);
          return resp;
        });
      });
    });
  }

  function networkFirstWithTimeout(r) {
    var timeout = new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error('nav-timeout')); }, NAV_TIMEOUT_MS);
    });
    var network = fetch(r).then(function (resp) {
      if (resp && resp.ok) putCache(r, resp);
      return resp;
    });
    return Promise.race([network, timeout]).catch(function () {
      return caches.match(r).then(function (hit) {
        if (hit) return hit;
        return caches.match(r, { ignoreSearch: true }).then(function (page) {
          return page || Promise.race([network]).catch(function () {
            return caches.match('./index.html');
          });
        });
      });
    });
  }

  function putCache(r, resp) {
    var copy = resp.clone();
    caches.open(CACHE_VERSION).then(function (c) { c.put(r, copy); });
  }
});
