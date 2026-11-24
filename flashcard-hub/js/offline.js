/* 闪卡收藏 · 离线只读副本
 * 目录：localStorage（按账号隔离，最多 1000 行）
 * 封面：IndexedDB Blob（按账号 + 存储路径隔离）
 * 整卡：复用 cloud.js 的 fc-card-files 缓存，本模块不重复保存。
 */
(function () {
  'use strict';

  var PREFIX = 'fc-offline-index-v1:';
  var MAX_ROWS = 1000;
  var DB_NAME = 'fc-offline-assets';
  var STORE = 'thumbs';
  var objectUrls = {};
  var active = false;

  function key(uid) { return PREFIX + encodeURIComponent(uid || ''); }
  function validUid(uid) { return typeof uid === 'string' && !!uid; }

  function readRecord(uid) {
    if (!validUid(uid)) return null;
    try {
      var rec = JSON.parse(localStorage.getItem(key(uid)) || 'null');
      if (!rec || !Array.isArray(rec.rows)) return null;
      return rec;
    } catch (e) { return null; }
  }

  function all(uid) {
    var rec = readRecord(uid);
    return rec ? rec.rows : [];
  }

  function has(uid) {
    return !!readRecord(uid);
  }

  function saveRows(uid, rows, replace) {
    if (!validUid(uid) || !Array.isArray(rows)) return;
    try {
      var old = replace ? [] : all(uid);
      var byId = {};
      var merged = [];
      old.concat(rows).forEach(function (row) {
        if (!row || row.id == null) return;
        var id = String(row.id);
        if (byId[id]) {
          byId[id] = row;
        } else {
          byId[id] = row;
          merged.push(row);
        }
      });
      merged = merged.map(function (row) { return byId[String(row.id)]; });
      merged.sort(function (a, b) {
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      });
      if (merged.length > MAX_ROWS) merged.length = MAX_ROWS;
      localStorage.setItem(key(uid), JSON.stringify({ rows: merged, ts: Date.now() }));
    } catch (e) {
      console.warn('离线目录写入失败（不影响在线功能）', e && e.message);
    }
  }

  function remove(uid, id) {
    if (!validUid(uid)) return;
    var rec = readRecord(uid);
    if (!rec) return;
    rec.rows = rec.rows.filter(function (row) { return String(row.id) !== String(id); });
    rec.ts = Date.now();
    try { localStorage.setItem(key(uid), JSON.stringify(rec)); } catch (e) { /* 忽略 */ }
  }

  function getCard(uid, id) {
    var rows = all(uid);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].id) === String(id)) return rows[i];
    }
    return null;
  }

  function query(uid, filters, from, to) {
    var rec = readRecord(uid);
    if (!rec) return null;
    var f = filters || {};
    var rows = rec.rows.filter(function (row) {
      if (f.source && f.source !== 'all' && row.source !== f.source) return false;
      if (f.time && f.time !== 'all') {
        var days = parseInt(f.time, 10);
        if (days && Date.parse(row.created_at || 0) < Date.now() - days * 86400000) return false;
      }
      if (f.kw && String(row.name || '').toLowerCase().indexOf(String(f.kw).toLowerCase()) < 0) return false;
      return true;
    });
    rows.sort(function (a, b) {
      if (f.sort === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
      var cmp = String(a.created_at || '').localeCompare(String(b.created_at || ''));
      return f.sort === 'oldest' ? cmp : -cmp;
    });
    var start = Math.max(0, from || 0);
    var end = typeof to === 'number' ? to + 1 : start + 24;
    return {
      data: rows.slice(start, end),
      count: rows.length,
      totalAll: rec.rows.length,
      syncedAt: rec.ts || 0,
      fromCache: true
    };
  }

  function shouldFallback(err) {
    if (!navigator.onLine) return true;
    if (!err) return false;
    if (err.kind === 'network' || err.kind === 'backend-unavailable') return true;
    if (err.status === 0 || err.status >= 500) return true;
    var msg = String(err.message || err.error || err);
    return /network|failed to fetch|load failed|timeout|timed out|abort|offline|ERR_INTERNET/i.test(msg);
  }

  function setActive(value) {
    active = !!value;
    document.body.classList.toggle('offline-mode', active);
    try { document.dispatchEvent(new CustomEvent('fc:offline-state', { detail: { active: active } })); }
    catch (e) { /* 老 WebView 无 CustomEvent 构造器时仅保留类名 */ }
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB 不可用')); return; }
      var rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error || new Error('离线封面库打开失败')); };
    });
  }

  function idbGet(id) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var rq = tx.objectStore(STORE).get(id);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { reject(rq.error); };
        tx.oncomplete = function () { db.close(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function idbPut(rec) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
        tx.onabort = function () { db.close(); reject(tx.error); };
      });
    });
  }

  async function thumbUrl(uid, path) {
    if (!validUid(uid) || !path) return null;
    var id = uid + ':' + path;
    if (objectUrls[id]) return objectUrls[id];
    try {
      var rec = await idbGet(id);
      if (!rec || !rec.blob) return null;
      objectUrls[id] = URL.createObjectURL(rec.blob);
      return objectUrls[id];
    } catch (e) { return null; }
  }

  async function primeThumb(uid, path, url) {
    if (!validUid(uid) || !path || !url) return;
    var id = uid + ':' + path;
    try {
      var old = await idbGet(id);
      if (old && old.blob) return;
      // 真机 WebView 的裸 fetch 可能整体失败：必须走统一 fetch 通道
      // （原生环境为 CapacitorHttp），否则离线封面永远预取不进来
      var doFetch = (window.FC && typeof window.FC.fcFetch === 'function')
        ? window.FC.fcFetch : fetch;
      var resp = await doFetch(url);
      if (!resp.ok) return;
      var blob = await resp.blob();
      await idbPut({ key: id, uid: uid, path: path, blob: blob, ts: Date.now(), size: blob.size });
    } catch (e) { /* 封面离线缓存失败不影响在线展示 */ }
  }

  window.FC = window.FC || {};
  window.FC.offline = {
    all: all,
    has: has,
    saveRows: saveRows,
    remove: remove,
    getCard: getCard,
    query: query,
    shouldFallback: shouldFallback,
    setActive: setActive,
    isActive: function () { return active; },
    thumbUrl: thumbUrl,
    primeThumb: primeThumb
  };
})();
