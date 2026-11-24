/* ============================================================
 * detail.js — 卡片详情页
 * 职责：登录门卫、按 id 读取索引行、签名链接懒加载整卡（iframe +
 *       加载态）、元信息展示、下载原文件、删除（先删索引再清理文件）
 * 大文件只在进入本页那一刻加载，列表页永不触碰
 * ============================================================ */

(function () {
  'use strict';

  var FC = window.FC;
  var card = null;      // 当前卡片索引行
  var cardUrl = null;   // 整卡签名链接
  var session = null;
  var offlineMode = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return FC.escapeHtml(s); }
  // 提取可展示的错误原因；无信息的对象返回空串，交由兜底文案处理
  function why(e) {
    if (!e) return '';
    if (typeof e === 'string') return e;
    if (e.message) return e.message;
    if (e.error && e.error.message) return e.error.message;
    return '';
  }
  // 仅「fetch 在收到响应前中断」这类瞬时故障值得重试；HTTP 4xx/5xx 重试无意义
  function isNet(e) {
    var m = why(e) || '';
    return /NetworkError|Failed to fetch|fetch resource|Load failed|network error|request failed before a response/i.test(m) ||
           !!(e && e.status === 0);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  async function start() {
    var id = qs('id');
    if (!id || !/^\d+$/.test(id)) return showNotFound('链接无效', '缺少卡片编号，请从收藏列表进入。');

    if (!FC.cloudReady) return showNotFound('云服务不可用', FC.cloudError || '请检查网络后刷新页面。');

    // 登录门卫：本机有登录记录就先恢复（含重试与镜像回填），
    // 不因为一次网络抖动就把人踢回首页重新登录
    var ses = await FC.session.ensure(2);
    if (!ses.session) {
      if (ses.transient && FC.session.has()) {
        var cachedSession = FC.session.read();
        var uid = cachedSession && cachedSession.user && cachedSession.user.id;
        var cachedCard = uid && FC.offline ? FC.offline.getCard(uid, id) : null;
        if (cachedCard) {
          session = cachedSession;
          card = cachedCard;
          offlineMode = true;
          FC.offline.setActive(true);
          renderMeta();
          await loadStage();
          return;
        }
        showRetry('网络不太稳定', '登录状态暂时没能恢复，本机记录已保留，请检查网络后重试。');
        return;
      }
      location.replace('index.html');
      return;
    }
    session = ses.session;

    // 副身份（已绑定到主账号）不提供独立收藏的详情页：回首页走绑定引导
    var binding = await FC.binding.resolve(ses.session);
    if (binding.bound) {
      location.replace('index.html');
      return;
    }

    try {
      var res = await FC.cloud.database.from('cards').select('*').eq('id', parseInt(id, 10)).maybeSingle();
      if (res.error) throw new Error(res.error.message);
      if (!res.data) return showNotFound('卡片不存在', '它可能已被删除，或链接已失效。');
      card = res.data;
      renderMeta();
      await loadStage();
    } catch (e) {
      var uid = session && session.user && session.user.id;
      var cachedCard = uid && FC.offline && FC.offline.shouldFallback(e)
        ? FC.offline.getCard(uid, id) : null;
      if (cachedCard) {
        card = cachedCard;
        offlineMode = true;
        FC.offline.setActive(true);
        renderMeta();
        await loadStage();
        return;
      }
      showNotFound('加载失败', FC.errText(e, '读取卡片信息失败，请稍后重试。'));
    }
  }

  /* ---------------- 元信息与操作区 ---------------- */

  function renderMeta() {
    document.title = (card.name || '闪卡') + ' · 拾光年';
    var titleEl = $('d-title');
    if (titleEl) titleEl.textContent = card.name || '未命名闪卡';
    var noEl = $('dl-no');
    if (noEl) {
      var s = String(card.id == null ? '' : card.id);
      while (s.length < 4) s = '0' + s;
      noEl.textContent = 'NO.' + s;
    }
    var coverBtn = $('btn-cover');
    if (coverBtn) coverBtn.textContent = card.thumb_path ? '换封面' : '设封面';
    var metaEl = $('d-meta');
    if (metaEl) {
      metaEl.innerHTML =
        '<div class="dm"><span>获取方式</span><b>' + esc(card.source || '上传导入') + '</b></div>' +
        '<div class="dm"><span>收藏时间</span><b>' + FC.formatDate(card.created_at) + '</b></div>' +
        '<div class="dm"><span>文件大小</span><b>' + FC.formatBytes(card.size_bytes) + '</b></div>' +
        '<div class="dm"><span>封面</span><b id="d-cover-txt">' + (card.thumb_path ? '自定义' : '自动') + '</b></div>' +
        '<div class="dm"><span>收藏人</span><b>' + esc(card.owner_name || '我') + '</b></div>';
    }
  }

  /* ---------------- 整卡加载：三通道渲染 ----------------
   * 通道0 srcdoc：卡片 HTML 文本直接注入 iframe，兼容性最强（部分国产浏览器
   *            如夸克对沙箱 iframe 的 blob: URL 支持有缺陷会导致白屏）
   * 通道1 blob ：blob: URL 加载，Content-Type 可控
   * 通道2 签名链接：直载，若云端按 text/plain 返回会显示源码（最后兜底）
   * 跨源 iframe 无法自动检测白屏，故提供手动「切换加载模式」按钮。 */

  var MODES = ['标准模式', '兼容模式', '直连模式'];
  var mode = 0;             // 当前渲染通道
  var cardBlob = null;      // 下载缓存（text/html Blob）
  var cardText = null;      // srcdoc 缓存（已含移动端适配样式）
  var blobUrl = null;       // blob: URL 缓存
  var stageTpl = null;      // 加载态原始结构（原地重试时恢复）
  var stageFailed = false;  // 进入错误态后，不再让 load 事件/兜底定时器把错误页隐藏
  var frameBound = false;

  /* ---------------- 卡片页移动端全屏适配（样式覆盖层）----------------
   * 上传的整卡 HTML 版式各异：多数桌面舞台固定高度（如 .display{height:500px}），
   * 在手机 iframe 里要么下方控件溢出需滚动、要么卡面留白过多。这里在可改写
   * 通道（srcdoc / blob）把一段仅窄屏命中的覆盖样式注入到 <head>，令展台铺满
   * 可用视口、卡面由 WebGL contain 等比适配（旋转余量由卡自带 fit=.985 保证）。
   * 只调布局尺寸与留白，不改卡面纹理、不增删控件、不动交互脚本。
   * 注：跨源 iframe（直连模式）无法安全访问 contentDocument，故仅在 srcdoc/
   * blob 通道注入；三通道语义与白屏自救保持不变。 */
  var FIT_MARK = 'FC_CARD_FIT_20261118c';
  var FIT_CSS = '/*' + FIT_MARK + '*/' +
    '@media (max-width:640px){' +
    'html,body{height:100%;min-height:0;overflow:hidden}' +
    'body{padding:0 14px 8px;display:flex;flex-direction:column;gap:0}' +
    '.topbar{height:46px;min-height:46px;flex:none}' +
    'main{flex:1 1 auto;min-height:0;width:100%;display:flex;flex-direction:column;align-items:stretch;padding:4px 0 0;margin:0;gap:0}' +
    '.identity{flex:none;padding:8px 0 0}' +
    'h1{font-size:clamp(28px,8vw,44px);line-height:.95}' +
    '.kicker{margin-bottom:8px}' +
    '.actions{margin-top:12px;gap:2px}' +
    '.actions button{padding:8px 10px;min-height:40px}' +
    '.display{flex:1 1 auto;height:auto!important;min-height:200px;max-height:none;width:100%;border-radius:16px}' +
    '#stage{border-radius:inherit;overflow:hidden}' +
    '#stage canvas{width:100%;height:100%}' +
    '.view-label{top:8px;right:8px}' +
    '.controls{flex:none;width:100%;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px;margin:8px 0 0;padding:0 0 4px}' +
    '.controls label>span{font-size:9px}' +
    'input[type=range]{height:16px;margin-top:4px}' +
    '}';

  // 更新加载提示文案（FC.loadCardBlob 的进度回调入口）
  function setHint(msg) {
    var hint = document.querySelector('#stage-loading .hint');
    if (hint) hint.textContent = msg;
  }

  /* Blob → 文本；优先 Blob.text()，老浏览器用 FileReader 兜底 */
  function blobToText(blob) {
    return new Promise(function (resolve, reject) {
      if (typeof blob.text === 'function') {
        blob.text().then(resolve, reject);
        return;
      }
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsText(blob);
    });
  }

  /* 把适配样式注入整卡 HTML 的 <head>；已有标记则不重复注入（幂等） */
  function wrapCardHtml(text) {
    if (!text || text.indexOf(FIT_MARK) >= 0) return text;
    var tag = /<head[^>]*>/i;
    if (tag.test(text)) return text.replace(tag, function (m) { return m + '\n<style>' + FIT_CSS + '</style>'; });
    // 无 head 的极简卡：包一层最小文档骨架，保留原始内容
    return '<!doctype html><html><head><meta charset="utf-8"><style>' + FIT_CSS + '</style></head><body>' + text + '</body></html>';
  }

  // 下载原文 → 转文本 → 注入适配样式；srcdoc 与 blob 通道共用同一份结果
  var rawPromise = null;
  async function loadFittedText() {
    if (cardText) return cardText;
    if (!rawPromise) {
      rawPromise = (async function () {
        // FC.loadCardBlob：IndexedDB 缓存优先（命中零网络）+ storage.download /
        // 签名 URL 双通道指数退避下载，成功后自动写缓存供下次秒开
        var raw = await FC.loadCardBlob(card, setHint);
        return wrapCardHtml(await blobToText(raw));
      })();
    }
    try {
      cardText = await rawPromise;
      return cardText;
    } catch (e) {
      rawPromise = null;   // 失败不留残值，保证重试通道/原地重试能重新下载
      throw e;
    }
  }

  async function ensureText() {
    return await loadFittedText();
  }

  async function ensureBlob() {
    if (cardBlob) return cardBlob;
    cardBlob = new Blob([await loadFittedText()], { type: 'text/html; charset=utf-8' });
    return cardBlob;
  }

  function clearFrame(frame) {
    try { frame.removeAttribute('srcdoc'); } catch (e) { /* ignore */ }
    frame.src = 'about:blank';
  }

  async function renderMode(m) {
    var frame = $('stage-frame');
    var loading = $('stage-loading');
    loading.style.display = '';
    clearFrame(frame);
    if (m === 0) {
      frame.srcdoc = await ensureText();
    } else if (m === 1) {
      if (!blobUrl) blobUrl = URL.createObjectURL(await ensureBlob());
      frame.src = blobUrl;
    } else {
      cardUrl = cardUrl || await FC.signedUrl(card.card_path, 3600);
      frame.src = cardUrl;
    }
    mode = m;
    var label = $('stage-mode-label');
    if (label) label.textContent = MODES[m];
  }

  // 可重试判定：网络层抖动，或登录态失效（401 类，刷新会话后重试才有意义）
  function isAuth(e) {
    var m = why(e);
    return /401|403|unauthorized|invalid_client|credentials|jwt|token/i.test(m);
  }

  async function loadStage() {
    var loading = $('stage-loading');
    var frame = $('stage-frame');

    if (stageTpl === null) stageTpl = loading ? loading.innerHTML : '';
    if (loading) {
      loading.innerHTML = stageTpl;   // 恢复原始加载态（可能上次重试已被错误页替换）
      loading.style.display = '';
      setHint('正在加载全息卡片' + (card.size_bytes ? '（约 ' + FC.formatBytes(card.size_bytes) + '）' : '') + '，首次打开可能需要几秒钟…');
    }

    if (!frame) throw new Error('详情页缺少预览容器');
    if (!frameBound) {
      frameBound = true;
      frame.addEventListener('load', function () {
        if (!stageFailed) { var l = $('stage-loading'); if (l) l.style.display = 'none'; }
      });
    }
    stageFailed = false;
    // 兜底：极端情况下 load 事件被吞时也不让加载态永远停留
    setTimeout(function () { if (!stageFailed && loading) loading.style.display = 'none'; }, 30000);

    var ok = false;
    try { ok = await tryChannels(); } catch (e) { /* 已在下方统一处理 */ }
    if (ok) return;

    // 全部通道失败：显示错误与原地重试按钮，并透出各通道的真实原因
    stageFailed = true;
    var reasons = lastReasons;
    if (loading) {
      var reason = reasons.length
        ? reasons.slice(0, 3).map(function (s) { return s.length > 110 ? s.slice(0, 110) + '…' : s; }).join('　·　')
        : '';
      loading.style.display = '';
      loading.innerHTML = '<p style="font-size:14px;color:var(--danger)">卡片文件暂时无法访问，请稍后重试。</p>' +
        (reason ? '<p style="font-size:11px;line-height:1.7;color:var(--ink-3);max-width:min(88%,520px);word-break:break-word">' + esc(reason) + '</p>' : '') +
        '<button class="btn btn-ghost" id="stage-retry" type="button">刷新重试</button>';
      var btn = document.getElementById('stage-retry');
      if (btn) btn.addEventListener('click', function () { loadStage(); });   // 原地重跑，不整页 reload
    }
  }

  // 三通道降级链 + 整轮重试；成功 resolve(true)，失败把原因留在 lastReasons
  var lastReasons = [];

  async function tryChannels() {
    lastReasons = [];
    var netFail = false, authFail = false;
    for (var round = 0; round < 2; round++) {
      lastReasons.length = 0;
      netFail = false; authFail = false;
      var skipBlob = false;
      for (var m = 0; m < 3; m++) {
        // 通道 0 的下载请求已断，通道 1 复用同一个 ensureBlob，必然同样失败，不再重复发大文件请求
        if (m === 1 && skipBlob) continue;
        try {
          await renderMode(m);
          return true;
        } catch (e) {
          var msg = why(e);
          if (msg && lastReasons.indexOf(msg) < 0) lastReasons.push(msg);
          if (isNet(e)) {
            netFail = true;
            if (m === 0 && !cardBlob) skipBlob = true;
          }
          if (isAuth(e)) authFail = true;
          console.warn('加载通道 ' + MODES[m] + ' 失败', msg);
        }
      }
      if (round === 0 && (netFail || authFail)) {
        await sleep(600);
        try { await FC.session.ensure(1); } catch (e) { /* 会话刷新失败不阻断重试 */ }
      } else break;
    }
    return false;
  }

  /* 手动切换通道（白屏自救） */
  async function switchMode() {
    var next = (mode + 1) % 3;
    try {
      await renderMode(next);
      FC.toast('已切换为' + MODES[next], 'ok');
    } catch (e) {
      FC.toast('切换失败：' + FC.errText(e, '请稍后重试'), 'err');
      var loading = $('stage-loading');
      if (loading) loading.style.display = '';
    }
  }

  /* 新窗口打开（绕过 iframe 限制） */
  async function openNewWin() {
    if (FC.isNative) {
      try {
        var nativeUrl = cardUrl || await FC.signedUrl(card.card_path, 600);
        cardUrl = nativeUrl;
        await FC.openExternal(nativeUrl);
      } catch (e) {
        FC.toast(offlineMode ? '本机缓存请在 APP 内预览，联网后可系统浏览器打开' : '打开失败：' + FC.errText(e, '请稍后重试'), 'err');
      }
      return;
    }
    try {
      var b = await ensureBlob();
      var u = blobUrl || URL.createObjectURL(b);
      blobUrl = u;
      window.open(u, '_blank', 'noopener');
    } catch (e) {
      try {
        var s = cardUrl || await FC.signedUrl(card.card_path, 600);
        window.open(s, '_blank', 'noopener');
      } catch (e2) {
        FC.toast('打开失败：' + FC.errText(e2, '请稍后重试'), 'err');
      }
    }
  }

  /* ---------------- 重命名 ---------------- */

  function openRename() {
    if (offlineMode) { FC.toast('离线模式不能重命名，请联网后重试', 'err'); return; }
    if (!card) return;
    $('rename-input').value = card.name || '';
    $('rename-save').disabled = false;
    $('rename-overlay').classList.add('open');
    setTimeout(function () {
      $('rename-input').focus();
      $('rename-input').select();
    }, 60);
  }

  function closeRename() {
    $('rename-overlay').classList.remove('open');
  }

  async function saveRename() {
    if (!card) return;
    var v = $('rename-input').value.trim();
    if (!v) { FC.toast('卡片名称不能为空', 'err'); return; }
    if (v === (card.name || '')) { closeRename(); return; }

    var btn = $('rename-save');
    btn.disabled = true;
    try {
      var res = await FC.cloud.database.from('cards').update({ name: v }).eq('id', card.id).select();
      if (res.error) throw new Error(res.error.message);
      if (!res.data || !res.data.length) throw new Error('修改被拒绝：卡片不存在或不是你的收藏');
      card.name = v;
      if (FC.offline && session) FC.offline.saveRows(session.user.id, [card], false);
      renderMeta();           // 同步页面标题与 document.title
      FC.toast('已重命名', 'ok');
      closeRename();
    } catch (e) {
      FC.toast(FC.errText(e, '重命名失败，请重试'), 'err');
      btn.disabled = false;
    }
  }

  /* ---------------- 更换封面 ---------------- */

  function openCover() {
    if (offlineMode) { FC.toast('离线模式不能更换封面，请联网后重试', 'err'); return; }
    if (!card) return;
    FC.cover.open(card, function (res) {
      if (!res || !res.changed) return;
      var txt = $('d-cover-txt');
      if (txt) txt.textContent = card.thumb_path ? '自定义' : '自动';
      var btn = $('btn-cover');
      if (btn) btn.textContent = card.thumb_path ? '换封面' : '设封面';
    });
  }

  /* ---------------- 删除 ---------------- */

  async function removeCard() {
    if (offlineMode) { FC.toast('离线模式不能删除，请联网后重试', 'err'); return; }
    if (!card) return;
    var box = $('confirm-box');
    box.style.display = 'flex';
    $('confirm-name').textContent = '「' + (card.name || '未命名') + '」';
  }

  async function doRemove() {
    hideConfirm();
    var btn = $('btn-delete');
    btn.disabled = true;
    try {
      // 1) 先删索引行：删除成功后卡片即从所有设备消失
      var del = await FC.cloud.database.from('cards').delete().eq('id', card.id).select();
      if (del.error) throw new Error(del.error.message);
      if (!del.data || !del.data.length) {
        FC.toast('删除被拒绝：卡片不存在或不是你的收藏', 'err');
        btn.disabled = false;
        return;
      }
      // 2) 尽力清理存储文件；清理失败不影响收藏列表一致性
      try {
        var paths = [card.card_path];
        if (card.thumb_path) paths.push(card.thumb_path);
        await FC.cloud.storage.remove(paths);
      } catch (e) {
        console.warn('存储文件清理失败（不影响使用）', e && e.message);
      }
      FC.toast('已删除', 'ok');
      if (FC.offline && session) FC.offline.remove(session.user.id, card.id);
      setTimeout(function () { location.replace('index.html'); }, 400);
    } catch (e) {
      FC.toast(FC.errText(e, '删除失败，请重试'), 'err');
      btn.disabled = false;
    }
  }

  function hideConfirm() { $('confirm-box').style.display = 'none'; }

  function showNotFound(title, desc) {
    FC.hideBoot();
    document.querySelector('.detail-wrap').innerHTML =
      '<div class="detail-state">' +
      '  <h2>' + esc(title) + '</h2>' +
      '  <p>' + esc(desc) + '</p>' +
      '  <a class="btn btn-primary" href="index.html">返回我的收藏</a>' +
      '</div>';
  }

  // 可重试的临时态：登录态恢复失败但本机仍保留记录时使用，不把人赶回登录页
  function showRetry(title, desc) {
    FC.hideBoot();
    document.querySelector('.detail-wrap').innerHTML =
      '<div class="detail-state">' +
      '  <h2>' + esc(title) + '</h2>' +
      '  <p>' + esc(desc) + '</p>' +
      '  <button class="btn btn-primary" id="retry-btn" type="button">重试</button>' +
      '</div>';
    var b = document.getElementById('retry-btn');
    if (b) b.addEventListener('click', function () { location.reload(); });
  }

  /* ---------------- 绑定 ---------------- */

  function bind() {
    $('btn-rename').addEventListener('click', openRename);
    var btnCover = $('btn-cover');
    if (btnCover) btnCover.addEventListener('click', openCover);
    $('rename-close').addEventListener('click', closeRename);
    $('rename-cancel').addEventListener('click', closeRename);
    $('rename-save').addEventListener('click', saveRename);
    $('rename-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveRename();
    });
    $('rename-overlay').addEventListener('click', function (e) {
      if (e.target === this) closeRename();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('rename-overlay').classList.contains('open')) closeRename();
    });
    $('btn-delete').addEventListener('click', removeCard);
    $('confirm-ok').addEventListener('click', doRemove);
    $('confirm-cancel').addEventListener('click', hideConfirm);
    var btnMode = $('btn-mode');
    if (btnMode) btnMode.addEventListener('click', switchMode);
    var btnWin = $('btn-newwin');
    if (btnWin) btnWin.addEventListener('click', openNewWin);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(); start(); });
  } else {
    bind(); start();
  }
})();
