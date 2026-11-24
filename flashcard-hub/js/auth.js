/* ============================================================
 * auth.js — 登录/登出 + OAuth 回调分发
 * 登录方式：手机验证码 OTP / 邮箱验证码 OTP（默认契约）+ 微信登录
 * 数据隔离由数据库 RLS 保证，前端只做会话判断，不传 owner_id
 * ============================================================ */

(function () {
  'use strict';

  var FC = window.FC;
  var state = {
    method: 'phone',          // 'phone' | 'email'
    pendingOtp: null,         // {phone|email, verificationId, isExistingUser}
    countdown: 0,
    opts: null,               // boot 传入的视图回调，重试恢复登录态时复用
    restoring: false,
    listening: false,         // 是否已注册会话变化监听（避免重复注册）
    submitting: false         // 登录提交防重入锁：验证码换会话是一次性操作，
                              // 并发提交会让第二次 signin 拿到 invalid_grant
  };

  /* ---------------- 会话恢复 + OAuth 回调分发 ----------------
   * 必须在任何路由判断之前执行：微信/WorkBuddy 回调带着一次性 code，
   * 登录态判断若先行跳转会作废该 code。 */
  async function boot(opts) {
    state.opts = opts || {};
    if (!FC.cloudReady) {
      // SDK 未就绪：先展示登录视图承载错误信息，避免用户面对空白页
      if (opts.onSignedOut) opts.onSignedOut();
      FC.hideBoot();
      showLoginError(FC.cloudError || '云服务不可用，请检查网络后刷新页面。');
      return;
    }
    var url = new URL(location.href);

    // 普通访问：没有 code / error 参数，直接恢复已有会话
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
      await continueStartup(opts);
      return;
    }

    // 授权回调：按 provider 分发到对应处理器
    var provider = url.searchParams.get('provider');
    if (provider !== 'workbuddy' && provider !== 'wechat') {
      FC.hideBoot();
      showLoginError('授权回调缺少有效的登录方式，请重新登录。');
      return;
    }
    var handle = provider === 'workbuddy'
      ? FC.cloud.auth.handleWorkBuddyCallback
      : FC.cloud.auth.handleWechatWebCallback;
    if (typeof handle !== 'function') {
      FC.hideBoot();
      showLoginError('暂时无法使用此方式登录，请联系应用管理员。');
      return;
    }
    var res = await handle.call(FC.cloud.auth);
    if (res.error) {
      FC.hideBoot();
      showLoginError(res.error.message);
    } else if (res.data) {
      // 成功：清掉一次性回调参数，保留业务参数，避免刷新时重放已消费的 code
      for (var key of ['code', 'state', 'provider']) url.searchParams.delete(key);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      await notifySignedIn(opts);
    } else {
      await continueStartup(opts);
    }
  }

  /* 启动时的登录态判断：同一台设备只要本机留着登录记录就不再打扰用户。
   * 只有「确认未登录 / 凭据已被服务端拒绝」才真正退回登录视图；
   * 网络类失败会先重试，再把本机记录保留着给出重试入口。 */
  async function continueStartup(opts) {
    var out = await FC.session.ensure(2);   // 内部已含：cookie 镜像回填 + 强制刷新 + 退避重试

    if (out.session) {
      await notifySignedIn(opts);
      return;
    }

    FC.hideBoot();

    // 本机记录还在 = 这次只是没取回会话（弱网/服务端抖动），别让用户重新收验证码
    if (out.transient && FC.session.has()) {
      var cachedSession = FC.session.read();
      var cachedUid = cachedSession && cachedSession.user && cachedSession.user.id;
      if (opts.onOffline && cachedUid && FC.offline && FC.offline.has(cachedUid)) {
        await opts.onOffline(cachedSession);
        return;
      }
      if (opts.onSignedOut) opts.onSignedOut();
      showRetryRestore('网络不太稳定，登录状态暂时没取回来（本机记录已保留）。点这里重试 →');
      return;
    }

    // 走到这里说明服务端拒绝了这份凭据，SDK 也已清掉本机记录 → 彻底清理后回登录视图
    FC.session.clear();
    // SDK 的 abandon() 会经 sessionStore.removeItem 把死会话搬进回收站；
    // 这里必须一并清掉，否则下次启动 restoreFromTrash 又复活这枚已被服务端
    // 拒绝的 token，造成「每次打开都重新登录 / 登录后又被踢」的循环。
    FC.session.purgeTrash();
    if (opts.onSignedOut) opts.onSignedOut();
  }

  /* 手动重试：不清本地记录，再走一次恢复流程 */
  async function retryRestore() {
    if (state.restoring) return;
    var box = $('login-err');
    state.restoring = true;
    if (box) {
      box.onclick = null;
      box.textContent = '正在重新恢复登录状态…';
      box.classList.add('show');
    }
    var out = await FC.session.ensure(2);
    state.restoring = false;
    if (out.session) {
      clearLoginError();
      var opts = state.opts || {};
      await notifySignedIn(opts);
      return;
    }
    if (FC.session.has() && out.transient) {
      var cachedSession = FC.session.read();
      var cachedUid = cachedSession && cachedSession.user && cachedSession.user.id;
      var opts = state.opts || {};
      if (opts.onOffline && cachedUid && FC.offline && FC.offline.has(cachedUid)) {
        await opts.onOffline(cachedSession);
        return;
      }
      showRetryRestore('还是没连上，登录状态仍保留在本机。点这里再试一次 →');
    } else {
      FC.session.clear();
      FC.session.purgeTrash();
      showLoginError('登录状态已失效，请重新登录。');
    }
  }

  function showRetryRestore(msg) {
    var box = $('login-err');
    if (!box) { FC.toast(msg, 'err'); return; }
    box.textContent = msg;
    box.classList.add('show');
    box.style.cursor = 'pointer';
    box.onclick = retryRestore;
  }

  async function notifySignedIn(opts) {
    // 会话变化时同步切换视图（登出时回到登录页）；只注册一次，重试恢复不会叠加监听
    if (!state.listening) {
      state.listening = true;
      FC.cloud.auth.onAuthStateChange(function (event, session) {
        if (event === 'SIGNED_OUT' && state.opts && state.opts.onSignedOut) state.opts.onSignedOut();
      });
    }
    if (opts.onSignedIn) await opts.onSignedIn();
    FC.hideBoot();
  }

  /* ---------------- 登录表单 ---------------- */

  function $(id) { return document.getElementById(id); }

  function showLoginError(msg) {
    // 统一翻译兜底：任何路径冒出的服务端英文原文（the session is invalid /
    // invalid_grant / Credentials missing ...）都不再直接泄漏到登录页。
    // friendlyError 对已是中文的提示原样返回，不影响现有文案。
    var raw = String(msg || '');
    var text = (FC && typeof FC.friendlyError === 'function')
      ? FC.friendlyError(raw) : raw;
    var box = $('login-err');
    if (!box) { FC.toast(text, 'err'); return; }

    // 诊断增强：中文提示下方以小字附上「翻译前原文 + 时间」。这样用户只需
    // 截一张红条图，就能看到触发「登录失效」的原始错误（哪条请求、什么码），
    // 不必再依赖连点浮层（真机上一直打不开）。原文可长按选中复制。
    var rawList = (window.FC && typeof FC.rawErrors === 'function') ? FC.rawErrors() : null;
    var src = (rawList && rawList.length) ? rawList[rawList.length - 1] : null;
    var showRaw = '';
    if (src && src.raw && src.raw !== text && raw !== src.raw) {
      showRaw = String(src.raw).slice(0, 240);
    } else if (raw && raw !== text) {
      showRaw = raw.slice(0, 240);
    }
    box.innerHTML = '';
    box.appendChild(document.createTextNode(text));
    if (showRaw) {
      var detail = document.createElement('div');
      detail.className = 'login-err-raw';
      detail.style.cssText = 'margin-top:6px;font-size:11px;line-height:1.5;opacity:.72;' +
        'font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;' +
        'user-select:text;-webkit-user-select:text';
      detail.textContent = '原文(' + (src && src.t ? src.t : new Date().toTimeString().slice(0, 8)) + ')：' + showRaw;
      box.appendChild(detail);
      // 诊断按钮：即使连点入口失效，也能从这里打开网络诊断浮层
      var diagBtn = document.createElement('button');
      diagBtn.type = 'button';
      diagBtn.textContent = '诊断详情';
      diagBtn.className = 'login-err-raw';
      diagBtn.style.cssText = 'margin-top:8px;font-size:11px;padding:4px 10px;cursor:pointer;' +
        'background:rgba(255,255,255,.12);border:1px solid currentColor;border-radius:4px;color:inherit';
      diagBtn.onclick = function (e) {
        e.stopPropagation();
        if (window.FC && typeof FC.showDiagnose === 'function') FC.showDiagnose();
      };
      box.appendChild(diagBtn);
    }
    box.classList.add('show');
    box.onclick = null;          // 普通错误提示不可点，避免继承上一次「点此重试」的行为
    box.style.cursor = '';
  }
  function clearLoginError() {
    var box = $('login-err');
    if (box) {
      box.textContent = '';
      box.classList.remove('show');
      box.onclick = null;
      box.style.cursor = '';
    }
  }

  function switchMethod(method) {
    state.method = method;
    state.pendingOtp = null;
    clearLoginError();
    $('tab-phone').classList.toggle('active', method === 'phone');
    $('tab-email').classList.toggle('active', method === 'email');
    $('row-phone').style.display = method === 'phone' ? '' : 'none';
    $('row-email').style.display = method === 'email' ? '' : 'none';
  }

  function startCountdown() {
    state.countdown = 60;
    var btn = $('otp-btn');
    btn.disabled = true;
    var tick = function () {
      if (state.countdown <= 0) {
        btn.disabled = false;
        btn.textContent = '重新获取';
        return;
      }
      btn.textContent = state.countdown + 's 后重发';
      state.countdown--;
      setTimeout(tick, 1000);
    };
    tick();
  }

  /* 把服务端 OTP 错误翻译为用户能行动的提示 */
  function otpErrorText(err) {
    var msg = (err && err.message) || '';
    if (/frequen|rate|limit|too\s*many|过频|频繁/i.test(msg)) {
      return '发送太频繁，请等待一分钟后再试。';
    }
    if (/invalid|格式|号码|邮箱/i.test(msg) && !/expire/i.test(msg)) {
      return '账号格式不正确，请检查后重新输入。';
    }
    if (/signature|模板|额度|balance|quota/i.test(msg)) {
      return '短信通道暂时不可用，请改用邮箱验证码登录，或稍后再试。';
    }
    return FC.friendlyError(msg) || '验证码发送失败，请稍后重试。';
  }

  /* 发送成功后：按通道给出针对性的“收不到怎么办”指引 */
  function showReceiveHint(method) {
    var hint = $('code-hint');
    if (!hint) return;
    hint.style.color = 'var(--stone)';
    if (method === 'phone') {
      hint.textContent = '若 1 分钟内未收到：请检查短信是否被手机管家/安全软件拦截（含「垃圾短信」分类），虚拟运营商号段（162/165/167 等）可能收不到，可改用邮箱验证码。';
    } else {
      hint.textContent = '若 1 分钟内未收到：请到邮箱的「垃圾邮件/广告邮件」文件夹查找，发件人含 workbuddy；仍未收到请稍后重发。';
    }
  }

  // 发送验证码：发送与校验是两个独立动作，challenge 保存在事件外
  async function sendCode() {
    clearLoginError();
    var hintBox = $('code-hint');
    if (hintBox) { hintBox.textContent = ''; hintBox.style.color = ''; }
    var method = state.method;
    if (method === 'phone') {
      var phone = ($('login-phone').value || '').trim();
      if (!/^1\d{10}$/.test(phone)) {
        $('phone-hint').textContent = '请输入正确的 11 位手机号';
        return;
      }
      $('phone-hint').textContent = '';
      var sent = await FC.cloud.auth.sendOtp({ phone: phone });
      if (sent.error) { showLoginError(otpErrorText(sent.error)); return; }
      state.pendingOtp = { phone: phone, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser };
    } else {
      var email = ($('login-email').value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        $('email-hint').textContent = '请输入正确的邮箱地址';
        return;
      }
      $('email-hint').textContent = '';
      var sent2 = await FC.cloud.auth.sendOtp({ email: email });
      if (sent2.error) { showLoginError(otpErrorText(sent2.error)); return; }
      state.pendingOtp = { email: email, verificationId: sent2.data.verificationId, isExistingUser: sent2.data.isExistingUser };
    }
    startCountdown();
    showReceiveHint(method);
    FC.toast('验证码已发送，请查收（注意拦截与垃圾箱）', 'ok');
  }

  // 提交登录：校验码错误时保留 challenge 供重试，不发新码
  async function submitLogin() {
    // 防重入：手机输入法回车 + 按钮 click 常在同一次输入里各触发一遍，
    // 两次 verifyOtp 并发 → 服务端第一次 signin 消费掉 verification_token，
    // 第二次 signin 返回 invalid_grant「issued for another client」，
    // 正是真机诊断里「verify 200 + signin 401 同一秒」的根因。加锁杜绝并发。
    if (state.submitting) return;
    state.submitting = true;
    var btn = $('login-submit');
    var originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }

    try {
      clearLoginError();
      var pending = state.pendingOtp;
      var code = ($('login-code').value || '').trim();
      if (!pending) { showLoginError('请先获取验证码'); return; }
      if (!/^\d{4,8}$/.test(code)) { showLoginError('请输入收到的验证码'); return; }

      var payload;
      if (pending.phone) {
        if (state.method !== 'phone') { showLoginError('请先获取当前手机号的验证码'); return; }
        payload = { phone: pending.phone, verificationId: pending.verificationId, isExistingUser: pending.isExistingUser, token: code };
      } else {
        if (state.method !== 'email') { showLoginError('请先获取当前邮箱的验证码'); return; }
        payload = { email: pending.email, verificationId: pending.verificationId, isExistingUser: pending.isExistingUser, token: code };
      }

      var done = await FC.cloud.auth.verifyOtp(payload);
      if (done.error) {
        var em = String(done.error.message || '');
        // 会话失效/凭据作废类错误：这枚验证码换会话已被服务端拒绝（可能已被
        // 上一次提交消费），继续用它重试永远失败。清掉 pending，引导重新发码。
        if (/session is invalid|invalid_grant|expired or issued|credentials missing/i.test(em)) {
          state.pendingOtp = null;
          showLoginError('本次验证码已失效，请重新获取验证码后再登录。');
          var cd = $('code-hint');
          if (cd) { cd.textContent = '验证码已作废，请点「重新发送验证码」。'; cd.style.color = 'var(--stone)'; }
          return;
        }
        // 普通验证码错误：challenge 继续有效，提示后允许直接重试。
        // 传原始 message 给 showLoginError，由其统一翻译并在红条附原文供排障。
        showLoginError(done.error.message);
        return;
      }
      // 成功后立即清空 pending，即使锁因异常提前释放，也不会用同一验证码二次换会话
      state.pendingOtp = null;
      FC.toast('登录成功', 'ok');
      window.location.reload(); // 统一走一次启动流程，保证会话状态干净
    } finally {
      state.submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = originalText || '进入收藏馆'; }
    }
  }

  /* ---------------- 微信登录（OAuth 跳转） ----------------
   * 微信网页授权的回调地址必须是「已发布的 https 域名」，授权中继会校验 callback_url，
   * 本地预览（file:// / http://127.0.0.1 / 局域网 IP）一律被拒（服务端返回 400，
   * callback_url must be an absolute https URL of a published application）。
   * 所以本地环境下提前拦下，直接引导到已发布地址，而不是让用户撞一页看不懂的报错。 */

  function isLocalHost(h) {
    if (!h) return true;
    h = String(h).toLowerCase();
    return h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0' ||
      /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.local$/.test(h) || /\.localhost$/.test(h);
  }

  // 当前地址是否具备走 OAuth 的条件（https + 非本机/内网地址）
  function oauthUsable() {
    return location.protocol === 'https:' && !isLocalHost(location.hostname);
  }

  // 已发布地址上的同一个页面（保留 sharecode 等查询参数，避免落到「链接不完整」）
  function publishedEntry() {
    var base = ((FC.PUBLIC_CONFIG && FC.PUBLIC_CONFIG.endpoint) || '').replace(/\/+$/, '');
    if (!base) return '';
    var page = (location.pathname.split('/').pop() || 'index.html');
    return base + '/' + page + location.search + location.hash;
  }

  // 可点击跳转的提示条（复用「点这里重试」的交互）
  function showActionHint(msg, href) {
    var box = $('login-err');
    if (!box) { FC.toast(msg, 'err', 4200); return; }
    box.textContent = msg;
    box.classList.add('show');
    box.style.cursor = 'pointer';
    box.onclick = href ? function () { FC.openExternal(href); } : null;
    if (!href) box.style.cursor = '';
  }

  /* 把授权中继/服务端返回的英文报错翻译成用户能行动的提示 */
  function oauthErrorText(msg) {
    var m = String(msg || '');
    if (/callback_url|published application|absolute https/i.test(m)) {
      return '微信登录只能在已发布地址上使用，当前地址不被授权服务接受。';
    }
    if (/not\s*configured|unsupported|provider/i.test(m)) {
      return '微信登录暂未开通，请改用手机号或邮箱验证码登录。';
    }
    return m || '微信登录发起失败，请稍后重试，或改用验证码登录。';
  }

  async function wechatLogin() {
    clearLoginError();
    if (!oauthUsable()) {
      var target = publishedEntry();
      if (FC.toast) FC.toast(FC.isNative ? '将在系统浏览器打开网页版微信登录' : '本地预览不支持微信登录，请到已发布地址使用', 'err', 3200);
      showActionHint(
        FC.isNative
          ? '微信登录需在系统浏览器中打开网页版完成；APP 内可直接使用手机号或邮箱验证码登录。点这里继续 →'
          : '微信登录仅支持已发布域名，当前是本地预览。' +
            (target ? '点这里打开已发布版本 →' : '请发布后再用发布地址登录。'),
        target
      );
      return;
    }
    var res = await FC.cloud.auth.signInWithOAuth({
      provider: 'wechat',
      redirectTo: location.origin
    });
    if (res.error) {
      var text = oauthErrorText(res.error.message);
      // 域名不被接受时同样给一条可点击的出口
      if (/已发布地址/.test(text)) {
        showActionHint(text + '（点这里打开已发布版本 →）', publishedEntry());
      } else {
        showLoginError(text);
      }
      return;
    }
    location.assign(res.data.url);
  }

  async function signOut() {
    var res = await FC.cloud.auth.signOut();
    // 无论服务端是否响应，本机登录记录都要清干净，否则下次打开又自动登回来；
    // 回收站也要一并清，否则下次启动会被「复活」机制自动登回去
    FC.session.clear();
    FC.session.purgeTrash();
    clearLoginError();
    if (res && res.error) { FC.toast(res.error.message, 'err'); return; }
    window.location.reload();
  }

  /* ---------------- 顶部导航用户区 ---------------- */

  function renderNavUser(session) {
    var user = session && session.user;
    var name = (user && user.name) || '';
    var el = document.getElementById('nav-user');
    if (!el) return;
    // 玩法页顶栏没有检索框，取不到时跳过（不能因此让整页脚本中断）
    var slot = document.getElementById('nav-search-slot');
    if (slot) slot.style.display = '';
    el.innerHTML =
      '<button class="avatar" id="avatar-btn" aria-label="账号菜单">' + (name ? FC.escapeHtml(name.slice(0, 1)) : '我') + '</button>' +
      '<div class="avatar-menu" id="avatar-menu">' +
      '  <div class="who">' + (name ? FC.escapeHtml(name) : '已登录用户') + '</div>' +
      '  <button id="signout-btn">退出登录</button>' +
      '</div>';
    var btn = document.getElementById('avatar-btn');
    var menu = document.getElementById('avatar-menu');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', function () { menu.classList.remove('open'); });
    document.getElementById('signout-btn').addEventListener('click', signOut);
  }

  /* ---------------- 绑定（仅登录视图存在于当前页时） ---------------- */

  function bindLoginUI() {
    if (!$('login-view')) return;
    $('tab-phone').addEventListener('click', function () { switchMethod('phone'); });
    $('tab-email').addEventListener('click', function () { switchMethod('email'); });
    $('login-phone').addEventListener('input', function () { $('phone-hint').textContent = ''; });
    $('login-email').addEventListener('input', function () { $('email-hint').textContent = ''; });
    $('otp-btn').addEventListener('click', sendCode);
    $('login-submit').addEventListener('click', submitLogin);
    $('login-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitLogin(); });
    var wx = $('wechat-btn');
    if (wx) {
      wx.addEventListener('click', wechatLogin);
      // 本地预览：提前告知微信登录不可用，并给出去已发布地址的入口
      if (!oauthUsable()) {
        var hint = $('wx-hint');
        var entry = publishedEntry();
        if (hint) {
          hint.hidden = false;
          hint.innerHTML = FC.isNative
            ? '微信登录将打开系统浏览器；APP 内建议直接使用手机号或邮箱验证码。'
            : '本地预览地址不支持微信登录，验证码登录不受影响　' +
              (entry ? '<a href="' + FC.escapeHtml(entry) + '">改用已发布地址 →</a>' : '。');
        }
      }
    }
  }

  window.FC.auth = {
    boot: boot,
    bindLoginUI: bindLoginUI,
    renderNavUser: renderNavUser,
    showLoginError: showLoginError
  };
})();
