/* ============================================================
 * play.js — 玩法页（抽卡台）
 * 职责：登录门卫、读取卡池（仅索引行）、主台卡环自动慢转浏览、
 *       点击抽卡进入全屏仪式：卡环加速→减速精确停在正中翻面揭卡、
 *       抽到即自动打卡、打卡簿（今日 / 连续天数 / 最近七天 / 抽卡流水）、
 *       展开整卡预览
 * 抽卡只读索引行与缩略图签名；整卡大文件仅在「展开卡片」时按需下载
 * 打卡数据存本机（按账号隔离），不写入数据库
 * ============================================================ */

(function () {
  'use strict';

  var FC = window.FC;

  var PAGE_LIMIT = 1000;         // 卡池上限（一次拉全量索引行，行很小）
  var STORE_BASE = 'fc_draw_v1'; // 本机打卡数据键前缀（后面拼账号 id）
  var HISTORY_MAX = 40;          // 本机流水最多保留条数
  var RING_MAX = 8;              // 卡环上最多摆几张牌背（卡池再大也只摆 8 张）
  var SPIN_MS = 620;             // 卡环吸附动画时长，与 CSS 保持一致
  var FLIP_MS = 660;             // 翻面动画时长，与 CSS 保持一致
  var AUTO_SPEED = 16;           // 主台卡环默认自转速度（度/秒）
  var VEIL_SPIN_MIN = 4400;      // 全屏洗牌最短时长（毫秒）
  var VEIL_SPIN_VAR = 700;       // 全屏洗牌时长随机增量
  var VEIL_TURNS = 4;            // 全屏洗牌保底整圈数（再随机 +0~1 圈）

  var session = null;
  var pool = [];                 // 全部已解锁卡片（索引行），单池不分组
  var drawing = false;
  var veilOpen = false;          // 全屏抽卡仪式是否展开
  var lastId = null;             // 上一次抽到的卡片 id（用于避免连抽同一张）
  var lastCard = null;           // 当前展示的卡片
  var thumbCache = {};           // path -> 签名 url
  var store = null;              // 本机打卡数据
  var storeKey = STORE_BASE;
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
  var viewerFailed = false;     // 展开卡片进入错误态后，阻止 iframe load 事件把错误页隐藏
  // 登录态失效（401 类）：刷新会话后整轮重试才有意义，网络类错误之外也值得再试一轮
  function isAuth(e) {
    var m = why(e);
    return /401|403|unauthorized|invalid_client|credentials|jwt|token/i.test(m);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ==================== 启动 ==================== */

  async function start() {
    if (!FC.cloudReady) {
      showStageState('云服务不可用', FC.cloudError || '请检查网络后刷新页面。', 'reload');
      FC.hideBoot();
      $('play-view').style.display = '';
      return;
    }

    // 登录门卫：没登录直接回首页（登录表单只在首页），弱网不误踢
    var ses = await FC.session.ensure(2);
    if (!ses.session) {
      if (ses.transient && FC.session.has()) {
        var cachedSession = FC.session.read();
        var uid = cachedSession && cachedSession.user && cachedSession.user.id;
        if (uid && FC.offline && FC.offline.has(uid)) {
          session = cachedSession;
          offlineMode = true;
          FC.offline.setActive(true);
          FC.auth.renderNavUser(session);
          FC.hideBoot();
          $('play-view').style.display = '';
          store = loadStore();
          renderCheckin();
          await loadPool();
          return;
        }
        FC.hideBoot();
        $('play-view').style.display = '';
        showStageState('网络不太稳定', '登录状态暂时没能恢复，本机记录已保留，请检查网络后重试。', 'reload');
        return;
      }
      location.replace('index.html');
      return;
    }

    // 已绑定到主账号的副身份不提供独立收藏，回首页走绑定引导
    var binding = await FC.binding.resolve(ses.session);
    if (binding.bound) { location.replace('index.html'); return; }

    session = ses.session;
    FC.auth.renderNavUser(session);
    FC.hideBoot();
    $('play-view').style.display = '';

    store = loadStore();
    renderCheckin();
    await loadPool();
  }

  /* ==================== 卡池 ==================== */

  async function loadPool() {
    var res;
    try {
      res = await FC.cloud.database.from('cards').select('*')
        .order('created_at', { ascending: false })
        .limit(PAGE_LIMIT);
    } catch (e) {
      res = { error: { message: (e && e.message) || '读取卡池失败' } };
    }
    if (res && res.error) {
      var uid = session && session.user && session.user.id;
      if (uid && FC.offline && FC.offline.has(uid) && FC.offline.shouldFallback(res.error)) {
        pool = FC.offline.all(uid).slice(0, PAGE_LIMIT);
        offlineMode = true;
        FC.offline.setActive(true);
        renderPoolMeta();
        if (!pool.length) {
          showStageState('卡池还是空的', '本机缓存里还没有闪卡。', 'gohome');
          return;
        }
        if (!lastCard) showRing();
        return;
      }
      showStageState('卡池没能取到', FC.errText(res.error, '读取卡池失败，请稍后重试。'), 'retry');
      return;
    }
    pool = (res && res.data) || [];
    offlineMode = false;
    if (FC.offline && session) {
      FC.offline.setActive(false);
      FC.offline.saveRows(session.user.id, pool, true);
    }
    renderPoolMeta();

    if (!pool.length) {
      showStageState('卡池还是空的', '册子里还没有闪卡。先去收藏页导入一张，再回来抽。', 'gohome');
      return;
    }
    if (lastCard) return;        // 抽过卡又重载：保留当前卡面
    showRing();
  }

  function poolOf() {
    return pool;
  }

  function renderPoolMeta() {
    var sub = $('pool-sub');
    if (sub) {
      sub.textContent = pool.length
        ? '从已解锁的 ' + pool.length + ' 张闪卡中随机请出一张'
        : '册子里还没有闪卡';
    }
    var list = poolOf();
    var cnt = $('pool-count');
    if (cnt) cnt.textContent = list.length + ' 张可抽';
    var inBook = $('ck-pool');
    if (inBook) inBook.textContent = pool.length;

    var btn = $('btn-draw');
    if (btn && !drawing) {
      btn.disabled = false;
      btn.textContent = lastCard ? '再 抽 一 张' : '抽 一 张';
    }
  }

  function padNo(id) {
    var s = String(id == null ? '' : id);
    while (s.length < 4) s = '0' + s;
    return 'NO.' + s;
  }

  /* ==================== 卡环（工厂 · 布局与旋转） ==================== */

  // 卡环工厂：主台与全屏仪式各持一个实例，共用摆位与翻面逻辑
  function makeRing(vpId, hostId) {
    var r = { vp: $(vpId), host: $(hostId), n: 0, angle: 0, els: [], cwMax: 116, gap: 92 };

    // 按当前卡池规模摆牌背：1:1、多则取 RING_MAX 张
    r.build = function () {
      var count = poolOf().length;
      var n = Math.max(1, Math.min(count, RING_MAX));
      r.n = n;
      r.els = [];
      r.host.innerHTML = '';
      r.host.classList.remove('is-dragging');

      var step = 360 / n;
      for (var i = 0; i < n; i++) {
        var el = document.createElement('div');
        el.className = 'ring-card';
        el.setAttribute('data-i', i);
        el.innerHTML =
          '<div class="ring-card-inner">' +
          '  <div class="ring-face ring-back">' +
          '    <svg class="ring-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
          '      <path d="M16 3.4 28.6 16 16 28.6 3.4 16Z" stroke="currentColor" stroke-width="1"/>' +
          '      <path d="M16 10.2 21.8 16 16 21.8 10.2 16Z" fill="currentColor" opacity=".9"/>' +
          '    </svg>' +
          '    <i>拾光年</i>' +
          '  </div>' +
          '  <div class="ring-face ring-front">' +
          '    <span class="ring-glyph" aria-hidden="true">·</span>' +
          '    <div class="ring-pic"></div>' +
          '    <span class="ring-inner" aria-hidden="true"></span>' +
          '  </div>' +
          '</div>';
        r.host.appendChild(el);
        r.els.push(el);
      }
      r.layout();
      r.apply(r.angle);
      r.updateFront();
    };

    // 计算卡宽与环半径，给每张卡摆位（rotateY + translateZ）
    r.layout = function () {
      if (!r.n) return;
      var availW = Math.min(r.vp.clientWidth || 320, 560);
      var div = r.div || 5;            // 视口宽的切分系数：越大卡越窄
      var cw = Math.round(Math.min(r.cwMax, Math.max(r.cwMin || 60, (availW - r.gap) / Math.min(r.n, div))));
      var mult = r.n <= 4 ? 0.95 : 0.68;   // 牌少时环大一点，牌多时收紧避免溢出
      var radius = r.n < 3 ? 0 : Math.round((cw * mult) / Math.tan(Math.PI / r.n));
      var step = 360 / r.n;
      r.host.style.setProperty('--ring-cw', cw + 'px');
      r.els.forEach(function (el, i) {
        el.style.transform = 'rotateY(' + (i * step) + 'deg) translateZ(' + radius + 'px)';
      });
    };

    r.apply = function (deg) {
      r.angle = deg;
      r.host.style.transform = 'rotateY(' + deg + 'deg)';
    };

    // 当前转到正前方的卡（rotateY 后世界角度 ≈ 0 的那张）
    r.frontIndex = function () {
      var n = r.n || 1;
      var step = 360 / n;
      var i = Math.round(-r.angle / step) % n;
      if (i < 0) i += n;
      return i;
    };

    r.updateFront = function () {
      if (!r.els.length) return;
      var n = r.n || 1;
      var step = 360 / n;
      var f = r.frontIndex();
      r.els.forEach(function (el, i) {
        el.classList.toggle('is-front', i === f);
        // 世界角度越过 ±90° 即转入后半环：淡出隐藏，避免背面卡牌露出或挡住点击
        var world = ((r.angle + i * step) % 360 + 360) % 360;
        var rear = world > 90 && world < 270;
        el.classList.toggle('is-rear', rear && n > 2);
      });
    };

    r.destroy = function () {
      r.host.innerHTML = '';
      r.n = 0; r.els = [];
    };

    return r;
  }

  var mainRing = null;   // 主台卡环（自动慢转 + 可拖拽）
  var veilRing = null;   // 全屏仪式卡环（洗牌专用）

  // 主台默认自转：rAF 匀速推进；手动操作后暂停片刻再恢复
  var auto = { raf: 0, last: 0, holdUntil: 0 };

  function autoTick(ts) {
    auto.raf = requestAnimationFrame(autoTick);
    if (!mainRing || !mainRing.n) { auto.last = ts; return; }
    if (dragState || drawing || veilOpen || ts < auto.holdUntil) { auto.last = ts; return; }
    var dt = Math.min(80, (ts - auto.last) || 16);
    auto.last = ts;
    mainRing.host.classList.add('is-auto');   // 自转期间关掉 CSS 过渡，转角由 JS 逐帧给出
    mainRing.apply(mainRing.angle + AUTO_SPEED * dt / 1000);
    mainRing.updateFront();
  }

  function rotateRing(dir) {
    if (drawing || veilOpen || !mainRing || mainRing.n < 2) return;
    mainRing.host.classList.remove('is-auto');   // 恢复 CSS 过渡，走吸附动画
    auto.holdUntil = performance.now() + SPIN_MS + 300;
    mainRing.apply(mainRing.angle + dir * (360 / mainRing.n));
    mainRing.updateFront();
  }

  /* ==================== 抽卡（全屏洗牌仪式） ==================== */

  // 先加速、后减速的四次缓动：两端慢、中间快，符合「旋转加速→减速」的手感
  function easeInOutQuart(t) {
    return t < .5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
  }

  // rAF 驱动整段洗牌：落点角度由解析式保证，动画结束即精确对齐。
  // 看门狗兜底：部分移动端内核会限流/停摆 rAF（省电模式、切后台回来、GPU 降级），
  // 一旦超过 500ms 没有帧到来，就改用定时器按真实流逝时间推进，
  // 保证洗牌在移动端「必播完、必落准」，不会卡死在洗牌中。
  function spinTo(r, total, dur) {
    return new Promise(function (resolve) {
      var start = performance.now();
      var from = r.angle;
      var lastFrame = start;
      var lastFront = 0;
      var done = false;

      function settle() {
        if (done) return;
        done = true;
        clearInterval(watchdog);
        r.apply(from + total);          // 精确落位
        r.updateFront();
        resolve();
      }

      function step(now) {
        if (done) return;
        lastFrame = now;
        var t = Math.min(1, (now - start) / dur);
        r.apply(from + total * easeInOutQuart(t));
        // 正前/后半环的高亮切换节流到 ~11fps，弱核手机上省掉每帧重排
        if (now - lastFront > 90 || t >= 1) {
          r.updateFront();
          lastFront = now;
        }
        if (t >= 1) settle();
      }

      var watchdog = setInterval(function () {
        if (done) { clearInterval(watchdog); return; }
        if (performance.now() - lastFrame < 500) return;   // rAF 还活着
        step(performance.now());                            // rAF 饿死：手动推进
      }, 400);

      function frame(now) {
        step(now);
        if (!done) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  async function draw() {
    if (drawing || veilOpen) return;
    var list = poolOf();
    if (!list.length) {
      FC.toast(pool.length ? '这个卡池里还没有卡片，换个范围试试' : '卡池是空的，先到收藏页导入闪卡', 'err');
      return;
    }
    drawing = true;
    var btn = $('btn-draw');
    btn.disabled = true;
    btn.textContent = '洗 牌 中';
    $('btn-open').disabled = true;   // 抽卡途中不让人点开上一张

    // 1. 全屏仪式开幕
    var veil = $('draw-veil');
    veilOpen = true;
    veil.classList.add('open', 'is-spinning');
    $('dv-title').textContent = '命运洗牌中';
    $('dv-hint').style.display = '';
    var dvDrawn = $('dv-drawn');
    dvDrawn.hidden = true;
    dvDrawn.classList.remove('is-in');
    $('dv-actions').hidden = true;
    await wait(380);                 // 等开幕淡入

    // 2. 重建大卡环，随机决定中奖卡与落点槽位
    if (!veilRing) {
      veilRing = makeRing('dv-viewport', 'dv-ring');
      veilRing.cwMin = 128;      // 全屏仪式用更大的卡面
      veilRing.cwMax = 176;
      veilRing.gap = 44;
      veilRing.div = 3.2;
    }
    veilRing.host.style.display = '';
    veilRing.build();
    await wait(80);

    var card = pick(list);
    lastCard = card;
    lastId = card.id;
    var streakNow = markChecked(card);   // 结果既定即刻打卡：不依赖动画播完，桌面/移动/旧缓存都稳

    var n = veilRing.n;
    var step = 360 / n;
    var slot = Math.floor(Math.random() * n);        // 最终停在正中的槽位
    var target = -slot * step;                       // 该槽位对齐正前方的规范角度
    var delta = ((target - veilRing.angle) % 360 + 360) % 360;
    var total = delta + (VEIL_TURNS + Math.floor(Math.random() * 2)) * 360;
    var dur = VEIL_SPIN_MIN + Math.floor(Math.random() * VEIL_SPIN_VAR);
    await spinTo(veilRing, total, dur);              // 加速 → 高速 → 减速
    veilRing.apply(target);                          // 精确吸附到正中那张
    veilRing.updateFront();
    veil.classList.remove('is-spinning');
    await wait(280);

    // 3. 翻面揭卡：正中这张就是抽卡结果（渲染异常不阻塞结果操作，打卡已在开局完成）
    var cardEl = veilRing.els[slot];
    try {
      cardEl.classList.remove('is-flipped', 'has-pic');
      cardEl.querySelector('.ring-pic').innerHTML = '';
      cardEl.querySelector('.ring-glyph').textContent = (card.name || '').trim().slice(0, 1) || '·';
      paintPlate(card, 'dv-');
    } catch (e) { /* 单卡面渲染异常不阻塞 */ }

    void cardEl.offsetWidth;         // 强制重排，保证翻面动画每次都能重播
    cardEl.classList.add('is-flipped');

    await wait(Math.round(FLIP_MS * 0.72));   // 等卡面转过一半再亮铭牌
    try {
      $('dv-hint').style.display = 'none';
      $('dv-title').textContent = '就是这张';
      dvDrawn.hidden = false;
      void dvDrawn.offsetWidth;
      dvDrawn.classList.add('is-in');
      loadThumb(card, cardEl);
    } catch (e) { /* 揭卡渲染异常不阻塞 */ }

    // 4. 结果操作（打卡提示延到揭卡时播报，避免被全屏遮罩挡住）
    if (streakNow > 0) FC.toast('打卡成功 · 连续 ' + streakNow + ' 天', 'ok');
    $('dv-detail').href = 'detail.html?id=' + card.id;
    $('dv-actions').hidden = false;
    var closeBtn = $('dv-close');
    if (closeBtn) closeBtn.focus();
  }

  // 收下结果：闭幕回到主台，主台继续自动转，按钮态同步
  function closeVeil() {
    if (!veilOpen) return;
    veilOpen = false;
    $('draw-veil').classList.remove('open', 'is-spinning');
    if (veilRing) veilRing.destroy();
    if (mainRing && mainRing.n) mainRing.build();   // 重摆主台卡环（洗掉残留翻面）
    var btn = $('btn-draw');
    btn.disabled = false;
    btn.textContent = '再 抽 一 张';
    $('btn-open').style.display = '';
    $('btn-open').disabled = false;
    if (lastCard) {
      var link = $('link-detail');
      link.href = 'detail.html?id=' + lastCard.id;
      link.style.display = '';
    }
    renderPoolMeta();
    drawing = false;
  }

  // 随机取一张：卡池大于 1 时尽量避免连续两次抽到同一张
  function pick(list) {
    if (list.length === 1) return list[0];
    var c, guard = 0;
    do {
      c = list[Math.floor(Math.random() * list.length)];
      guard++;
    } while (lastId != null && c.id === lastId && guard < 12);
    return c;
  }

  // 铭牌内容（翻面揭示时亮出）；pfx 区分主台 / 全屏仪式两套铭牌
  function paintPlate(c, pfx) {
    $(pfx + 'no').textContent = padNo(c.id);
    $(pfx + 'src').textContent = c.source || '上传导入';
    $(pfx + 'name').textContent = c.name || '未命名闪卡';
    $(pfx + 'mat').textContent = '独一无二 · Unique';
  }

  async function loadThumb(card, cardEl) {
    if (!card.thumb_path) return;     // 无封面 → 用「字形 + 刻线」版式，同样是一张完整卡面
    var url = thumbCache[card.thumb_path];
    try {
      var uid = session && session.user && session.user.id;
      if (!url && FC.offline && uid) url = await FC.offline.thumbUrl(uid, card.thumb_path);
      if (!url && !offlineMode) {
        url = await FC.signedUrl(card.thumb_path, 3600);
        if (FC.offline && uid) FC.offline.primeThumb(uid, card.thumb_path, url);
      }
      if (url) thumbCache[card.thumb_path] = url;
    } catch (e) {
      return;                          // 封面拿不到不影响抽卡结果
    }
    if (lastCard && lastCard.id !== card.id) return;   // 期间又抽了一张，丢弃旧图
    var img = new Image();
    img.alt = '';
    img.onload = function () {
      if (lastCard && lastCard.id !== card.id) return;
      var pic = cardEl.querySelector('.ring-pic');
      if (!pic) return;
      pic.innerHTML = '';
      pic.appendChild(img);
      requestAnimationFrame(function () { img.classList.add('loaded'); });
      cardEl.classList.add('has-pic');
    };
    img.onerror = function () {
      // 签名链接过期/失效：重签一次再试，仍失败则保持字形版式卡面
      img.onerror = null;
      if (offlineMode) return;
      FC.signedUrl(card.thumb_path, 3600).then(function (u2) {
        if (lastCard && lastCard.id !== card.id) return;
        thumbCache[card.thumb_path] = u2;
        img.src = u2;
      }).catch(function () { /* 保持版式卡面 */ });
    };
    img.src = url;
  }

  /* ==================== 打卡簿（本机存储） ==================== */

  function dayKey(d) {
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function loadStore() {
    var uid = (session && session.user && session.user.id) || 'anon';
    storeKey = STORE_BASE + ':' + uid;
    var s = null;
    try { s = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch (e) { s = null; }
    if (!s || typeof s !== 'object') s = {};
    if (!s.days || typeof s.days !== 'object') s.days = {};
    if (!Array.isArray(s.history)) s.history = [];
    // 老数据没有累计字段：按已有打卡记录回填一次
    if (typeof s.total !== 'number') {
      var t = 0;
      for (var k in s.days) {
        if (Object.prototype.hasOwnProperty.call(s.days, k)) t += (s.days[k] && s.days[k].n) || 0;
      }
      s.total = t;
    }
    return s;
  }

  function saveStore() {
    try {
      localStorage.setItem(storeKey, JSON.stringify(store));
    } catch (e) { /* 无痕模式写不进去：本次会话仍可正常抽，只是不持久 */ }
  }

  function streakDays() {
    var d = new Date();
    // 今天还没打卡时，从昨天开始往回数，避免一睁眼就被判「已中断」
    if (!store.days[dayKey(d)]) d.setDate(d.getDate() - 1);
    var n = 0;
    while (store.days[dayKey(d)] && n < 3650) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  function markChecked(card) {
    var today = dayKey(new Date());
    var rec = store.days[today];
    var firstToday = !rec;
    if (!rec) { rec = store.days[today] = { n: 0, cards: [], first: null }; }
    if (!Array.isArray(rec.cards)) rec.cards = [];
    rec.n = (rec.n || 0) + 1;
    rec.cards.push(card.id);
    if (!rec.first) rec.first = { id: card.id, name: card.name || '未命名闪卡' };

    store.history.unshift({
      id: card.id,
      name: card.name || '未命名闪卡',
      ts: Date.now()
    });
    if (store.history.length > HISTORY_MAX) store.history.length = HISTORY_MAX;
    store.total = (store.total || 0) + 1;
    saveStore();
    renderCheckin();
    flashCheckin();

    // 返回值：首打卡时返回连续天数（供揭卡时播报），当日已打过返回 0
    return firstToday ? streakDays() : 0;
  }

  function flashCheckin() {
    var el = $('checkin');
    el.classList.remove('is-fresh');
    void el.offsetWidth;
    el.classList.add('is-fresh');
  }

  function renderCheckin() {
    if (!store) return;
    var today = dayKey(new Date());
    var rec = store.days[today];

    $('ck-streak-n').textContent = streakDays();

    var box = $('ck-today');
    if (rec) {
      box.classList.add('is-done');
      box.innerHTML =
        '<span class="ck-dot" aria-hidden="true"></span>' +
        '<p>今日已打卡 · 已抽 <b>' + rec.n + '</b> 张，首抽「' + esc((rec.first && rec.first.name) || '—') + '」</p>';
    } else {
      box.classList.remove('is-done');
      box.innerHTML =
        '<span class="ck-dot" aria-hidden="true"></span>' +
        '<p>今日尚未打卡。抽一张，系统会<b>自动</b>记入。</p>';
    }

    renderWeek(today);
    renderHistory();

    $('ck-total').textContent = store.total || 0;
    $('ck-days').textContent = Object.keys(store.days).length;
  }

  function renderWeek(today) {
    var html = '';
    var d = new Date();
    d.setDate(d.getDate() - 6);
    for (var i = 0; i < 7; i++) {
      var k = dayKey(d);
      var on = !!store.days[k];
      var isToday = k === today;
      html +=
        '<div class="ck-cell' + (on ? ' on' : '') + (isToday ? ' today' : '') + '"' +
        ' title="' + k + (on ? ' 已打卡' : ' 未打卡') + '">' +
        '  <i aria-hidden="true"></i>' +
        '  <span>' + (d.getMonth() + 1) + '/' + d.getDate() + '</span>' +
        '</div>';
      d.setDate(d.getDate() + 1);
    }
    $('ck-week').innerHTML = html;
  }

  function renderHistory() {
    var host = $('ck-list');
    if (!store.history.length) {
      host.innerHTML = '<li class="ck-empty">还没有抽卡记录。抽第一张，今天就算打卡。</li>';
      return;
    }
    var html = '';
    store.history.slice(0, 10).forEach(function (h) {
      html +=
        '<li class="ck-item">' +
        '  <span class="ck-time">' + timeLabel(h.ts) + '</span>' +
        '  <a class="ck-name" href="detail.html?id=' + h.id + '">' + esc(h.name) + '</a>' +
        '</li>';
    });
    host.innerHTML = html;
  }

  function timeLabel(ts) {
    var d = new Date(ts);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    var hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (dayKey(d) === dayKey(new Date())) return '今日 ' + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  /* ==================== 舞台状态（卡环 / 空态 / 错误） ==================== */

  function showRing() {
    $('stage-state').hidden = true;
    $('stage-state').innerHTML = '';
    $('ring-wrap').style.display = '';
    $('ring-hint').style.display = '';
    $('ring').style.display = '';
    if (!mainRing) mainRing = makeRing('ring-viewport', 'ring');
    mainRing.angle = 0;
    mainRing.build();
    mainRing.host.classList.add('is-auto');   // 默认进入自动慢转展示
    $('btn-draw').disabled = false;
    $('btn-draw').textContent = '抽 一 张';
    $('btn-open').style.display = 'none';
    $('link-detail').style.display = 'none';
  }

  function showStageState(title, desc, action) {
    var host = $('stage-state');
    if (!host) return;
    $('ring-wrap').style.display = 'none';
    $('ring-hint').style.display = 'none';
    $('btn-draw').disabled = true;
    $('btn-open').style.display = 'none';
    $('link-detail').style.display = 'none';

    var label = action === 'gohome' ? '去导入闪卡' : (action === 'retry' ? '重试' : '刷新页面');
    host.innerHTML =
      '<h3>' + esc(title) + '</h3>' +
      '<p>' + esc(desc) + '</p>' +
      '<button class="btn btn-ghost" id="stage-state-btn" type="button">' + label + '</button>';
    host.hidden = false;

    var b = $('stage-state-btn');
    if (!b) return;
    b.onclick = function () {
      if (action === 'gohome') location.href = 'index.html';
      else if (action === 'retry') {
        host.hidden = true;
        loadPool();
      } else location.reload();
    };
  }

  /* ==================== 展开卡片（三通道降级） ==================== */

  var V_MODES = ['标准模式', '兼容模式', '直连模式'];
  var vMode = 0, vBlob = null, vText = null, vBlobUrl = null;

  function blobToText(blob) {
    return new Promise(function (resolve, reject) {
      if (typeof blob.text === 'function') { blob.text().then(resolve, reject); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsText(blob);
    });
  }

  async function ensureBlob() {
    if (vBlob) return vBlob;
    // FC.loadCardBlob：IndexedDB 缓存优先（命中零网络）+ 双通道稳健下载，成功后自动写缓存
    var raw = await FC.loadCardBlob(lastCard, function (m) {
      var h = document.querySelector('#viewer-loading .hint');
      if (h) h.textContent = m;
    });
    vBlob = new Blob([raw], { type: 'text/html; charset=utf-8' });
    return vBlob;
  }

  async function renderViewer(m) {
    var f = $('viewer-frame');
    try { f.removeAttribute('srcdoc'); } catch (e) { /* 忽略 */ }
    f.src = 'about:blank';
    if (m === 0) {
      if (!vText) vText = await blobToText(await ensureBlob());
      f.srcdoc = vText;
    } else if (m === 1) {
      if (!vBlobUrl) vBlobUrl = URL.createObjectURL(await ensureBlob());
      f.src = vBlobUrl;
    } else {
      f.src = await FC.signedUrl(lastCard.card_path, 3600);
    }
    vMode = m;
  }

  async function openViewer() {
    if (!lastCard) return;
    viewerFailed = false;
    vMode = 0; vBlob = null; vText = null; vBlobUrl = null;
    $('viewer-title').textContent = lastCard.name || '全息闪卡';
    var loading = $('viewer-loading');
    loading.style.display = '';
    var hint = loading.querySelector('.hint');
    if (hint) {
      hint.textContent = '正在加载全息卡片' +
        (lastCard.size_bytes ? '（约 ' + FC.formatBytes(lastCard.size_bytes) + '）' : '') +
        '，首次打开可能需要几秒钟…';
    }
    $('viewer').classList.add('open');

    var reasons = [];
    var lastErr = null;
    var netFail = false, authFail = false;
    for (var round = 0; round < 2; round++) {
      reasons.length = 0;
      lastErr = null;
      netFail = false; authFail = false;
      var skipBlob = false;
      for (var m = 0; m < 3; m++) {
        // 通道 0 的下载请求已断，通道 1 复用同一个 ensureBlob，必然同样失败，不再重复发大文件请求
        if (m === 1 && skipBlob) continue;
        try {
          await renderViewer(m);
          return;
        } catch (e) {
          var msg = why(e);
          if (msg && reasons.indexOf(msg) < 0) reasons.push(msg);
          if (!why(lastErr)) lastErr = e;
          if (isNet(e)) {
            netFail = true;
            if (m === 0 && !vBlob) skipBlob = true;
          }
          if (isAuth(e)) authFail = true;
          console.warn('加载通道 ' + V_MODES[m] + ' 失败', msg);
        }
      }
      if (round === 0 && (netFail || authFail)) {
        await wait(600);
        try { await FC.session.ensure(1); } catch (e) { /* 会话刷新失败不阻断重试 */ }
      } else break;
    }
    viewerFailed = true;
    var reason = reasons.length
      ? reasons.slice(0, 3).map(function (s) { return s.length > 110 ? s.slice(0, 110) + '…' : s; }).join('　·　')
      : why(lastErr);
    loading.style.display = '';
    loading.innerHTML = '<p style="font-size:14px;color:var(--danger)">卡片文件暂时无法访问，请稍后重试。</p>' +
      (reason ? '<p style="font-size:11px;line-height:1.7;color:rgba(239,233,220,.66);max-width:min(88%,520px);word-break:break-word">' + esc(reason) + '</p>' : '') +
      '<button class="btn btn-ghost" id="viewer-retry" type="button">刷新重试</button>';
    var rb = $('viewer-retry');
    if (rb) rb.onclick = function () { openViewer(); };
  }

  async function switchViewerMode() {
    if (!lastCard) return;
    var next = (vMode + 1) % 3;
    try {
      await renderViewer(next);
      FC.toast('已切换为' + V_MODES[next], 'ok');
    } catch (e) {
      FC.toast('切换失败：' + FC.errText(e, '请稍后重试'), 'err');
      $('viewer-loading').style.display = '';
    }
  }

  function closeViewer() {
    $('viewer').classList.remove('open');
    var f = $('viewer-frame');
    try { f.removeAttribute('srcdoc'); } catch (e) { /* 忽略 */ }
    f.src = 'about:blank';
    vBlob = null; vText = null;
    if (vBlobUrl) {
      try { URL.revokeObjectURL(vBlobUrl); } catch (e) { /* 忽略 */ }
      vBlobUrl = null;
    }
  }

  /* ==================== 事件 ==================== */

  // 主台卡环拖拽旋转（桌面鼠标 + 手机触摸统一走 Pointer 事件）
  var dragState = null, dragMoved = false, lastTapTs = 0;

  function bindRing() {
    var vp = $('ring-viewport');

    vp.addEventListener('pointerdown', function (e) {
      if (drawing || veilOpen) return;
      if (e.button != null && e.button !== 0) return;
      dragState = {
        x: e.clientX, angle: mainRing.angle, id: e.pointerId,
        onCard: !!e.target.closest('.ring-card')
      };
      dragMoved = false;
      if (mainRing.n >= 2) {
        vp.classList.add('is-dragging');
        try { vp.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
      }
    });
    vp.addEventListener('pointermove', function (e) {
      if (!dragState || e.pointerId !== dragState.id || mainRing.n < 2) return;
      var dx = e.clientX - dragState.x;
      if (Math.abs(dx) > 6) dragMoved = true;
      if (!dragMoved) return;
      mainRing.host.classList.add('is-dragging');
      mainRing.apply(dragState.angle + dx * 0.4);
    });
    vp.addEventListener('pointerup', function (e) {
      if (!dragState || (e.pointerId != null && e.pointerId !== dragState.id)) return;
      var wasTap = !dragMoved && dragState.onCard;   // 按下即起、没有拖动 = 点按
      if (mainRing.n >= 2) {
        var step = 360 / mainRing.n;
        mainRing.host.classList.remove('is-auto', 'is-dragging');   // 恢复过渡做吸附
        mainRing.apply(Math.round(mainRing.angle / step) * step);   // 松手吸附到最近的卡位
        mainRing.updateFront();
        auto.holdUntil = performance.now() + SPIN_MS + 320;          // 吸附完再恢复自转
      }
      dragState = null;
      if (wasTap) {
        // 指针捕获后 click 会被重定向到 viewport，所以点按判定放在 pointerup
        lastTapTs = Date.now();
        draw();
      }
    });
    vp.addEventListener('pointercancel', function (e) {
      if (!dragState || (e.pointerId != null && e.pointerId !== dragState.id)) return;
      dragState = null;
      vp.classList.remove('is-dragging');
    });

    // 兜底：不支持 Pointer 事件的老浏览器走 click（现代浏览器的点按已在 pointerup 处理过）
    vp.addEventListener('click', function (e) {
      if (Date.now() - lastTapTs < 500) return;
      if (!e.target.closest('.ring-card') || drawing || veilOpen) return;
      draw();
    });
  }

  function bind() {
    bindRing();
    requestAnimationFrame(function (ts) { auto.last = ts; autoTick(ts); });

    $('ring-prev').addEventListener('click', function () { rotateRing(-1); });
    $('ring-next').addEventListener('click', function () { rotateRing(1); });
    $('btn-draw').addEventListener('click', draw);
    $('btn-open').addEventListener('click', openViewer);

    $('dv-close').addEventListener('click', closeVeil);
    $('dv-open').addEventListener('click', openViewer);

    $('viewer-close').addEventListener('click', closeViewer);
    $('viewer-mode').addEventListener('click', switchViewerMode);
    $('viewer-frame').addEventListener('load', function () {
      if (!viewerFailed) $('viewer-loading').style.display = 'none';
    });

    document.addEventListener('keydown', function (e) {
      if (veilOpen) {
        // 全屏仪式：结果揭示后才允许 Esc 收下
        if (e.key === 'Escape' && !$('dv-actions').hidden) closeVeil();
        return;
      }
      if (e.key === 'Escape' && $('viewer').classList.contains('open')) { closeViewer(); return; }
      if ($('viewer').classList.contains('open')) return;
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') rotateRing(-1);
      else if (e.key === 'ArrowRight') rotateRing(1);
    });

    // 视口宽度变化时重算卡宽与环半径（保留当前角度）
    var rzTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(function () {
        if (mainRing) mainRing.layout();
        if (veilRing && veilOpen) veilRing.layout();
      }, 180);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(); start(); });
  } else {
    bind(); start();
  }
})();
