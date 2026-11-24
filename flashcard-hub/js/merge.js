/* ============================================================
 * merge.js — 账号合并工具（待合并身份 → 主账号）
 *
 * 背景：云认证服务不支持把「微信身份」和「手机号身份」合并成同一个
 * auth 用户，而存储是 user_private（users/<uid>/），两个登录身份互相
 * 读不到对方的文件字节。所以合并在应用层做，靠浏览器跨会话搬运：
 *
 *   ① 在待合并身份（微信）下「打包」：把名下卡片逐张下载到本机 IndexedDB
 *   ② 切到主账号（手机号）后「导入」：上传到主账号自己的私有目录并写索引
 *
 * 全程不经过任何共享作用域 —— 卡片文件始终只有对应账号本人可读。
 * 搬运完成后由管理员侧删除源账号的旧索引行（见 README 里的合并记录）。
 * ============================================================ */

(function () {
  'use strict';

  var FC = window.FC;
  var DB_NAME = 'fc-merge';
  var STORE = 'pkg';

  /* ---------------- IndexedDB：本机暂存 ---------------- */

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'k' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbPromise;
  }

  async function idbPut(rec) {
    var db = await openDb();
    if (!db) throw new Error('本机浏览器无法暂存文件（隐私模式？），请换普通模式重试');
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error || new Error('写入本机暂存失败')); };
      tx.onabort = function () { reject(tx.error || new Error('写入本机暂存被中断（空间不足？）')); };
    });
  }

  async function idbGet(key) {
    var db = await openDb();
    if (!db) return null;
    return new Promise(function (resolve) {
      var tx = db.transaction(STORE, 'readonly');
      var r = tx.objectStore(STORE).get(key);
      r.onsuccess = function () { resolve(r.result || null); };
      r.onerror = function () { resolve(null); };
    });
  }

  async function idbAll() {
    var db = await openDb();
    if (!db) return [];
    return new Promise(function (resolve) {
      var tx = db.transaction(STORE, 'readonly');
      var r = tx.objectStore(STORE).getAll();
      r.onsuccess = function () { resolve(Array.isArray(r.result) ? r.result : []); };
      r.onerror = function () { resolve([]); };
    });
  }

  async function idbClear() {
    var db = await openDb();
    if (!db) return;
    return new Promise(function (resolve) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    });
  }

  /* ---------------- 存储下载（兼容 Blob / Response 两种返回） ---------------- */

  async function fetchBlob(path) {
    var res = await FC.cloud.storage.download(path);
    if (res && res.error) throw new Error(FC.errText(res.error, '文件下载失败'));
    var data = res ? res.data : null;
    if (!data) throw new Error('文件下载返回为空');
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
    if (typeof data.blob === 'function') return await data.blob();
    throw new Error('文件下载返回格式异常');
  }

  async function currentSession() {
    var ses = await FC.cloud.auth.getSession();
    if (ses.error || !ses.data) throw new Error('登录状态已失效，请重新登录');
    return ses.data;
  }

  /* ---------------- ① 打包：待合并身份名下所有卡片 → 本机 ---------------- */

  async function exportAll(onProgress) {
    if (!FC.cloudReady) throw new Error('云服务不可用，请检查网络后重试');
    var ses = await currentSession();
    var uid = ses.user.id;
    var uname = (ses.user && ses.user.name) || '';

    var list = await FC.cloud.database.from('cards').select('*').order('created_at', { ascending: true });
    if (list.error) throw new Error(FC.errText(list.error, '读取收藏列表失败'));
    var rows = list.data || [];
    if (!rows.length) return { count: 0, bytes: 0 };

    await idbClear();
    var total = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (onProgress) onProgress(i, rows.length, r.name);
      var cardBlob = await fetchBlob(r.card_path);
      var thumbBlob = null;
      if (r.thumb_path) {
        // 封面缺失不阻塞搬运：导入侧会按缺失处理
        try { thumbBlob = await fetchBlob(r.thumb_path); } catch (e) { thumbBlob = null; }
      }
      total += (r.size_bytes || 0);
      await idbPut({
        k: 'item:' + i,
        idx: i,
        name: r.name,
        rarity: r.rarity,
        source: r.source,
        size: r.size_bytes || 0,
        cardBlob: cardBlob,
        thumbBlob: thumbBlob
      });
    }

    await idbPut({
      k: 'meta',
      fromUid: uid,
      fromName: uname,
      count: rows.length,
      bytes: total,
      packedAt: new Date().toISOString()
    });

    if (onProgress) onProgress(rows.length, rows.length, '打包完成');
    return { count: rows.length, bytes: total };
  }

  /* ---------------- ② 导入：本机暂存 → 当前（主）账号 ---------------- */

  async function readPackage() {
    var meta = await idbGet('meta');
    return meta || null;
  }

  async function discardPackage() {
    await idbClear();
  }

  async function importAll(onProgress) {
    if (!FC.cloudReady) throw new Error('云服务不可用，请检查网络后重试');
    var ses = await currentSession();
    var uid = ses.user.id;
    var me = (ses.user && ses.user.name) || null;

    var meta = await idbGet('meta');
    if (!meta) return { total: 0, imported: 0, skipped: 0, failed: 0 };
    if (meta.fromUid === uid) throw new Error('当前还是待合并的那个账号，请先切换登录方式');

    var items = (await idbAll())
      .filter(function (x) { return /^item:/.test(x.k); })
      .sort(function (a, b) { return (a.idx || 0) - (b.idx || 0); });
    if (!items.length) return { total: 0, imported: 0, skipped: 0, failed: 0 };

    // 去重基准：名称 + 字节数（同一张卡不会重复入册）
    var mine = await FC.cloud.database.from('cards').select('name,size_bytes');
    var seen = {};
    ((mine && mine.data) || []).forEach(function (r) { seen[r.name + '|' + r.size_bytes] = true; });

    var imported = 0, skipped = 0, failed = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var key = it.name + '|' + it.size;
      if (seen[key]) {
        skipped++;
        if (onProgress) onProgress(i + 1, items.length, '跳过重复：' + it.name);
        continue;
      }
      if (onProgress) onProgress(i + 1, items.length, it.name);

      var cardPath = null, thumbPath = null;
      try {
        var id = FC.uuid();
        cardPath = FC.cloud.storage.userPath(uid, 'cards/' + id + '.html');
        thumbPath = it.thumbBlob ? FC.cloud.storage.userPath(uid, 'thumbs/' + id + '.jpg') : null;

        var up = await FC.cloud.storage.upload(cardPath, it.cardBlob, { contentType: 'text/html; charset=utf-8' });
        if (up.error) throw new Error(FC.errText(up.error, '上传失败'));
        if (thumbPath) {
          var upT = await FC.cloud.storage.upload(thumbPath, it.thumbBlob, { contentType: 'image/jpeg' });
          if (upT.error) throw new Error(FC.errText(upT.error, '封面上传失败'));
        }

        // owner_id 由数据库按当前登录身份自动填充，前端不传
        var ins = await FC.cloud.database.from('cards').insert({
          name: it.name,
          rarity: it.rarity || 'rare',
          source: it.source || '上传导入',
          card_path: cardPath,
          thumb_path: thumbPath,
          size_bytes: it.size,
          owner_name: me
        }).select();
        if (ins.error) throw new Error(FC.errText(ins.error, '写入索引失败'));
        if (!ins.data || !ins.data.length) throw new Error('写入被拒绝，请重新登录后再试');

        seen[key] = true;
        imported++;
      } catch (e) {
        failed++;
        if (cardPath) {
          var cleanup = [cardPath];
          if (thumbPath) cleanup.push(thumbPath);
          try { await FC.cloud.storage.remove(cleanup); } catch (e2) { /* 尽力而为 */ }
        }
        console.warn('合并导入失败', it.name, e && e.message);
      }
    }

    // 全部成功才清暂存；有失败则保留，重试时靠去重跳过已导入项
    if (failed === 0) {
      await idbClear();
      markMerged(meta.fromUid);
    }
    return { total: items.length, imported: imported, skipped: skipped, failed: failed };
  }

  /* ---------------- ③ 清理源账号：合并确认无误后回收旧索引与文件 ---------------- */

  function markMerged(uid) {
    try { localStorage.setItem('fc-merged:' + uid, String(Date.now())); } catch (e) { /* 忽略 */ }
  }

  function mergedFlag(uid) {
    try { return !!localStorage.getItem('fc-merged:' + uid); } catch (e) { return false; }
  }

  async function cleanupSource(onProgress) {
    var ses = await currentSession();
    var uid = ses.user.id;

    var list = await FC.cloud.database.from('cards').select('id,card_path,thumb_path').eq('owner_id', uid);
    if (list.error) throw new Error(FC.errText(list.error, '读取旧收藏失败'));
    var rows = list.data || [];
    if (!rows.length) return { rows: 0, files: 0 };

    // 先删索引：成功即表示这些卡片已从所有设备消失；再尽力清理存储文件
    var del = await FC.cloud.database.from('cards').delete().eq('owner_id', uid).select();
    if (del.error) throw new Error(FC.errText(del.error, '删除旧收藏失败'));

    var paths = [];
    rows.forEach(function (r) {
      if (r.card_path) paths.push(r.card_path);
      if (r.thumb_path) paths.push(r.thumb_path);
    });

    var files = 0;
    for (var i = 0; i < paths.length; i += 20) {
      var chunk = paths.slice(i, i + 20);
      try {
        var rm = await FC.cloud.storage.remove(chunk);
        if (rm && !rm.error) files += chunk.length;
      } catch (e) { /* 文件清理失败不影响索引已删除的结果 */ }
      if (onProgress) onProgress(Math.min(i + 20, paths.length), paths.length, '清理旧文件');
    }
    return { rows: rows.length, files: files };
  }

  /* ---------------- 进度条 UI ---------------- */

  function makeProgress(host) {
    var bar = document.createElement('div');
    bar.className = 'merge-progress';
    bar.innerHTML = '<i></i>';
    var txt = document.createElement('span');
    txt.className = 'merge-progress-txt';
    host.appendChild(bar);
    host.appendChild(txt);
    return {
      set: function (done, total, label) {
        var pct = total ? Math.round((done / total) * 100) : 0;
        bar.querySelector('i').style.width = pct + '%';
        txt.textContent = total ? (done + '/' + total + ' · ' + (label || '')) : (label || '');
      },
      remove: function () { bar.remove(); txt.remove(); }
    };
  }

  window.FC.merge = {
    exportAll: exportAll,
    importAll: importAll,
    cleanupSource: cleanupSource,
    mergedFlag: mergedFlag,
    readPackage: readPackage,
    discardPackage: discardPackage,
    supported: function () { return !!window.indexedDB; },
    makeProgress: makeProgress
  };
})();
