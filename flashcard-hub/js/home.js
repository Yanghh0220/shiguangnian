/* ============================================================
 * home.js — 首页逻辑
 * 职责：登录门卫视图切换、收藏列表（筛选/搜索/分页/缩略图懒签名）、
 *       上传弹窗（解析标题 → 生成封面缩略图 → 传原文件+缩略图 → 写索引）
 * 列表页永不触碰卡片大文件：只读索引行 + 封面缩略图签名链接
 * ============================================================ */

(function () {
  'use strict';

  var FC = window.FC;
  var PAGE_SIZE = 24;
  var MAX_CARD_MB = 50;          // 单卡上传体积上限
  var THUMB_MAX = 480;           // 缩略图最长边

  // 当前筛选状态
  var filters = { time: 'all', source: 'all', sort: 'newest', kw: '' };
  var pageIdx = 0;               // 已加载页数
  var totalCount = 0;            // 当前筛选命中的总数（分页用）
  var hasAnyCard = false;        // 区分「没收藏」与「筛选无结果」两种空态
  var thumbCache = {};           // path -> 签名 url（会话内复用，避免重复签发）
  var cardIndex = {};            // id -> 卡片索引行（重命名时按 id 定位）
  var renaming = null;           // 当前正在重命名的卡片
  var session = null;
  var offlineMode = false;

  /* 月度隔水：按收藏月份给长卷插入「裱绫」横带（仅日期排序时启用） */
  var MO_CN = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  var MO_EN = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  var lastMonthKey = null;       // 上一张卡所在月份，跨分页连续判断

  /* 首页显示形式：grid（图录，现有形式） / immersive（抖音式沉浸单卡） */
  var MODE_KEY = 'fc-home-mode';
  var viewMode = readMode();
  var modeApplying = false;      // 模式切换串行化，避免快速连点同时拉数据
  var pendingMode = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return FC.escapeHtml(s); }

  /* ---------------- 显示形式状态 ---------------- */

  function readMode() {
    try { return window.localStorage.getItem(MODE_KEY) === 'immersive' ? 'immersive' : 'grid'; }
    catch (e) { return 'grid'; }
  }
  function saveMode(m) {
    try { window.localStorage.setItem(MODE_KEY, m); } catch (e) { /* 隐私模式下忽略 */ }
  }
  function updateSwitch() {
    document.querySelectorAll('#view-switch .vs-btn').forEach(function (b) {
      var on = b.getAttribute('data-mode') === viewMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function emptyCopy() {
    return hasAnyCard
      ? { title: '没有符合筛选的闪卡', desc: '换一个筛选条件，或清空搜索词再试。', btn: '切回图录' }
      : { title: '册子还是空的', desc: '把生成好的全息闪卡 HTML 文件登记进来，就能开始随序翻阅。', btn: '切回图录' };
  }

  /* ==================== 启动与视图切换 ==================== */

  async function enterOffline(cachedSession) {
    session = cachedSession;
    offlineMode = true;
    FC.offline.setActive(true);
    FC.auth.renderNavUser(session);
    showApp();
    await applyMode('grid');
  }

  async function start() {
    FC.auth.bindLoginUI();

    // 启动兜底：恢复流程若被极端情况卡住，最迟 15 秒也要落到登录视图，不能停在空白/启动态
    setTimeout(function () {
      var boot = document.getElementById('boot-view');
      if (boot && boot.classList.contains('show')) {
        if (FC.session.has()) {
          showLogin();
          FC.auth.showLoginError('网络较慢，登录状态还没取回来（本机记录已保留），可点下方按钮重试或重新登录。');
        } else {
          showLogin();
        }
      }
    }, 15000);

    await FC.auth.boot({
      onSignedIn: async function () {
        var res = await FC.cloud.auth.getSession();
        // 极少数情况下 getSession 恰好返回空（并发刷新中），用本机记录兜底，避免刚登录又跳回登录页
        session = (res && res.data) || FC.session.read();
        if (!session) { showLogin(); return; }
        FC.auth.renderNavUser(session);

        // 副身份（微信）已被绑定到主账号 → 引导改用主账号登录，不展示独立收藏夹
        var binding = await FC.binding.resolve(session);
        if (binding.bound) {
          await showBound(binding);
          return;
        }

        showApp();
        await applyMode(viewMode);
        await renderMergeBanner();
      },
      onSignedOut: function () {
        showLogin();
      },
      onOffline: enterOffline
    });
  }

  function showLogin() {
    FC.hideBoot();
    $('app-view').style.display = 'none';
    $('bound-view').classList.remove('show');
    $('login-view').classList.add('show');
  }

  function showApp() {
    FC.hideBoot();
    $('login-view').classList.remove('show');
    $('bound-view').classList.remove('show');
    $('app-view').style.display = '';
  }

  /* 切换首页显示形式。选择写本机，刷新后保持一致；
     切换过程串行执行，快速连点时只补做最后一次请求。 */
  async function applyMode(mode) {
    if (modeApplying) { pendingMode = mode; return; }
    modeApplying = true;
    try {
      var wantImmersive = mode === 'immersive' && !!FC.immersive;
      viewMode = wantImmersive ? 'immersive' : 'grid';
      saveMode(viewMode);
      updateSwitch();

      var app = $('app-view');
      if (wantImmersive) {
        await refreshStats();          // 空态文案依赖 hasAnyCard，先取总数
        app.classList.add('is-immersive');
        await FC.immersive.enter();
      } else {
        app.classList.remove('is-immersive');
        if (FC.immersive) FC.immersive.leave();
        await reloadAll();             // 图录模式：完全沿用原有分页 / 筛选行为
      }
    } finally {
      modeApplying = false;
      if (pendingMode) { var p = pendingMode; pendingMode = null; applyMode(p); }
    }
  }

  /* ==================== 绑定引导（副身份登录） ==================== */
  /* 平台无法把两个登录身份合并成同一个 auth 用户，所以「绑定」表现为：
   * 副身份登录后不进入独立的收藏夹，而是引导到主账号。
   * 若该身份名下还有卡片（合并尚未完成），这里额外提供「打包搬运」入口。 */

  async function showBound(binding) {
    FC.hideBoot();
    $('login-view').classList.remove('show');
    $('app-view').style.display = 'none';
    $('bound-view').classList.add('show');

    var label = binding.label || '绑定的主账号';
    $('bound-title').textContent = (binding.provider === 'wechat' ? '此微信' : '此登录方式') + '已绑定到主账号';
    $('bound-desc').textContent = '为避免收藏分成两份，请改用「' + label + '」登录。同一台设备登录过一次后会自动进入。';

    var btn = $('bound-primary');
    btn.textContent = '用「' + label + '」登录';
    btn.onclick = async function () {
      btn.disabled = true;
      btn.textContent = '正在退出…';
      await FC.cloud.auth.signOut();
      FC.session.clear();
      FC.session.purgeTrash();   // 主动退出连回收站一起清，避免下次启动被「复活」
      FC.binding.clearCache();
      location.reload();
    };

    // 这条身份名下是否还有待搬运的卡片
    var extra = $('bound-extra');
    extra.innerHTML = '<p class="bound-tip">正在检查这个账号的历史收藏…</p>';
    var uid = session.user.id;
    var cnt = await FC.cloud.database.from('cards').select('*', { count: 'exact', head: true });
    var n = (cnt && !cnt.error && typeof cnt.count === 'number') ? cnt.count : 0;
    if (n > 0 && FC.merge.mergedFlag(uid)) {
      mountCleanupUI(extra, n, label);
    } else if (n > 0) {
      mountPackUI(extra, n, label);
    } else {
      var pkg = await FC.merge.readPackage();
      extra.innerHTML = pkg && pkg.fromUid === uid
        ? '<p class="bound-tip">已打包 ' + pkg.count + ' 张卡片在本机，请用「' + esc(label) + '」登录后导入。</p>'
        : '<p class="bound-tip">这个账号已没有待搬运的卡片，直接用上面的按钮登录即可。</p>';
    }
  }

  /* 清理 UI：合并确认无误后，回收这个副账号的旧索引与文件 */
  function mountCleanupUI(host, count, label) {
    host.innerHTML =
      '<div class="pack-box">' +
      '  <p class="bound-tip"><b>' + count + '</b> 张卡片已合并到「' + esc(label) + '」。</p>' +
      '  <button class="btn btn-ghost" id="clean-btn">清理这个账号的旧数据</button>' +
      '  <div id="clean-progress"></div>' +
      '  <p class="bound-note">请先在主账号里确认能看到这些卡片再清理。清理只删这里的旧索引与文件，不影响主账号。</p>' +
      '</div>';

    var btn = $('clean-btn');
    btn.onclick = async function () {
      if (!window.confirm('确认清理？将删除这个账号下的 ' + count + ' 张旧卡片索引与文件（主账号里的不受影响）。')) return;
      btn.disabled = true;
      btn.textContent = '清理中…';
      var pg = FC.merge.makeProgress($('clean-progress'));
      try {
        var out = await FC.merge.cleanupSource(function (done, total, name) {
          pg.set(done, total, name);
        });
        pg.remove();
        FC.toast('已清理 ' + out.rows + ' 张旧索引', 'ok');
        host.innerHTML = '<p class="bound-tip">旧数据已清理完成，这个账号不会再产生独立收藏。</p>';
      } catch (e) {
        pg.remove();
        btn.disabled = false;
        btn.textContent = '重新清理';
        FC.toast(FC.errText(e, '清理失败'), 'err');
      }
    };
  }

  /* 打包 UI：把本身份名下的卡片下载到本机，供主账号会话导入 */
  function mountPackUI(host, count, label) {
    host.innerHTML =
      '<div class="pack-box">' +
      '  <p class="bound-tip">这个账号里还有 <b>' + count + '</b> 张卡片没有并到主账号。</p>' +
      '  <button class="btn btn-ghost" id="pack-btn">打包这 ' + count + ' 张（存到本机）</button>' +
      '  <div id="pack-progress"></div>' +
      '  <p class="bound-note">打包只把文件暂存在本机浏览器，随后用主账号登录即可导入。卡片文件不会公开共享。</p>' +
      '</div>';

    var btn = $('pack-btn');
    btn.onclick = async function () {
      btn.disabled = true;
      btn.textContent = '打包中…';
      var box = $('pack-progress');
      var pg = FC.merge.makeProgress(box);
      try {
        var out = await FC.merge.exportAll(function (done, total, name) {
          pg.set(done, total, name);
        });
        pg.remove();
        FC.toast('已打包 ' + out.count + ' 张卡片（约 ' + FC.formatBytes(out.bytes) + '）', 'ok');
        host.innerHTML =
          '<div class="pack-box ok">' +
          '  <p class="bound-tip">已打包 <b>' + out.count + '</b> 张卡片到本机。</p>' +
          '  <p class="bound-note">下一步：用「' + esc(label) + '」登录，页面顶部会出现导入入口。</p>' +
          '</div>';
      } catch (e) {
        pg.remove();
        btn.disabled = false;
        btn.textContent = '重新打包';
        FC.toast(FC.errText(e, '打包失败'), 'err');
      }
    };
  }

  /* ==================== 合并横幅（主账号会话） ==================== */

  async function renderMergeBanner() {
    var host = $('merge-banner');
    if (!host || !FC.merge || !FC.merge.readPackage) return;
    host.innerHTML = '';
    var pkg = await FC.merge.readPackage();
    if (!pkg) return;
    if (session && session.user && pkg.fromUid === session.user.id) {
      // 自己打自己：提示用另一个账号登录
      host.innerHTML =
        '<div class="merge-banner">' +
        '  <div class="merge-banner-txt">本机暂存了当前账号自己的 ' + pkg.count + ' 张卡片，请用主账号登录后再导入。</div>' +
        '  <button class="btn btn-ghost" id="merge-cancel">清除暂存</button>' +
        '</div>';
      $('merge-cancel').onclick = async function () {
        await FC.merge.discardPackage();
        host.innerHTML = '';
        FC.toast('已清除本机暂存', 'ok');
      };
      return;
    }
    host.innerHTML =
      '<div class="merge-banner">' +
      '  <div class="merge-banner-txt">发现 <b>' + pkg.count + '</b> 张来自「' + esc(pkg.fromName || '另一账号') + '」的卡片待并入本账号。</div>' +
      '  <div class="merge-banner-btns">' +
      '    <button class="btn btn-primary" id="merge-import">开始合并</button>' +
      '    <button class="btn btn-ghost" id="merge-cancel">稍后</button>' +
      '  </div>' +
      '  <div id="merge-progress"></div>' +
      '</div>';

    $('merge-cancel').onclick = function () { host.innerHTML = ''; };
    $('merge-import').onclick = async function () {
      this.disabled = true;
      this.textContent = '合并中…';
      var pg = FC.merge.makeProgress($('merge-progress'));
      try {
        var out = await FC.merge.importAll(function (done, total, name) {
          pg.set(done, total, name);
        });
        pg.remove();
        var msg = '合并完成：新增 ' + out.imported + ' 张';
        if (out.skipped) msg += '，跳过重复 ' + out.skipped + ' 张';
        if (out.failed) msg += '，失败 ' + out.failed + ' 张';
        FC.toast(msg, out.failed ? 'err' : 'ok');
        host.innerHTML = '<div class="merge-banner done">' + esc(msg) + '。' +
          (out.failed ? '失败项已保留在本机暂存，可再点一次重试。' : '') + '</div>';
        await reloadAll();
      } catch (e) {
        pg.remove();
        this.disabled = false;
        this.textContent = '开始合并';
        FC.toast(FC.errText(e, '合并失败'), 'err');
      }
    };
  }

  /* ==================== 统计 ==================== */

  async function refreshStats() {
    if (offlineMode && session && FC.offline) {
      var cachedRows = FC.offline.all(session.user.id);
      hasAnyCard = cachedRows.length > 0;
      return;
    }
    try {
      var total = await FC.cloud.database.from('cards').select('*', { count: 'exact', head: true });
      if (!total.error) {
        hasAnyCard = (total.count || 0) > 0;
      }
    } catch (e) { /* 统计失败不阻塞列表 */ }
  }

  /* ==================== 列表查询与渲染 ==================== */

  function timeToIso(days) {
    var d = new Date(Date.now() - days * 86400000);
    return d.toISOString();
  }

  // 转义 LIKE 通配符，避免搜索词里的 % _ 被误当通配符
  function escapeLike(s) { return s.replace(/[%_\\]/g, '\\$&'); }

  async function queryRange(from, to) {
    var q = FC.cloud.database.from('cards').select('*', { count: 'exact' });
    if (filters.time !== 'all') q = q.gte('created_at', timeToIso(parseInt(filters.time, 10)));
    if (filters.source !== 'all') q = q.eq('source', filters.source);
    if (filters.kw) q = q.ilike('name', '%' + escapeLike(filters.kw) + '%');
    if (filters.sort === 'oldest') q = q.order('created_at', { ascending: true });
    else if (filters.sort === 'name') q = q.order('name', { ascending: true });
    else q = q.order('created_at', { ascending: false });

    var res;
    try { res = await q.range(from, to); }
    catch (e) { res = { data: null, error: e }; }
    var uid = session && session.user && session.user.id;
    if (res && !res.error) {
      offlineMode = false;
      if (FC.offline) {
        FC.offline.setActive(false);
        var isDefaultFirstPage = from === 0 && filters.time === 'all' && filters.source === 'all' &&
          filters.sort === 'newest' && !filters.kw;
        FC.offline.saveRows(uid, res.data || [], isDefaultFirstPage && (res.count || 0) <= PAGE_SIZE);
      }
      return res;
    }

    if (FC.offline && uid && FC.offline.shouldFallback(res && res.error)) {
      var cached = FC.offline.query(uid, filters, from, to);
      if (cached) {
        offlineMode = true;
        FC.offline.setActive(true);
        return cached;
      }
    }
    throw (res && res.error) || new Error('读取收藏失败');
  }

  // 批量补签封面（会话缓存命中则跳过）；沉浸模式取全量时分批签，避免单次请求过大
  async function prepareThumbs(rows) {
    var uid = session && session.user && session.user.id;
    if (FC.offline && uid) {
      for (var j = 0; j < rows.length; j++) {
        var cached = rows[j] && rows[j].thumb_path
          ? await FC.offline.thumbUrl(uid, rows[j].thumb_path) : null;
        if (cached) thumbCache[rows[j].thumb_path] = cached;
      }
    }
    if (offlineMode) return;
    var need = [];
    rows.forEach(function (c) {
      if (c && c.thumb_path && !thumbCache[c.thumb_path]) need.push(c.thumb_path);
    });
    for (var i = 0; i < need.length; i += PAGE_SIZE) {
      var urls = await FC.signedUrls(need.slice(i, i + PAGE_SIZE), 3600);
      for (var k in urls) {
        thumbCache[k] = urls[k];
        if (FC.offline && uid) FC.offline.primeThumb(uid, k, urls[k]);
      }
    }
  }

  /* 沉浸模式需要「当前筛选命中的全部卡片」，沿用现有筛选 / 排序条件分页拉取。
     逐页按 id 去重：即使排序键相同造成页间重叠，也不会有卡片重复进入卡组。 */
  async function fetchAllRows() {
    var all = [], seen = {}, from = 0, total = null, guard = 0;
    while (guard++ < 200) {
      var res = await queryRange(from, from + PAGE_SIZE - 1);
      if (res.error) throw res.error;   // 保留原始错误对象/字符串，避免丢失 message
      if (typeof res.count === 'number') total = res.count;
      var batch = res.data || [];
      for (var i = 0; i < batch.length; i++) {
        var c = batch[i];
        if (c && !seen[c.id]) {
          seen[c.id] = 1;
          all.push(c);
          cardIndex[c.id] = c;      // 沉浸模式下重命名 / 换封面也要能按 id 定位
        }
      }
      from += PAGE_SIZE;
      if (total !== null) { if (from >= total) break; }
      else if (batch.length < PAGE_SIZE) break;   // 没有 count 时按「不足一页」判断到底
    }
    await prepareThumbs(all);
    return all;
  }

  async function reloadAll() {
    pageIdx = 0;
    lastMonthKey = null;         // 长卷重排，月份隔水从头计
    // 沉浸模式：改用全量卡组，仍然遵守筛选 / 排序 / 搜索
    if (FC.immersive && FC.immersive.isActive()) {
      await refreshStats();
      await FC.immersive.reload();
      return;
    }
    renderSkeletons();
    hideStates();
    try {
      var res = await queryRange(0, PAGE_SIZE - 1);
      if (res.error) throw res.error;   // 保留原始错误对象/字符串，避免丢失 message
      totalCount = res.count || 0;
      if (res.fromCache) hasAnyCard = (res.totalAll || 0) > 0;
      await renderCards(res.data || [], true);   // 渲染阶段的异常也纳入统一错误态
      await refreshStats();
    } catch (e) {
      showError(FC.errText(e, '加载收藏列表失败'));
    }
  }

  async function loadMore() {
    var btn = $('load-more-btn');
    btn.disabled = true;
    btn.textContent = '加载中…';
    try {
      var from = pageIdx * PAGE_SIZE;
      var res = await queryRange(from, from + PAGE_SIZE - 1);
      if (res.error) throw res.error;   // 保留原始错误对象/字符串，避免丢失 message
      totalCount = res.count || 0;
      pageIdx++;
      renderCards(res.data || [], false);
    } catch (e) {
      FC.toast(FC.errText(e, '加载更多失败'), 'err');
    }
    btn.disabled = false;
    btn.textContent = '加载更多';
    syncLoadMore();
  }

  function renderSkeletons() {
    var html = '';
    for (var i = 0; i < 8; i++) {
      html +=
        '<div class="plate skeleton" aria-hidden="true">' +
        '  <div class="plate-face">' +
        '    <div class="plate-field"></div>' +
        '    <div class="plate-nameplate">' +
        '      <span class="sk line" style="width:20px"></span>' +
        '      <span class="sk line" style="width:62%;margin-top:11px"></span>' +
        '      <span class="sk line" style="width:38%;margin-top:9px;height:6px"></span>' +
        '    </div>' +
        '  </div>' +
        '</div>';
    }
    $('grid').innerHTML = html;
  }

  /* ---------------- 卡片渲染：图录式卡片（plate） ----------------
   * 关键设计：卡片不依赖封面图也能成立。
   * 画面区默认是「字形 + 刻线 + 全息斜光」的排版版式，缩略图只是可选的叠加层；
   * 加载失败时按三级回退（重新签名 → SDK 下载成 Blob → 放弃图片），
   * 任何一级失败都不会留下空白框，始终是一张完整的卡面。 */

  var objectUrls = [];   // 已创建的 blob: URL，重载列表时统一回收

  function padNo(id) {
    var s = String(id == null ? '' : id);
    while (s.length < 4) s = '0' + s;
    return 'NO.' + s;
  }

  function sigil() {
    return '<svg class="plate-sigil" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M8 1.6 14.4 8 8 14.4 1.6 8Z" stroke="currentColor" stroke-width="1"/></svg>';
  }

  /* 月份键与隔水横带 */
  function monthKey(c) {
    var t = c && c.created_at ? String(c.created_at) : '';
    var m = t.match(/^(\d{4})-(\d{2})/);
    return m ? m[1] + '-' + m[2] : '';
  }
  function monthBandHtml(key) {
    var mi = parseInt(key.slice(5, 7), 10) - 1;
    var cn = MO_CN[mi] || key.slice(5, 7) + '月';
    var en = MO_EN[mi] || '';
    return '<div class="month-band" role="separator" aria-label="' + key.slice(0, 4) + '年' + cn + '">' +
      '<span class="mb-cn">' + cn + '</span>' +
      '<span class="mb-en">' + en + ' ' + key.slice(0, 4) + '</span>' +
      '<i class="mb-line" aria-hidden="true"></i>' +
      '<i class="mb-diamond" aria-hidden="true"></i>' +
      '</div>';
  }

  function cardHtml(c, idx, lead) {
    var name = c.name || '未命名闪卡';
    var glyph = esc(name.trim().slice(0, 1) || '·');
    var url = (c.thumb_path && thumbCache[c.thumb_path]) || '';
    var pic = '';
    if (c.thumb_path) {
      pic = '<div class="plate-pic">' +
            (url ? '<img src="' + esc(url) + '" data-path="' + esc(c.thumb_path) + '" alt="" loading="lazy">' : '') +
            '</div>';
    }
    return (
      '<article class="plate' + (lead ? ' lead' : '') + '" style="--i:' + (idx || 0) + '" data-id="' + c.id + '">' +
      '  <a class="plate-link" href="detail.html?id=' + c.id + '" aria-label="' + esc(name) + '">' +
      '    <div class="plate-face">' +
      '      <div class="plate-field">' +
      '        <span class="plate-glyph" aria-hidden="true">' + glyph + '</span>' +
      pic +
      '        <span class="plate-inner" aria-hidden="true"></span>' +
      '      </div>' +
      '      <div class="plate-nameplate">' +
      '        <span class="plate-rule" aria-hidden="true"></span>' +
      '        <h3 class="plate-name">' + esc(name) + '</h3>' +
      '        <div class="plate-mat">' +
      '          <span>独一无二 · Unique</span>' + sigil() +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '  </a>' +
      '  <button class="plate-cover" data-cover="' + c.id + '" type="button" aria-label="更换封面" title="更换封面">' +
      '    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.4" y="5.4" width="17.2" height="13.2" rx="1.2" stroke="currentColor" stroke-width="1.5"/><circle cx="8.6" cy="10.2" r="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.2 16.6 9.3 11.9l3.6 3.4 2.5-2.4 4.4 4.1" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
      '  </button>' +
      '  <button class="plate-edit" data-rename="' + c.id + '" type="button" aria-label="重命名" title="重命名">' +
      '    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4L19.4 8.6a2 2 0 0 0-2.8-2.8L5 17v3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 7l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
      '  </button>' +
      '  <div class="plate-cap">' +
      '    <span class="cap-no">' + padNo(c.id) + '</span>' +
      '    <span class="cap-sep"></span>' +
      '    <b>' + esc(c.source || '上传导入') + '</b>' +
      '    <span class="cap-sep"></span>' +
      '    <span class="cap-date">' + FC.formatDate(c.created_at) + '</span>' +
      '  </div>' +
      '</article>'
    );
  }

  /* ---------------- 封面图加载与回退 ---------------- */

  function releaseObjectUrls() {
    for (var i = 0; i < objectUrls.length; i++) {
      try { URL.revokeObjectURL(objectUrls[i]); } catch (e) { /* 忽略 */ }
    }
    objectUrls = [];
    // 同步清掉会话缓存里指向已回收 blob: 的条目，
    // 避免重建列表时先用失效 URL 白错一轮再走重签
    for (var k in thumbCache) {
      if (String(thumbCache[k]).indexOf('blob:') === 0) delete thumbCache[k];
    }
  }

  // 放弃图片：移除画面层，卡面回到排版版式（不是空白，是设计好的另一种样子）
  function dropPicture(plate) {
    var pic = plate.querySelector('.plate-pic');
    if (pic) pic.remove();
    plate.classList.remove('has-pic');
  }

  async function recoverThumb(plate, img) {
    var path = img.getAttribute('data-path');
    var stage = img.getAttribute('data-stage') || 'signed';
    if (!path) { dropPicture(plate); return; }
    try {
      if (stage === 'signed') {
        // ① 签名过期或缓存失效：重新签发一次
        img.setAttribute('data-stage', 'resign');
        var fresh = await FC.signedUrl(path, 3600);
        thumbCache[path] = fresh;
        img.src = fresh;
        return;
      }
      if (stage === 'resign') {
        // ② 签名链接本身不可用：走 SDK 鉴权下载成 Blob，绕开链接问题。
        // storage.download 返回的是下载器对象（.blob() 拿内容），不是 Blob 本身；
        // 直接当 Blob 读 size 必然失败 —— 上一版二级回退恒不生效的根因。
        img.setAttribute('data-stage', 'blob');
        var res = await FC.cloud.storage.download(path);
        if (res && res.error) throw new Error(res.error.message);
        var data = res && res.data;
        var blob = (data && typeof data.blob === 'function') ? await data.blob() : data;
        if (!blob || !blob.size) throw new Error('封面内容为空');
        // 内容必须是真实图片（网关错误页也可能被包装成 Blob），
        // 用 Image 解码验证，防止把 HTML 错误体当图加载后黑块占位
        var ok = await new Promise(function (resolve) {
          var probe = new Image();
          var u0 = URL.createObjectURL(blob);
          probe.onload = function () { resolve(probe.naturalWidth > 0 ? u0 : null); };
          probe.onerror = function () { URL.revokeObjectURL(u0); resolve(null); };
          probe.src = u0;
        });
        if (!ok) throw new Error('封面内容不是可用图片');
        objectUrls.push(ok);
        img.src = ok;
        return;
      }
    } catch (e) { /* 继续下一级 */ }
    img.setAttribute('data-stage', 'done');
    dropPicture(plate);
  }

  function bindThumb(plate) {
    var img = plate.querySelector('.plate-pic img');
    if (!img) return;   // 没有缩略图 → 直接使用排版卡面
    var ok = function () {
      if (img.naturalWidth > 0) {
        img.classList.add('loaded');
        plate.classList.add('has-pic');
      }
    };
    img.addEventListener('load', ok);
    img.addEventListener('error', function () { recoverThumb(plate, img); });
    // img.complete 且宽为 0：监听器挂上前就已加载失败（缓存失效、快速翻页），
    // error 事件不会再触发，必须主动走回退，否则破图卡死在中间态
    if (img.complete && img.naturalWidth > 0) ok();
    else if (img.complete) recoverThumb(plate, img);
  }

  /* ---------------- 换封面后即时重绘卡面 ----------------
   * 不重新拉列表：直接把本地 Blob 显示出来，列表状态与滚动位置都不动。
   * url 传 null 表示移除封面，卡面回到「字形 + 刻线」的排版版式。 */
  function paintCover(plate, url) {
    var field = plate.querySelector('.plate-field');
    if (!field) return;
    var pic = field.querySelector('.plate-pic');
    if (!url) {
      if (pic) pic.remove();
      var img0 = plate.querySelector('.plate-pic img');
      if (img0) img0.classList.remove('loaded');
      plate.classList.remove('has-pic');
      return;
    }
    if (!pic) {
      pic = document.createElement('div');
      pic.className = 'plate-pic';
      // 插到字形之后、内框之前，保持原有的层叠顺序
      var inner = field.querySelector('.plate-inner');
      field.insertBefore(pic, inner || null);
    }
    pic.innerHTML = '';
    var img = document.createElement('img');
    img.alt = '';
    img.onload = function () {
      img.classList.add('loaded');
      plate.classList.add('has-pic');
    };
    img.onerror = function () {
      // 预览 URL 失效（blob 被提前回收等）：移除画面层，卡面回到排版版式
      img.onerror = null;
      pic.remove();
      plate.classList.remove('has-pic');
    };
    img.src = url;
    pic.appendChild(img);
  }

  async function renderCards(rows, reset) {    var grid = $('grid');
    if (reset) { grid.innerHTML = ''; releaseObjectUrls(); lastMonthKey = null; }
    if (!rows.length) { showEmpty(); syncLoadMore(); return; }

    // 本页缺少签名链接的缩略图批量补签（会话缓存命中则跳过）
    await prepareThumbs(rows);

    var html = '';
    var byDate = filters.sort !== 'name';   // 名称排序时时间乱序，不插月份隔水
    rows.forEach(function (c, i) {
      cardIndex[c.id] = c;   // 供重命名按 id 定位
      var lead = false;
      if (byDate) {
        var mk = monthKey(c);
        if (mk !== lastMonthKey) {
          if (mk) { html += monthBandHtml(mk); lead = true; }
          lastMonthKey = mk;
        }
      }
      html += cardHtml(c, i, lead);
    });
    grid.insertAdjacentHTML('beforeend', html);

    // 只给本次新增的卡片绑定封面加载（已绑定过的跳过，避免重复监听）
    grid.querySelectorAll('.plate:not([data-b])').forEach(function (p) {
      p.setAttribute('data-b', '1');
      bindThumb(p);
    });
    backfillThumbs(rows);
    hideStates();
    syncLoadMore();
  }

  /* prepareThumbs 批量/单独签名都可能因一次网络抖动失败，失败行会没有
   * <img>，用户看到的就是「没有封面」。这里对缺链接的行异步补签一次，
   * 成功后把图补进对应卡面；再失败就保持排版卡面，不打扰用户。 */
  function backfillThumbs(rows) {
    var missing = [];
    rows.forEach(function (c) {
      if (c && c.thumb_path && !thumbCache[c.thumb_path]) missing.push(c);
    });
    if (!missing.length || offlineMode) return;
    missing.forEach(function (c) {
      FC.signedUrl(c.thumb_path, 3600).then(function (u) {
        thumbCache[c.thumb_path] = u;
        if (FC.offline && session) FC.offline.primeThumb(session.user.id, c.thumb_path, u);
        var plate = document.querySelector('.plate[data-id="' + c.id + '"] .plate-pic');
        if (!plate || plate.querySelector('img')) return;
        var img = document.createElement('img');
        img.setAttribute('data-path', c.thumb_path);
        img.alt = '';
        img.loading = 'lazy';
        img.src = u;
        img.addEventListener('load', function () {
          if (img.naturalWidth > 0) {
            img.classList.add('loaded');
            plate.closest('.plate').classList.add('has-pic');
          }
        });
        img.addEventListener('error', function () {
          recoverThumb(plate.closest('.plate'), img);
        });
        plate.appendChild(img);
      }).catch(function () { /* 保持排版卡面 */ });
    });
  }

  function syncLoadMore() {
    var loaded = (pageIdx + 1) * PAGE_SIZE;
    var more = loaded < totalCount;
    var area = $('load-more');
    area.style.display = more ? '' : 'none';
    $('load-more-btn').disabled = false;
  }

  /* ---------------- 空态 / 错误态 ---------------- */

  function hideStates() {
    $('state-empty').classList.remove('show');
    $('state-error').classList.remove('show');
    $('grid').style.display = '';
  }
  function showEmpty() {
    $('grid').innerHTML = '';
    $('grid').style.display = 'none';
    $('load-more').style.display = 'none';
    var box = $('state-empty');
    if (hasAnyCard) {
      $('empty-title').textContent = '没有符合筛选的闪卡';
      $('empty-desc').textContent = '换一个筛选条件，或清空搜索词再试。';
      $('empty-upload').style.display = 'none';
    } else {
      $('empty-title').textContent = '册子还是空的';
      $('empty-desc').textContent = '把生成好的全息闪卡 HTML 文件放进来，它就会被登记成一张卡片。';
      $('empty-upload').style.display = '';
    }
    box.classList.add('show');
  }
  function showError(msg) {
    $('grid').innerHTML = '';
    $('grid').style.display = 'none';
    $('load-more').style.display = 'none';
    $('error-desc').textContent = msg;
    $('state-error').classList.add('show');
  }

  /* ==================== 上传弹窗 ==================== */

  var pending = [];   // 待上传文件队列 [{file, name, size, status, error}]
  var uploading = false;

  function openUpload() {
    if (offlineMode) { FC.toast('离线模式仅支持浏览，请联网后再导入', 'err'); return; }
    if (!session) { FC.toast('请先登录', 'err'); return; }
    resetUpload();
    $('upload-overlay').classList.add('open');
  }
  function closeUpload() {
    if (uploading) { FC.toast('正在上传中，请稍候', 'err'); return; }
    $('upload-overlay').classList.remove('open');
  }
  function resetUpload() {
    // 关掉弹窗时回收还没用上的封面预览
    pending.forEach(function (it) {
      if (it.coverUrl) { try { URL.revokeObjectURL(it.coverUrl); } catch (e) { /* 忽略 */ } }
    });
    pending = [];
    $('file-list').innerHTML = '';
    $('file-input').value = '';
    $('progress').classList.remove('show');
    $('progress').querySelector('i').style.width = '0';
  }

  /* 真机 content:// 兼容：优先用 FileReader（Android WebView 历史最稳），
   * file.text() 作为其缺失/失败时的兜底。都不依赖对 File 的二次包装。 */
  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      function fallback() {
        if (file && typeof file.text === 'function') {
          file.text().then(resolve, reject);
        } else {
          reject(new Error('当前浏览器不支持读取文件'));
        }
      }
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { fallback(); };
        fr.onabort = function () { fallback(); };
        fr.readAsText(file);
      } catch (e) { fallback(); }
    });
  }

  /* Blob/File → ArrayBuffer：FileReader 优先，response.arrayBuffer 兜底。
   * 缩略图二进制直传用，避免把 JPEG 字节写成 base64 文本。 */
  function blobToBuffer(blob) {
    return new Promise(function (resolve, reject) {
      function fallback() {
        if (blob && typeof blob.arrayBuffer === 'function') {
          blob.arrayBuffer().then(resolve, reject);
        } else {
          reject(new Error('当前浏览器不支持二进制文件读取'));
        }
      }
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { fallback(); };
        fr.onabort = function () { fallback(); };
        fr.readAsArrayBuffer(blob);
      } catch (e) { fallback(); }
    });
  }

  /* 真机 Android WebView 的文件选择器返回 content:// URI 支撑的 File。
   * 把它二次包装成 new File([contentUriFile]) 后交给 SDK 走 multipart，
   * WebView 在真正读取字节时会再次访问 content:// 授权，很多机型/内核
   * 在此阶段抛 TypeError: Failed to fetch —— 请求根本没发出，且标准桌面
   * 浏览器无法复现（它拿到的是普通本地文件）。
   * 因此改为：文件先用 FileReader 读成字符串（真机稳定），直接把字符串
   * 交给 SDK 走「直传分支」（非 Blob/File → 显式 content-type，无 multipart），
   * 彻底不再依赖原始 File 对象与其 content:// 授权。 */

  function addFiles(fileList) {
    var okExt = /\.(html?|htm)$/i;
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var item = { file: f, name: '', size: f.size, status: 'ready', error: '' };
      if (!okExt.test(f.name)) {
        item.status = 'err'; item.error = '仅支持 .html 闪卡文件';
      } else if (f.size > MAX_CARD_MB * 1048576) {
        item.status = 'err'; item.error = '超过 ' + MAX_CARD_MB + 'MB 上限';
      } else if (f.size === 0) {
        item.status = 'err'; item.error = '文件为空';
      } else {
        // 文件名兜底命名，选好后解析 <title> 自动替换
        item.name = f.name.replace(/\.html?$/i, '');
      }
      pending.push(item);
    }
    renderFileList();
    // 异步补齐标题（逐个读文件，避免同时读多个 10MB 文件占内存）
    pending.filter(function (it) { return it.status === 'ready' && !it.titleDone; })
      .reduce(function (p, it) {
        return p.then(function () { return fillTitle(it); });
      }, Promise.resolve());
  }

  async function fillTitle(item) {
    try {
      var text = await readFileText(item.file);
      item.titleDone = true;
      var m = text.match(/<title[^>]*>([^<]*)<\/title>/i);
      if (m) {
        // 仅去掉生成器固定后缀，避免误伤卡片名本身
        var t = m[1].trim().replace(/\s*[—–|]\s*HOLO CARD STUDIO\s*$/i, '').trim();
        if (t) {
          item.name = t;
          var input = document.querySelector('[data-idx="' + pending.indexOf(item) + '"]');
          if (input) input.value = t;
        }
      }
    } catch (e) { /* 读取失败留给上传阶段报错 */ }
  }

  function renderFileList() {
    var html = '';
    pending.forEach(function (it, i) {
      var stHtml = it.status === 'err'
        ? '<span class="st err" title="' + esc(it.error) + '">' + esc(it.error) + '</span>'
        : '<span class="st" data-st="' + i + '">' + esc(it.status === 'ok' ? '已收藏' : '就绪') + '</span>';
      // 封面位：未指定时显示「封面」提示，指定后直接给缩略预览
      var locked = it.status === 'ok';
      var covHtml =
        '<button class="fx-cover' + (it.coverUrl ? ' has' : '') + '" data-cov="' + i + '" type="button" ' +
        (locked ? 'disabled ' : '') +
        'aria-label="为第 ' + (i + 1) + ' 张选择封面" title="' + (it.coverUrl ? '重选封面' : '自定义封面') + '">' +
        (it.coverUrl
          ? '<img src="' + esc(it.coverUrl) + '" alt="">'
          : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
            '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="1.2" stroke="currentColor" stroke-width="1.5"/>' +
            '<path d="M12 9v5M9.5 11.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>') +
        '</button>';
      html +=
        '<div class="file-item">' +
        '  <span class="num">' + (i + 1) + '</span>' +
        covHtml +
        '  <input data-idx="' + i + '" value="' + esc(it.name) + '" maxlength="60" ' +
        (it.status === 'ok' ? 'disabled' : '') + ' aria-label="卡片名称">' +
        '  <span class="fsize">' + FC.formatBytes(it.size) + '</span>' + stHtml +
        '</div>';
    });
    $('file-list').innerHTML = html;
    // 名称输入同步回队列
    $('file-list').querySelectorAll('input').forEach(function (input) {
      input.addEventListener('input', function () {
        var i = parseInt(input.getAttribute('data-idx'), 10);
        if (pending[i]) pending[i].name = input.value;
      });
    });
  }

  // 为某一待传卡片挑封面：选图 → 压成 JPEG → 存进队列，真正上传时才写存储
  function pickPendingCover(i) {
    var it = pending[i];
    if (!it || it.status === 'ok' || uploading) return;
    // pickImage 必须与点击同轮触发，故这里不 await 任何前置操作
    FC.cover.pickImage().then(function (file) {
      if (!file) return;
      return FC.cover.makeCoverBlob(file).then(function (blob) {
        if (it.coverUrl) { try { URL.revokeObjectURL(it.coverUrl); } catch (e) { /* 忽略 */ } }
        it.coverBlob = blob;
        it.coverUrl = URL.createObjectURL(blob);
        renderFileList();
        FC.toast('封面已就位，将随卡片一起上传', 'ok');
      });
    }).catch(function (e) {
      FC.toast(FC.errText(e, '封面图片处理失败'), 'err');
    });
  }

  function markItem(i, status, msg) {
    pending[i].status = status;
    var el = document.querySelector('[data-st="' + i + '"]');
    if (el) {
      el.textContent = msg;
      el.className = 'st' + (status === 'ok' ? ' ok' : status === 'err' ? ' err' : '');
    }
  }

  // 从闪卡 HTML 中提取最大的一张内嵌图，缩放生成封面缩略图
  async function makeThumb(text) {
    // 兼容带换行/空白的 base64 与带参数的 data URL；过大阈值过滤纹理小图
    var re = /data:image\/[a-z0-9.+-]+;[^,\"']*base64,([A-Za-z0-9+/=\s]{200,})/gi;
    var best = null, bestLen = 0, m;
    while ((m = re.exec(text)) !== null) {
      var len = m[1].replace(/\s+/g, '').length;
      if (len > bestLen) { bestLen = len; best = m[0]; }
    }
    if (!best) return null; // 过小的图多为纹理/图标，不适合做封面
    var img = await new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () {
        if (im.naturalWidth > 0 && im.naturalHeight > 0) resolve(im);
        else reject(new Error('封面图尺寸无效'));
      };
      im.onerror = function () { reject(new Error('封面图解析失败')); };
      im.src = best;
    });
    var scale = Math.min(THUMB_MAX / img.naturalWidth, THUMB_MAX / img.naturalHeight, 1);
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    var blob = await new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', 0.82);
    });
    return blob || null;
  }

  async function startUpload() {
    if (uploading) return;
    var todo = pending.filter(function (it) { return it.status === 'ready'; });
    if (!pending.length) { FC.toast('请先选择要上传的闪卡文件', 'err'); return; }
    if (!todo.length) { FC.toast('没有可上传的文件，请检查文件格式与大小', 'err'); return; }

    uploading = true;
    $('upload-start').disabled = true;
    $('upload-start').textContent = '上传中…';
    $('progress').classList.add('show');
    var bar = $('progress').querySelector('i');

    // 兼容占位：数据库 rarity 列暂保留，界面已取消稀有度，统一写入固定值且永不展示
    var rarity = 'rare';
    var source = $('upload-source').value;
    var uid = session.user.id;
    var okCount = 0;
    var failureReason = '';

    for (var i = 0; i < pending.length; i++) {
      var it = pending[i];
      if (it.status !== 'ready') continue;
      markItem(i, 'doing', '处理中');
      // 记录已上传路径：索引写入失败时用于回滚清理，避免存储残留
      var cardPath = null, thumbPath = null;
      try {
        // 1) 解析：标题已提取，此处生成缩略图（用户指定了封面就用指定的）
        var text = await readFileText(it.file);
        var name = (it.name || '').trim() || ('闪卡-' + FC.formatDate(Date.now()));
        var thumb = it.coverBlob || null;
        if (!thumb) {
          try { thumb = await makeThumb(text); } catch (e) { thumb = null; } // 封面失败不阻塞上传
        }

        // 2) 上传原文件 + 缩略图（原文件原样保存，保证可独立分发）
        var id = FC.uuid();
        cardPath = FC.cloud.storage.userPath(uid, 'cards/' + id + '.html');
        thumbPath = thumb ? FC.cloud.storage.userPath(uid, 'thumbs/' + id + '.jpg') : null;

        // 传字符串而非 File：绕开 content:// 二次读取，SDK 走直传分支并显式
        // 设置 text/html。text 已在上面用 FileReader 读入内存，真机稳定。
        var up = await FC.cloud.storage.upload(cardPath, text, { contentType: 'text/html; charset=utf-8' });
        if (up.error) throw new Error(up.error.message);
        if (thumbPath) {
          // 缩略图来自 canvas.toBlob（纯内存 Blob，无 content:// 依赖）。
          // 用 ArrayBuffer 直传保住二进制字节；JPEG 本体必须按字节存，不能
          // 转成 base64 文本（那会把 base64 字符串当作图片内容写进去）。
          var thumbBuf = await blobToBuffer(thumb);
          var upT = await FC.cloud.storage.upload(thumbPath, thumbBuf, { contentType: 'image/jpeg' });
          if (upT.error) throw new Error(upT.error.message);
        }

        // 3) 写入索引（owner_id 由数据库按登录身份自动填充，前端不传）
        var ins = await FC.cloud.database.from('cards').insert({
          name: name,
          rarity: rarity,
          source: source,
          card_path: cardPath,
          thumb_path: thumbPath,
          size_bytes: it.size,
          owner_name: (session.user && session.user.name) || null
        }).select();
        if (ins.error) throw new Error(ins.error.message);
        if (!ins.data || !ins.data.length) throw new Error('收藏写入被拒绝，请重新登录后再试');

        markItem(i, 'ok', '已收藏');
        okCount++;
      } catch (e) {
        // 回滚：清理本次已上传但未入库的文件（尽力而为，失败仅记录）
        if (cardPath) {
          var cleanPaths = [cardPath];
          if (thumbPath) cleanPaths.push(thumbPath);
          try { await FC.cloud.storage.remove(cleanPaths); } catch (e2) { console.warn('回滚清理失败', e2 && e2.message); }
        }
        var reason = FC.errText(e, '上传失败');
        if (!failureReason) failureReason = reason;
        markItem(i, 'err', reason);
      }
      bar.style.width = Math.round(((i + 1) / pending.length) * 100) + '%';
    }

    uploading = false;
    $('upload-start').disabled = false;
    $('upload-start').textContent = '开始上传';
    await reloadAll();

    if (okCount > 0 && okCount === todo.length) {
      FC.toast('上传完成，共收藏 ' + okCount + ' 张', 'ok');
      setTimeout(closeUpload, 600);
    } else if (okCount > 0) {
      FC.toast('部分上传成功（' + okCount + ' 张），失败项已标出', 'err');
    } else {
      var reason = failureReason || '未知错误';
      // 保留原始错误，方便真机反馈定位；网络类错误额外给出可执行提示但不吞原文。
      if (/failed to fetch|networkerror|load failed/i.test(reason)) {
        FC.toast('上传失败（网络层）：' + reason + '。若已登录且列表正常，请反馈此原文。', 'err', 6000);
      } else if (/session is invalid|invalid_grant|expired or issued|credentials missing|missing_credentials/i.test(reason)) {
        // 会话被服务端拒绝且续期也失败：SDK 已清登录态，明确引导重登
        FC.toast('登录状态已失效，请重新登录后再上传（' + reason + '）', 'err', 6000);
      } else {
        FC.toast('上传失败：' + reason, 'err', 5200);
      }
    }
  }

  /* ==================== 重命名（已收藏卡片） ==================== */

  function openRename(id) {
    if (offlineMode) { FC.toast('离线模式不能重命名，请联网后重试', 'err'); return; }
    if (!session) { FC.toast('请先登录', 'err'); return; }
    renaming = cardIndex[id] || null;
    if (!renaming) { FC.toast('卡片信息加载中，请稍后再试', 'err'); return; }
    $('rename-input').value = renaming.name || '';
    $('rename-save').disabled = false;
    $('rename-overlay').classList.add('open');
    setTimeout(function () {
      $('rename-input').focus();
      $('rename-input').select();
    }, 60);
  }

  function closeRename() {
    $('rename-overlay').classList.remove('open');
    renaming = null;
  }

  async function saveRename() {
    if (!renaming) return;
    var v = $('rename-input').value.trim();
    if (!v) { FC.toast('卡片名称不能为空', 'err'); return; }
    if (v === (renaming.name || '')) { closeRename(); return; }

    var btn = $('rename-save');
    btn.disabled = true;
    try {
      var res = await FC.cloud.database.from('cards').update({ name: v }).eq('id', renaming.id).select();
      if (res.error) throw new Error(res.error.message);
      if (!res.data || !res.data.length) throw new Error('修改被拒绝：卡片不存在或不是你的收藏');

      // 同步本地缓存与列表 DOM（卡面名称、字形、无障碍标签一并更新）
      renaming.name = v;
      if (FC.offline && session) FC.offline.saveRows(session.user.id, [renaming], false);
      document.querySelectorAll('[data-rename="' + renaming.id + '"]').forEach(function (b) {
        var plate = b.closest('.plate');
        if (!plate) return;
        var nameEl = plate.querySelector('.plate-name');
        if (nameEl) nameEl.textContent = v;
        var glyphEl = plate.querySelector('.plate-glyph');
        if (glyphEl) glyphEl.textContent = v.trim().slice(0, 1) || '·';
        var linkEl = plate.querySelector('.plate-link');
        if (linkEl) linkEl.setAttribute('aria-label', v);
      });
      FC.toast('已重命名', 'ok');
      closeRename();
    } catch (e) {
      FC.toast(FC.errText(e, '重命名失败，请重试'), 'err');
      btn.disabled = false;
    }
  }

  /* ==================== 更换封面（已收藏卡片） ==================== */

  function openCoverFor(id) {
    if (offlineMode) { FC.toast('离线模式不能更换封面，请联网后重试', 'err'); return; }
    if (!session) { FC.toast('请先登录', 'err'); return; }
    var card = cardIndex[id];
    if (!card) { FC.toast('卡片信息加载中，请稍后再试', 'err'); return; }
    FC.cover.open(card, function (res) {
      if (!res || !res.changed) return;
      // 沉浸模式下只改当前可见的那张卡面，别误改隐藏的图录网格
      var root = (FC.immersive && FC.immersive.isActive()) ? $('im-view') : document;
      var plate = root.querySelector('.plate[data-id="' + id + '"]');
      if (!plate) return;
      if (!res.blob) { paintCover(plate, null); return; }
      var u = URL.createObjectURL(res.blob);
      objectUrls.push(u);      // 重载列表时统一回收
      // applyCover 已把 card.thumb_path 改成新路径；写进会话缓存，
      // 这样滑走再滑回来、卡面重新渲染时显示的仍是新封面
      if (card.thumb_path) thumbCache[card.thumb_path] = u;
      if (FC.offline && session) FC.offline.saveRows(session.user.id, [card], false);
      paintCover(plate, u);
    });
  }

  /* ==================== 事件绑定 ==================== */

  /* 案头工具杆：滚过扉页后吸顶，加投影提示「已吸附」 */
  function bindDesk() {
    var desk = $('desk');
    var sen = document.querySelector('.desk-sentinel');
    if (!desk || !sen || !window.IntersectionObserver) return;
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        desk.classList.toggle('stuck', !entries[i].isIntersecting);
      }
    }, { threshold: 0 });
    io.observe(sen);
  }

  function bind() {
    // 首页显示形式：两种模式共用同一套卡片渲染与数据查询
    if (FC.immersive) {
      FC.immersive.init({
        loadRows: fetchAllRows,        // 沉浸模式按现有筛选拉全量卡片（分页去重 + 批量补签）
        cardHtml: cardHtml,            // 卡面完全复用图录模式的版式
        bindThumb: bindThumb,          // 封面加载与三级回退也复用
        emptyCopy: emptyCopy,
        switchToGrid: function () { applyMode('grid'); }
      });
    }
    $('view-switch').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-mode]') : null;
      if (!b) return;
      var m = b.getAttribute('data-mode');
      if (m !== viewMode) applyMode(m);
    });
    updateSwitch();

    // 筛选与排序
    $('f-time').addEventListener('change', function () { filters.time = this.value; reloadAll(); });
    $('f-source').addEventListener('change', function () { filters.source = this.value; reloadAll(); });
    $('f-sort').addEventListener('change', function () { filters.sort = this.value; reloadAll(); });

    // 搜索（300ms 防抖）：桌面顶栏输入框与移动端检索条共用一套筛选状态
    var deb = null;
    function applyKw(v) {
      clearTimeout(deb);
      v = v.trim();
      deb = setTimeout(function () { filters.kw = v; reloadAll(); }, 300);
    }
    [['search-input', 'm-search-input'], ['m-search-input', 'search-input']].forEach(function (pair) {
      var el = $(pair[0]);
      if (!el) return;
      el.addEventListener('input', function () {
        var other = $(pair[1]);
        if (other && other.value !== this.value) other.value = this.value;
        applyKw(this.value);
      });
    });

    // 加载更多 / 重试 / 空态引导
    $('load-more-btn').addEventListener('click', loadMore);
    $('error-retry').addEventListener('click', reloadAll);
    $('btn-upload').addEventListener('click', openUpload);
    $('empty-upload').addEventListener('click', openUpload);

    // 上传弹窗
    $('upload-close').addEventListener('click', closeUpload);
    $('upload-cancel').addEventListener('click', closeUpload);
    $('upload-overlay').addEventListener('click', function (e) {
      if (e.target === this) closeUpload();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if ($('upload-overlay').classList.contains('open')) closeUpload();
        if ($('rename-overlay').classList.contains('open')) closeRename();
      }
    });

    // 重命名弹窗
    $('rename-close').addEventListener('click', closeRename);
    $('rename-cancel').addEventListener('click', closeRename);
    $('rename-save').addEventListener('click', saveRename);
    $('rename-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveRename();
    });
    $('rename-overlay').addEventListener('click', function (e) {
      if (e.target === this) closeRename();
    });

    // 卡片网格：点击铅笔按钮进入重命名，点击相机按钮换封面（拦截 <a> 跳转）
    $('grid').addEventListener('click', function (e) {
      var cov = e.target.closest('[data-cover]');
      if (cov) {
        e.preventDefault();
        e.stopPropagation();
        openCoverFor(cov.getAttribute('data-cover'));
        return;
      }
      var btn = e.target.closest('[data-rename]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      openRename(btn.getAttribute('data-rename'));
    });

    $('drop').addEventListener('click', function () { $('file-input').click(); });
    $('drop').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); }
    });
    // 拖拽导入
    var drop = $('drop');
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('is-over');
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    $('file-input').addEventListener('change', function () {
      if (this.files && this.files.length) addFiles(this.files);
    });
    // 每个文件项的封面位：点一下换一张（弹窗内的委托，列表重绘也不失效）
    $('file-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cov]');
      if (!b) return;
      e.preventDefault();
      pickPendingCover(parseInt(b.getAttribute('data-cov'), 10));
    });
    $('upload-start').addEventListener('click', startUpload);
  }

  // 触屏设备标记：用于把「拖到这里」之类的鼠标提示换成触屏文案
  // （部分国产浏览器内核对 hover 媒体查询支持不一致，这里用能力检测兜底）
  function markTouch() {
    try {
      var mq = window.matchMedia;
      if (!mq) return;
      if (mq('(hover:none)').matches || mq('(pointer:coarse)').matches) {
        document.documentElement.className += ' is-touch';
      }
    } catch (e) { /* 忽略 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { markTouch(); bindDesk(); bind(); start(); });
  } else {
    markTouch(); bindDesk(); bind(); start();
  }
})();
