/* ============================================================
 * cloud.js — SDK 初始化 + 全站公共工具
 * 依赖：CDN 形式的 WorkBuddy Cloud SDK（index/detail 页先加载 IIFE）
 * 暴露：window.FC（命名空间），后续 auth.js / home.js / detail.js 使用
 * ============================================================ */

(function () {
  'use strict';

  // publicConfig 由云服务开通时返回，是唯一可放进前端代码的配置来源
  var PUBLIC_CONFIG = {
    endpoint: 'https://flashcard-hub.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_nDdfnmDcXcKBLLSE3YKl8B_4E263o7f3wSi6ruy5bE63hpvQJJtUdoH'
  };

  var cloud = null;

  /* ---------------- 登录态本机持久化（同设备免二次登录） ----------------
   * SDK 默认只把会话写在 localStorage 的 `workbuddy-cloud.session.<key>` 下。
   * 手机浏览器（无痕模式、WebView 清缓存、存储配额回收、隐私清理）很容易把它
   * 清掉，一次清理就得重新收验证码。这里给 SDK 换一个 storage 适配器：
   *   1. 读写仍以 localStorage 为主，写不进去时退到内存
   *   2. 每次写入都镜像一份到 cookie（365 天），与 localStorage 形成双保险
   *   3. 主存储读不到会话时用 cookie 回填，SDK 便能无感恢复登录态
   * 注意：这里只搬运 SDK 自己的会话串，不生成任何凭据，安全性跟原来一致。 */

  var SESSION_PREFIX = 'workbuddy-cloud.session.';
  var SESSION_KEY = SESSION_PREFIX + PUBLIC_CONFIG.publishableKey;
  var SESSION_COOKIE = 'fc_session';
  var SESSION_COOKIE_MAX = 3600;        // 单条 cookie 约 4KB，留出键名与属性的余量
  var SESSION_TTL_DAYS = 365;
  var memStore = {};

  var lsUsable = (function () {
    try {
      localStorage.setItem('__fc_probe__', '1');
      localStorage.removeItem('__fc_probe__');
      return true;
    } catch (e) { return false; }
  })();

  function isSessionKey(key) {
    return typeof key === 'string' && key.indexOf(SESSION_PREFIX) === 0;
  }

  function rawGet(key) {
    if (lsUsable) {
      try {
        var v = localStorage.getItem(key);
        if (v !== null && v !== undefined) return v;
      } catch (e) { /* 退到内存 */ }
    }
    return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
  }

  function rawSet(key, value) {
    memStore[key] = value;
    if (lsUsable) {
      try { localStorage.setItem(key, value); } catch (e) { /* 配额满等：仅保留内存副本 */ }
    }
  }

  function rawRemove(key) {
    delete memStore[key];
    if (lsUsable) {
      try { localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
    }
  }

  function cookieGet(name) {
    try {
      var parts = (document.cookie || '').split(';');
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].replace(/^\s+/, '');
        if (kv.indexOf(name + '=') === 0) {
          return decodeURIComponent(kv.slice(name.length + 1));
        }
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function cookieWrite(name, value) {
    try {
      var enc = encodeURIComponent(value || '');
      if (!enc) return;
      if (enc.length > SESSION_COOKIE_MAX) {
        // 超限时压缩到 SDK 校验必需的字段，保证镜像一定能写进去——
        // 写不进去的镜像等于没有，移动端 localStorage 被清后就只能重新登录
        var compact = compactSession(value);
        if (!compact) return;
        enc = encodeURIComponent(compact);
        if (enc.length > SESSION_COOKIE_MAX) return;
      }
      var bits = [
        name + '=' + enc,
        'path=/',
        'max-age=' + (SESSION_TTL_DAYS * 24 * 3600),
        'SameSite=Lax'
      ];
      if (location.protocol === 'https:') bits.push('Secure');
      document.cookie = bits.join('; ');
    } catch (e) { /* 忽略 */ }
  }

  function cookieErase(name) {
    try {
      var bits = [name + '=', 'path=/', 'max-age=0', 'SameSite=Lax'];
      if (location.protocol === 'https:') bits.push('Secure');
      document.cookie = bits.join('; ');
    } catch (e) { /* 忽略 */ }
  }

  /* 压缩会话：只保留 SDK 校验（isStoredSession）与页面展示必需的字段，
   * 丢弃体积大头 user.raw（完整原始档案，页面对其无依赖）。
   * 压缩后通常远小于 cookie 单条上限，镜像永远写得进、且始终是最新令牌。 */
  function compactSession(value) {
    try {
      var s = JSON.parse(value);
      if (!s || typeof s !== 'object') return null;
      if (typeof s.accessToken !== 'string' || !s.accessToken) return null;
      if (typeof s.expiresAt !== 'number') return null;
      var u = s.user && typeof s.user === 'object' ? s.user : {};
      return JSON.stringify({
        accessToken: s.accessToken,
        refreshToken: typeof s.refreshToken === 'string' ? s.refreshToken : '',
        expiresAt: s.expiresAt,
        user: { id: u.id || '', name: u.name || '', avatarUrl: u.avatarUrl, isAnonymous: !!u.isAnonymous }
      });
    } catch (e) { return null; }
  }

  // 交给 SDK 的 storage 实现（替代默认的 localStorage）
  var sessionStore = {
    getItem: function (key) {
      var v = rawGet(key);
      if (isSessionKey(key)) {
        if (v === null) {
          // localStorage 被清掉了：用 cookie 里的镜像补回去，SDK 以为会话一直都在
          v = cookieGet(SESSION_COOKIE);
          if (v) rawSet(key, v);
        } else if (cookieGet(SESSION_COOKIE) !== (compactSession(v) || v)) {
          // 老用户本机只有 localStorage：顺手补一份镜像，下次被清才有得救
          // （镜像存的是压缩版，所以与全量值比较前要先压缩）
          cookieWrite(SESSION_COOKIE, v);
        }
      }
      return v;
    },
    setItem: function (key, value) {
      rawSet(key, value);
      if (isSessionKey(key)) cookieWrite(SESSION_COOKIE, value);
    },
    removeItem: function (key) {
      if (isSessionKey(key)) trashSnapshot();   // 清库前先留底，误清才有得复活
      rawRemove(key);
      if (isSessionKey(key)) cookieErase(SESSION_COOKIE);
    }
  };

  /* ---------------- 会话回收站 ----------------
   * SDK 在「刷新令牌被服务端拒绝」时会 abandon() 清空会话，适配器随即同步擦掉
   * cookie 镜像——一次误判（多标签页刷新竞态、网络抖动被判成凭据失效）就会
   * 永久丢登录。这里在清库时把会话先搬进回收站：
   *   - 下次启动若正式键为空，用回收站里的刷新令牌试一次复活，成功即无感恢复
   *   - 服务端明确拒绝凭据才真正作废回收站（见 ensureSession 末尾）
   * 用户主动退出登录会连同回收站一起清掉，不会「退了又被自动登回来」。 */
  var SESSION_TRASH = 'fc_session_trash';

  function trashSnapshot() {
    try {
      var raw = rawGet(SESSION_KEY) || cookieGet(SESSION_COOKIE);
      if (raw && lsUsable) {
        localStorage.setItem(SESSION_TRASH, JSON.stringify({ raw: raw, ts: Date.now() }));
      }
    } catch (e) { /* 忽略 */ }
  }

  // 把回收站里的会话回填到正式键，交给 SDK 正常刷新（成功续期会覆盖为全量新会话）
  function restoreFromTrash() {
    try {
      if (!lsUsable) return false;
      var raw = localStorage.getItem(SESSION_TRASH);
      if (!raw) return false;
      var rec = JSON.parse(raw);
      if (!rec || !rec.raw) return false;
      rawSet(SESSION_KEY, rec.raw);
      return true;
    } catch (e) { return false; }
  }

  function purgeTrash() {
    if (!lsUsable) return;
    try { localStorage.removeItem(SESSION_TRASH); } catch (e) { /* 忽略 */ }
  }

  function hasStoredSession() {
    return !!(rawGet(SESSION_KEY) || cookieGet(SESSION_COOKIE));
  }

  function readStoredSession() {
    var raw = rawGet(SESSION_KEY) || cookieGet(SESSION_COOKIE);
    if (!raw) return null;
    try {
      var s = JSON.parse(raw);
      if (s && typeof s.accessToken === 'string' && s.user) return s;
    } catch (e) { /* 脏数据当没有 */ }
    return null;
  }

  // 把 cookie 里的会话写回主存储，供 SDK 读取
  function restoreStoredSession() {
    if (rawGet(SESSION_KEY)) return true;
    var raw = cookieGet(SESSION_COOKIE);
    if (!raw) return false;
    rawSet(SESSION_KEY, raw);
    return true;
  }

  function clearStoredSession() {
    rawRemove(SESSION_KEY);
    cookieErase(SESSION_COOKIE);
  }

  /* ---------------- 刷新竞态防护 ----------------
   * SDK 收到 /v1/token 返回 401 invalid_grant 会立即 abandon 清空本机登录。
   * 但多标签页并发刷新时，后到的请求拿的是已被轮换的旧令牌——这种 401 只是
   * 竞态，不是真失效，却会把别的页面刚写入的新会话一并清掉。
   * 在 fetch 层拦截：发起刷新前快照本地刷新令牌，收到 401 时重读本地，
   * 若令牌已被其它页面换新，就把响应当成网络层错误交给 SDK（走冷却路径、
   * 不清库）；随后重试会读到新令牌自然续上。 */
  function peekRefreshToken() {
    var s = readStoredSession();
    return (s && s.refreshToken) ? s.refreshToken : null;
  }

  /* 底层 fetch：原生环境走 CapacitorHttp（绕开 WebView fetch/CORS 栈，
   * 真机 WebView 的 fetch 整体失败时这是关键兜底），网页环境维持 window.fetch。
   * 若 native-http.js 未加载则自动退回 window.fetch，不影响网页版。 */
  var baseFetch = (window.FC_NativeHttp && typeof window.FC_NativeHttp.selectFetch === 'function')
    ? window.FC_NativeHttp.selectFetch()
    : function (u, o) { return window.fetch(u, o); };

  /* ---- 401 会话层自愈工具 ----
   * SDK 只看本地 expiresAt（临期 90 秒才刷新）；若本机 token 与服务端会话
   * 不一致（服务端轮换/吊销、Web 端登录挤掉 App 会话、时钟偏差等），请求会
   * 带着死 token 发出并被 401 invalid_grant 拒绝，SDK 对业务请求不会自救。
   * 真机探针实测（2026-11-17）：POST 上传 + 正确 publishable key + 服务端
   * 不认识的 Bearer → {"error":"invalid_grant","error_description":"the
   * session is invalid, expired or issued for another client"}，与用户报错
   * 逐字一致。策略：业务请求收到这类 401 时强制续期一次并原样重试；
   * 刷新也失败 = 会话确实失效，SDK abandon 清库并广播 SIGNED_OUT，页面回登录。 */

  // 各形态 headers → { 小写名: 值 }（Headers 实例 / 二维数组 / 普通对象）
  function headerMap(src) {
    var out = {};
    if (!src) return out;
    if (typeof Headers !== 'undefined' && src instanceof Headers) {
      src.forEach(function (v, k) { out[String(k).toLowerCase()] = v; });
      return out;
    }
    if (Array.isArray(src)) {
      for (var i = 0; i < src.length; i++) out[String(src[i][0]).toLowerCase()] = src[i][1];
      return out;
    }
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k.toLowerCase()] = String(src[k]);
    }
    return out;
  }

  /* ---- 登录端点强制匿名化 ----
   * 真机证据（artifacts/probe-verify-endpoint.json）：发码 / 验证码校验 /
   * signin / signup 这四类 auth 端点，只要请求头带上服务端不认的 Bearer，
   * 一律返回 401 {"error":"invalid_grant","error_description":"the session
   * is invalid, expired or issued for another client"} —— 正是用户看到的
   * 那句"登录状态已失效"的原文。这些端点的正确姿态是【匿名】（SDK 本身也
   * 用 anonymousTokenProvider），任何 Authorization 都是污染，必须剥离。
   * 典型污染来源：上一版会话残留经 we() 的 token provider 注入、或 WebView
   * 缓存里旧脚本用了带 token 的 fetch 包装。这里在统一入口兜底，确保登录
   * 链路永远裸发，从根上消除"登录被判失效"。 */
  var AUTH_ANON_PATHS = [
    '/.cloud/auth/v1/verification',      // 发码 + 验证码校验（含 /verify）
    '/.cloud/auth/v1/signin',            // 验证码换会话
    '/.cloud/auth/v1/signup',            // 新用户注册
    '/.cloud/auth/v1/login-'             // 微信/WorkBuddy 登录交换
  ];
  function stripAuthForLogin(url, opts) {
    var u = String(url);
    var isLoginPath = false;
    for (var i = 0; i < AUTH_ANON_PATHS.length; i++) {
      if (u.indexOf(AUTH_ANON_PATHS[i]) !== -1) { isLoginPath = true; break; }
    }
    if (!isLoginPath || !opts || !opts.headers) return opts;
    var h = headerMap(opts.headers);
    if (!h.authorization) return opts;   // 没带 token，无需处理
    delete h.authorization;
    logReq(opts && opts.method, url, -1, false, '登录端点剥离死token');
    return Object.assign({}, opts, { headers: h });
  }

  // 复制除 Authorization 外的全部头并写入新 token（SDK 的 we 包装只在
  // 「无 Authorization」时注入 token，所以重试必须自己带上新值）
  function rebuildHeaders(src, token) {
    if (typeof Headers !== 'undefined' && src instanceof Headers) {
      var h = new Headers();
      src.forEach(function (v, k) { if (String(k).toLowerCase() !== 'authorization') h.set(k, v); });
      h.set('Authorization', 'Bearer ' + token);
      return h;
    }
    var m = headerMap(src);
    delete m.authorization;
    m.authorization = 'Bearer ' + token;
    return m;
  }

  // 重建已被读走响应体的等价响应（网页 Response 的 text() 只能消费一次）
  function responseShim(resp, text) {
    try {
      return new Response(text || '', {
        status: resp.status, statusText: resp.statusText || '', headers: resp.headers || undefined
      });
    } catch (e) {
      var status = resp.status;
      return {
        ok: status >= 200 && status < 300,
        status: status,
        statusText: resp.statusText || String(status),
        headers: { get: function () { return null; }, has: function () { return false; } },
        text: function () { return Promise.resolve(text || ''); },
        json: function () { return Promise.reject(new Error('响应体不可重读')); },
        blob: function () { return Promise.resolve(new Blob([])); },
        arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(0)); }
      };
    }
  }

  function isSessionRejected(detail) {
    try {
      var eb = JSON.parse(detail);
      if (eb && (eb.error === 'invalid_grant' ||
          /session is invalid|expired or issued/i.test(String(eb.error_description || eb.message || '')))) return true;
    } catch (e) { /* 非 JSON 错误体按文本判断 */ }
    return /session is invalid|expired or issued/i.test(String(detail));
  }

  /* ---- 请求日志环形缓冲（诊断浮层用）----
   * 真机排障的最大痛点是「用户只报一句英文报错，不知道是哪个请求挂了」。
   * 这里把经过 fcFetch 的每个请求记录：时间 / 方法 / 路径 / 状态 / 是否带
   * token，最后 25 条。连点标题 5 次打开诊断浮层即可看到完整链路。 */
  var reqLog = [];
  var REQ_LOG_MAX = 25;
  function logReq(method, url, status, hasAuth, note) {
    try {
      var path = String(url).replace(/^https?:\/\/[^/]+/, '');
      reqLog.push({
        time: new Date().toTimeString().slice(0, 8),
        method: String(method || 'GET').toUpperCase(),
        path: path.length > 46 ? '…' + path.slice(-45) : path,
        status: status,
        auth: !!hasAuth,
        note: note || ''
      });
      if (reqLog.length > REQ_LOG_MAX) reqLog.splice(0, reqLog.length - REQ_LOG_MAX);
    } catch (e) { /* 日志绝不影响主流程 */ }
  }

  /* ---- 面向用户的错误翻译 ----
   * 服务端/SDK 的原始报错多为英文（session is invalid、Credentials missing、
   * Failed to fetch...），用户无法据此行动。显示层统一过这里翻译；
   * 原文仍保留在请求日志（FC.reqLog）与控制台，排障不受影响。 */
  var lastRawErrors = [];   // 最近 5 条「翻译前原文」：诊断浮层展示，便于一次截图定位
  function friendlyError(msg) {
    var m = String(msg || '');
    if (m) {
      lastRawErrors.push({ t: new Date().toTimeString().slice(0, 8), raw: m.slice(0, 240) });
      if (lastRawErrors.length > 5) lastRawErrors.shift();
    }
    if (/session is invalid|invalid_grant|expired or issued|credentials missing|missing_credentials/i.test(m)) {
      return '登录状态已失效，请重新登录后再试';
    }
    if (/failed to fetch|networkerror|load failed|timeout|timed out|abort/i.test(m)) {
      return '网络连接不稳定，请检查网络后重试';
    }
    return m;
  }

  // 合成 401「登录已失效」响应：本地已确认无可用会话时替代裸请求出门，
  // 让调用方拿到可读错误，而不是网关的天书 MISSING_CREDENTIALS。
  function syntheticAuthRequired() {
    var body = JSON.stringify({
      error: 'invalid_grant',
      error_description: '登录状态已失效，请重新登录后再试'
    });
    try {
      return new Response(body, {
        status: 401, statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' }
      });
    } catch (e) {
      var status = 401;
      return {
        ok: false, status: status, statusText: 'Unauthorized',
        headers: { get: function () { return null; }, has: function () { return false; } },
        text: function () { return Promise.resolve(body); },
        json: function () { return Promise.resolve(JSON.parse(body)); },
        blob: function () { return Promise.resolve(new Blob([body], { type: 'application/json' })); },
        arrayBuffer: function () {
          try { return Promise.resolve(new TextEncoder().encode(body).buffer); }
          catch (e2) { return Promise.resolve(new ArrayBuffer(0)); }
        }
      };
    }
  }

  async function fcFetch(url, opts) {
    // 登录端点（发码/验证码校验/signin/signup）强制剥离 Authorization：
    // 它们本应匿名，带死 token 必被服务端判 401 invalid_grant（真机探针实证）。
    // 放在最前面，先于 isRefresh / 预检守卫 / 401 自愈，避免任何逻辑再给它们注入 token。
    opts = stripAuthForLogin(url, opts);

    var isRefresh = typeof url === 'string' &&
      url.indexOf('/.cloud/auth/v1/token') !== -1 &&
      opts && typeof opts.body === 'string' && opts.body.indexOf('"refresh_token"') !== -1;
    if (isRefresh) {
      var before = peekRefreshToken();
      return baseFetch(url, opts).then(function (resp) {
        logReq(opts && opts.method, url, resp ? resp.status : 0, !!(opts && opts.headers ? headerMap(opts.headers).authorization : null), '刷新令牌');
        if (resp && resp.status === 401 && before) {
          var after = peekRefreshToken();
          if (after && after !== before) {
            // 竞态：抛错让 SDK 归类为网络失败（保留本机记录），等待用新令牌重试
            throw new TypeError('fc: refresh token rotated by another page (race guard)');
          }
        }
        return resp;
      });
    }

    /* ---- 预检守卫：业务请求缺 Authorization 时不让裸请求出门 ----
     * SDK 的 we 包装层拿不到 token 时（本地无会话 / 刷新冷却 60s 内 /
     * 会话已被 abandon 清库）会不带 Authorization 直接发请求，网关返回
     * 天书错误 MISSING_CREDENTIALS（探针实测：publishable key 在 +
     * Authorization 缺失/空 → 401 MISSING_CREDENTIALS）。这里拦截
     * storage/database 业务请求：先强制续期一次（覆盖冷却期场景），
     * 仍拿不到 token 就触发登出（页面回登录视图）并合成可读 401。 */
    var uStr = String(url);
    var isBusiness = uStr.indexOf('/.cloud/storage/') !== -1 ||
                     uStr.indexOf('/.cloud/database/') !== -1;
    if (isBusiness && cloud && cloud.auth) {
      var authVal = (opts && opts.headers) ? headerMap(opts.headers).authorization : null;
      if (!authVal || !String(authVal).trim()) {
        var rr0 = null;
        try { rr0 = await cloud.auth.refreshSession(); } catch (e) { rr0 = null; }
        var tok0 = rr0 && rr0.data && rr0.data.accessToken;
        if (tok0) {
          opts = Object.assign({}, opts, { headers: rebuildHeaders(opts.headers, tok0) });
        } else {
          // 本地确认无可用会话（refresh token 已死或不存在）：
          // signOut 跳过网络请求，clear + SIGNED_OUT → 页面回登录视图
          logReq(opts && opts.method, url, 401, false, '预检拦截：无可用会话，本地合成401');
          try { await cloud.auth.signOut(); } catch (e) { /* 忽略 */ }
          // SDK signOut → sessions.clear → removeItem → trashSnapshot 会把这枚
          // 已被服务端拒绝的死会话搬进回收站；不清掉的话下次启动 restoreFromTrash
          // 又把它复活，用户陷入「每次打开都要重新登录」的循环。
          purgeTrash();
          return syntheticAuthRequired();
        }
      }
    }

    var resp = await baseFetch(url, opts);
    logReq(opts && opts.method, url, resp ? resp.status : 0,
      !!(opts && opts.headers ? headerMap(opts.headers).authorization : null),
      isBusiness ? '业务' : '');
    var auth = opts && opts.headers ? headerMap(opts.headers).authorization : null;
    if (!resp || resp.status !== 401 || !auth || !cloud || !cloud.auth) return resp;

    var detail = '';
    try { detail = await resp.text(); } catch (e) { return resp; }
    // 原生通道的响应 text() 可重复读（内部有缓存），直接交回即可
    var nativeResp = !!(resp && resp.__fcTextIdempotent);
    var passBack = function () { return nativeResp ? resp : responseShim(resp, detail); };

    if (!isSessionRejected(detail)) return passBack();

    // 强制续期一次（ignoreCooldown，绕过失败冷却），成功则带新 token 原样重试
    var rr = null;
    try { rr = await cloud.auth.refreshSession(); } catch (e) { rr = null; }
    var tok = rr && rr.data && rr.data.accessToken;
    if (!tok) return passBack();

    var retryOpts = Object.assign({}, opts, { headers: rebuildHeaders(opts.headers, tok) });
    logReq(opts && opts.method, url, -1, true, '401自愈重试');
    return baseFetch(url, retryOpts);
  }

  // 初始化 SDK（全局只初始化一次；失败时不静默降级，页面顶部提示）
  function initCloud() {
    if (typeof window.WorkBuddyCloud === 'undefined') {
      return { ok: false, message: '云服务 SDK 加载失败，请检查网络后刷新页面。' };
    }
    try {
      cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: PUBLIC_CONFIG.endpoint,
        oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
        publishableKey: PUBLIC_CONFIG.publishableKey,
        storage: sessionStore,         // 会话持久化到 localStorage + cookie 双通道
        fetch: fcFetch                 // 刷新令牌竞态防护（见上方说明）
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: '云服务初始化失败：' + (e && e.message ? e.message : '未知错误') };
    }
  }

  var initResult = initCloud();

  /* ---------------- 通用小工具 ---------------- */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function formatDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // 兼容旧浏览器的简单随机 id
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ---------------- Toast ---------------- */

  function toast(msg, type, ms) {
    var wrap = document.getElementById('toast-wrap');
    if (!wrap) { alert(msg); return; }
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    wrap.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('on'); });
    setTimeout(function () {
      el.classList.remove('on');
      setTimeout(function () { el.remove(); }, 260);
    }, ms || 2600);
  }

  /* ---------------- 签名链接辅助 ----------------
   * SDK 返回结构可能为 string / {url} / {signedUrl}，这里统一收敛，
   * 批量接口失败时自动回退到逐个调用，保证健壮。 */

  function pickUrl(item) {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      if (typeof item.url === 'string') return item.url;
      if (typeof item.signedUrl === 'string') return item.signedUrl;
      if (typeof item.link === 'string') return item.link;
    }
    return null;
  }

  async function signedUrl(path, ttl) {
    var res = await cloud.storage.createSignedUrl(path, ttl || 3600);
    if (res.error) throw new Error(res.error.message);
    var u = pickUrl(res.data);
    if (!u) throw new Error('签名链接返回格式异常');
    return u;
  }

  async function signedUrls(paths, ttl) {
    var out = {};
    if (!paths.length) return out;
    try {
      var res = await cloud.storage.createSignedUrls(paths, ttl || 3600);
      if (res.error) throw new Error(res.error.message);
      var list = Array.isArray(res.data) ? res.data : (res.data && res.data.urls) || [];
      paths.forEach(function (p, i) {
        var u = pickUrl(list[i]);
        if (u) out[p] = u;
      });
    } catch (e) { /* 批量失败 → 逐个补签 */ }
    // 兜底：批量结果缺谁就单独给谁签（覆盖返回结构差异、部分失败等情况）
    for (var i = 0; i < paths.length; i++) {
      if (!out[paths[i]]) {
        try { out[paths[i]] = await signedUrl(paths[i], ttl); }
        catch (err) { console.warn('签名失败', paths[i], err && err.message); }
      }
    }
    return out;
  }

  /* ---------------- 整卡内容：IndexedDB 缓存 + 双通道稳健下载 ----------------
   * 卡片文件一经收藏便不再变化，所以成功加载一次就整包存进 IndexedDB：
   * 之后刷新、重开、甚至断网打开同一张卡都直接用本地副本，零网络请求 ——
   * 这是「每次刷新详情页都报 NetworkError」的根治手段。
   * 下载通道（网络层错误才重试，HTTP 4xx/5xx 重试无意义）：
   *   ① storage.download：带登录态的主通道
   *   ② createSignedUrl + fetch：不带 Authorization 头的备用通道，
   *      请求形态与网关路径都不同，主通道被掐断时仍有概率走通
   * 缓存失败（不支持 IndexedDB、配额满）一律静默降级为「不走缓存」。 */

  var CARD_DB = 'fc-card-files';
  var CARD_STORE = 'blobs';
  var CARD_BUDGET = 60 * 1048576;    // 缓存总预算 60MB，超出按最旧淘汰
  var CARD_TTL = 30 * 864e5;         // 单条 30 天

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB 不可用')); return; }
      var rq = indexedDB.open(CARD_DB, 1);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(CARD_STORE)) {
          db.createObjectStore(CARD_STORE, { keyPath: 'path' });
        }
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error || new Error('IndexedDB 打开失败')); };
    });
  }

  // tx 完成后统一取 result；读不到返回 null
  function idbRun(mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var result = null;
        var tx = db.transaction(CARD_STORE, mode);
        var st = tx.objectStore(CARD_STORE);
        var rq = fn(st);
        if (rq) rq.onsuccess = function () { result = rq.result; };
        tx.oncomplete = function () { db.close(); resolve(result); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('IndexedDB 操作失败')); };
        tx.onabort = function () { db.close(); reject(tx.error || new Error('IndexedDB 操作中止')); };
      });
    });
  }

  function cardCacheGet(path) {
    return idbRun('readonly', function (st) { return st.get(path); })
      .then(function (rec) {
        if (!rec || !rec.blob) return null;
        if (Date.now() - (rec.ts || 0) > CARD_TTL) return null;   // 过期当没有
        return rec.blob;
      })
      .catch(function () { return null; });                       // 缓存故障不阻断加载
  }

  function cardCachePut(path, blob) {
    return idbRun('readwrite', function (st) { return st.put({ path: path, blob: blob, ts: Date.now(), size: blob.size }); })
      .then(function () { return trimCardCache(); })
      .catch(function (e) { console.warn('卡片缓存写入失败（不影响使用）', e && e.message); });
  }

  // 超预算/清过期：逐条扫，删过期与最旧的超额部分
  function trimCardCacheReal() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var recs = [];
        var tx = db.transaction(CARD_STORE, 'readwrite');
        var st = tx.objectStore(CARD_STORE);
        var cur = st.openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (!c) return;
          var v = c.value;
          if (!v || !v.blob || Date.now() - (v.ts || 0) > CARD_TTL) c.delete();
          else recs.push(v);
          c.continue();
        };
        tx.oncomplete = function () {
          recs.sort(function (a, b) { return a.ts - b.ts; });
          var total = 0, i, cut = -1;
          for (i = 0; i < recs.length; i++) total += recs[i].size || 0;
          if (total > CARD_BUDGET) {
            for (i = 0; i < recs.length; i++) {
              total -= recs[i].size || 0;
              if (total <= CARD_BUDGET) { cut = i; break; }
            }
            var tx2 = db.transaction(CARD_STORE, 'readwrite');
            var st2 = tx2.objectStore(CARD_STORE);
            for (i = 0; i <= cut; i++) st2.delete(recs[i].path);
            tx2.oncomplete = function () { db.close(); resolve(); };
            tx2.onerror = function () { db.close(); resolve(); };
            return;
          }
          db.close(); resolve();
        };
        tx.onerror = function () { db.close(); resolve(); };
      });
    }).catch(function () { /* 忽略 */ });
  }

  function isNetErr(e) {
    var m = errText(e, '');
    return /NetworkError|Failed to fetch|fetch resource|Load failed|network error|request failed before a response/i.test(m) ||
           !!(e && e.status === 0);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 单通道：最多 attempts 次，指数退避；返回 Blob，全败抛最后一个错
  async function channel(fn, attempts, backoff) {
    var last = null;
    for (var i = 0; i < attempts; i++) {
      if (i > 0) await sleep(backoff * Math.pow(2, i - 1));
      try {
        var b = await fn();
        if (b) return b;
        last = new Error('文件下载返回为空');
      } catch (e) {
        last = e;
        if (!isNetErr(e)) throw e;   // 非网络层错误立即上抛（重试无意义）
      }
    }
    throw last;
  }

  async function downloadViaStorage(path) {
    var res = await cloud.storage.download(path);
    if (res && res.error) throw res.error;
    var data = res ? res.data : null;
    if (!data) throw new Error('文件下载返回为空');
    if (typeof data.blob === 'function') return data.blob();
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
    throw new Error('文件下载返回格式异常');
  }

  async function downloadViaSignedUrl(path) {
    var res = await cloud.storage.createSignedUrl(path, 3600);
    if (res.error) throw new Error(res.error.message || '签名链接获取失败');
    var u = pickUrl(res.data);
    if (!u) throw new Error('签名链接返回格式异常');
    // 走统一封装的 fcFetch：原生环境同样需要 CapacitorHttp 通道，
    // 直接用 window.fetch 会让备用通道在真机上和主通道一起挂。
    var resp = await fcFetch(u);
    if (!resp.ok) throw new Error('签名链接下载失败（HTTP ' + resp.status + '）');
    return resp.blob();
  }

  /**
   * 加载整卡 Blob（缓存优先 → 双通道下载）。
   * @param {Object} card cards 表索引行（至少含 card_path）
   * @param {Function} [note] 加载过程提示回调 note(msg)，供页面更新加载文案
   * @returns {Promise<Blob>}
   */
  async function loadCardBlob(card, note) {
    if (!card || !card.card_path) throw new Error('缺少卡片存储路径');
    var say = function (m) { try { if (note) note(m); } catch (e) { /* 忽略 */ } };
    var path = card.card_path;

    // ① 本地缓存命中：零网络，直接用
    var cached = await cardCacheGet(path);
    if (cached) {
      say('已使用本地缓存');
      return cached;
    }

    // ② 主通道：登录态下载，3 次指数退避
    try {
      say('正在加载卡片文件…');
      var blob = await channel(function () { return downloadViaStorage(path); }, 3, 600);
      cardCachePut(path, blob);
      trimCardCacheReal();
      return blob;
    } catch (eA) {
      console.warn('主通道下载失败', errText(eA, ''));
      // ③ 备用通道：签名 URL 直取，2 次
      try {
        say('主通道不稳，正在切换备用通道…');
        var blob2 = await channel(function () { return downloadViaSignedUrl(path); }, 2, 1200);
        cardCachePut(path, blob2);
        trimCardCacheReal();
        return blob2;
      } catch (eB) {
        console.warn('备用通道下载失败', errText(eB, ''));
        var a = errText(eA, ''), b = errText(eB, '');
        var merged = new Error(b && b !== a ? a + ' ／ ' + b : (a || '卡片文件下载失败'));
        merged.channels = [eA, eB];
        throw merged;
      }
    }
  }

  /* ---------------- 会话恢复（带重试 + 本机镜像兜底） ----------------
   * 原来页面启动时只调一次 getSession()，网络抖动一次就退回登录页，
   * 用户得重新收验证码。这里：
   *   ① 失败先看本机是否还有会话记录，有就把 cookie 镜像回填再强刷一次
   *   ② 仍失败按退避再试 retry 轮
   *   ③ 返回 { session, error, transient } 供页面区分「真没登录」与「网络问题」 */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // SDK 内部请求没有超时，弱网时可能一直挂着；这里给每次尝试封一个上限
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (resolve) {
        setTimeout(function () { resolve({ data: null, error: null, __timeout: true }); }, ms);
      })
    ]);
  }

  function isTransientError(err) {
    if (!err) return false;
    if (err.kind === 'network' || err.kind === 'backend-unavailable') return true;
    if (typeof err.status === 'number' && err.status >= 500) return true;
    var msg = String(err.message || '');
    return /network|timeout|timed out|failed to fetch|load failed|abort/i.test(msg);
  }

  async function ensureSession(retry) {
    if (!cloud) {
      return { session: null, error: { kind: 'unavailable', message: '云服务不可用' }, transient: true };
    }
    var rounds = typeof retry === 'number' ? retry : 2;
    var lastError = null;
    var sawTransient = false;
    var trashTried = false;      // 本次启动是否试过回收站复活（只试一次）
    var trashRevived = false;    // 是否真的从回收站回填过会话
    var deadline = Date.now() + 9000;      // 整体预算：超过就不再磨，交回页面处理

    function timedOut() {
      lastError = { kind: 'network', message: '登录状态恢复超时' };
      sawTransient = true;
      return { data: null, error: lastError };
    }

    for (var i = 0; i <= rounds; i++) {
      if (Date.now() > deadline) break;

      var res = await withTimeout(
        cloud.auth.getSession().catch(function (e) {
          return { data: null, error: { kind: 'network', message: (e && e.message) || '会话读取失败' } };
        }), 5000);
      if (res && res.__timeout) res = timedOut();
      if (res && res.data) {
        /* ---- 启动期服务端验证：本地"未过期"≠服务端承认 ----
         * SDK 的 ensure() 只看本地 expiresAt，服务端轮换/挤占（如 Web 端登录
         * 把 App 会话挤掉）会让本机留着一个"未过期但已死"的会话：直接放行会
         * 先进首页、等第一个带 token 的请求 401 再弹回登录页，用户看到的是
         * 天书报错 + 莫名弹跳。这里用 userMe 做一次轻量校验（SDK 在凭据被
         * 拒时会自行 clear + SIGNED_OUT），凭据真死则干净回登录视图。 */
        var before = hasStoredSession();
        try {
          await withTimeout(
            cloud.auth.getUser().catch(function () { return { data: null, error: { kind: 'network' } }; }),
            5000);
        } catch (e) { /* 网络失败不动会话，按原样放行 */ }
        if (before && !hasStoredSession()) {
          // userMe 被 401 invalid_grant 拒绝 → SDK 已清库：确认为死会话
          return { session: null, error: { kind: 'unauthenticated', message: '登录状态已失效，请重新登录' }, transient: false };
        }
        if (trashRevived) purgeTrash();   // 复活成功：旧令牌已被轮换，回收站不再需要
        return { session: res.data, error: null, transient: false };
      }
      if (res && res.error) { lastError = res.error; if (isTransientError(res.error)) sawTransient = true; }

      // 本机没有登录记录 → 先试一次回收站复活（防一次误判清库后永久掉登录），
      // 复活不了才确定为未登录状态（新用户首屏不该等）
      if (!hasStoredSession()) {
        if (!trashTried) {
          trashTried = true;
          if (restoreFromTrash()) { trashRevived = true; continue; }
        }
        break;
      }

      // 本机还留着会话 → 回填镜像并强制刷新一次（access token 过期、主存储被清都靠这步救回）
      if (hasStoredSession() && Date.now() < deadline) {
        restoreStoredSession();
        var rr = await withTimeout(
          cloud.auth.refreshSession().catch(function (e) {
            return { data: null, error: { kind: 'network', message: (e && e.message) || '刷新失败' } };
          }), 5000);
        if (rr && rr.__timeout) rr = timedOut();
        if (rr && rr.data) {
          if (trashRevived) purgeTrash();
          return { session: rr.data, error: null, transient: false };
        }
        if (rr && rr.error) { lastError = rr.error; if (isTransientError(rr.error)) sawTransient = true; }
      }

      if (i < rounds) {
        var wait = i === 0 ? 800 : 1600;
        if (Date.now() + wait > deadline) break;
        await sleep(wait);
      }
    }

    // 关键判据：SDK 在「凭据被服务端拒绝」时会把本机记录清空（abandon）；
    // 而网络失败只会让刷新返回空、本机记录原样保留。
    // 所以「跑完流程本机还有记录」= 这次失败是非致命的，不该要求用户重新登录。
    var hasLocal = hasStoredSession();
    var out = {
      session: null,
      error: lastError,
      transient: sawTransient || isTransientError(lastError) || hasLocal,
      hasLocal: hasLocal
    };
    // 从回收站复活过但仍未拿到会话，且失败不是网络类（= 凭据确实被服务端拒绝）：
    // 回收站里的令牌已作废，彻底清掉，避免之后每次进入都白打一次刷新请求
    if (trashRevived && !out.transient) purgeTrash();
    return out;
  }

  /* ---------------- 登录态保活 ----------------
   * 页面开着的期间（以及每次切回前台）顺手续一次 token，
   * 避免「放了几天再打开」正好卡在 token 边界上。 */

  var keepAliveStarted = false;
  function startSessionKeepAlive() {
    if (!cloud || keepAliveStarted) return;
    keepAliveStarted = true;
    var inFlight = false;
    function ping() {
      if (inFlight || !navigator.onLine || document.visibilityState === 'hidden') return;
      // 离到期还有 5 分钟以上就不发请求：保活只负责「卡在边界前」续期，
      // 减少无效刷新，也显著降低多标签页并发刷新撞车（竞态）的概率
      var s = readStoredSession();
      if (!s || typeof s.expiresAt !== 'number') return;
      if (s.expiresAt - Date.now() > 5 * 60 * 1000) return;
      inFlight = true;
      Promise.resolve(cloud.auth.getSession())
        .then(function () { inFlight = false; }, function () { inFlight = false; });
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') ping();
    });
    window.addEventListener('focus', ping);
    setInterval(ping, 8 * 60 * 1000);
  }

  // 启动态骨架（#boot-view）收起：恢复登录状态期间它负责给用户一个明确的反馈
  function hideBoot() {
    var el = document.getElementById('boot-view');
    if (el) el.classList.remove('show');
    if (window.FC && FC.nativeReady) FC.nativeReady();
  }

  /* ---------------- 账号绑定解析 ----------------
   * 云认证服务不支持把「微信身份」与「手机号身份」合并成同一个 auth 用户，
   * 所以绑定关系在应用层表达：account_links 记录「某个登录身份归属哪个主账号」。
   * 该表只授予 SELECT，且策略限制为本人可见 —— 前端无法伪造或篡改绑定。
   * 绑定关系由管理员侧写入（见项目文档「账号合并」一节）。 */

  var bindingCache = null;

  async function resolveBinding(session, force) {
    if (bindingCache && !force) return bindingCache;
    var uid = session && session.user && session.user.id;
    if (!cloud || !uid) {
      bindingCache = { bound: false };
      return bindingCache;
    }
    // 查询构造器只保证可 await，不保证有 .catch，所以用 try/catch 包住
    var res;
    try {
      res = await cloud.database.from('account_links')
        .select('*')
        .eq('linked_uid', uid)
        .limit(1);
    } catch (e) {
      res = { data: null, error: { message: (e && e.message) || '绑定关系读取失败' } };
    }
    if (res && res.error) {
      // 绑定表异常不能把用户挡在门外：按「未绑定」处理并留痕
      console.warn('绑定关系读取失败', res.error.message);
      bindingCache = { bound: false, error: res.error };
      return bindingCache;
    }
    var row = (res && res.data && res.data[0]) || null;
    bindingCache = row
      ? {
        bound: true,
        primaryUid: row.primary_uid,
        label: row.label || '',
        provider: row.provider || ''
      }
      : { bound: false };
    return bindingCache;
  }

  function clearBindingCache() { bindingCache = null; }

  /* ---------------- 统一错误提取 ---------------- */

  function errText(e, fallback) {
    if (!e) return fallback || '操作失败，请稍后重试。';
    var out = (typeof e === 'string') ? e
      : (e.message || (e.error && e.error.message) || fallback || '操作失败，请稍后重试。');
    return friendlyError(out);
  }

  /* ---------------- 全局错误横幅（移动端白屏防护） ----------------
   * 任何未捕获的脚本错误都在页面顶部显示可见横幅，而非静默白屏。
   * 移动端无法方便地打开控制台，这样用户能把错误文字直接反馈回来。 */
  function installErrorBanner() {
    var bar = null;
    function show(msg) {
      if (bar) return; // 同一时间只显示一条
      bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;' +
        'background:#D93036;color:#fff;font:13px/1.6 -apple-system,"PingFang SC",sans-serif;' +
        'padding:10px 14px;word-break:break-all;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.2)';
      bar.textContent = '页面出错：' + msg + '（点击此条关闭，可截图反馈）';
      bar.onclick = function () { bar.remove(); bar = null; };
      (document.body || document.documentElement).appendChild(bar);
    }
    // 资源加载失败（img/script/link）不弹横幅：SDK 有 CDN 兜底，图片有占位
    window.addEventListener('error', function (e) {
      var t = e.target && e.target.tagName;
      if (t === 'IMG' || t === 'SCRIPT' || t === 'LINK') return;
      show(e.message || '未知脚本错误');
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      var msg = (r && (r.message || (r.error && r.error.message))) || '异步操作失败';
      show(msg);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installErrorBanner);
  } else {
    installErrorBanner();
  }

  window.FC = {
    cloud: cloud,                 // 初始化成功后供各页直接使用
    cloudReady: initResult.ok,
    cloudError: initResult.ok ? null : initResult.message,
    PUBLIC_CONFIG: PUBLIC_CONFIG,
    escapeHtml: escapeHtml,
    formatBytes: formatBytes,
    formatDate: formatDate,
    uuid: uuid,
    toast: toast,
    signedUrl: signedUrl,
    signedUrls: signedUrls,
    // 统一 fetch 通道：原生环境走 CapacitorHttp（绕开真机 WebView fetch 整体失败）。
    // offline.js 的封面预取等直接用 window.fetch 的地方必须改走这里，否则
    // 真机上预取永远静默失败，离线封面缓存始终为空。
    fcFetch: baseFetch,
    loadCardBlob: loadCardBlob,   // 整卡 Blob：IndexedDB 缓存优先 + 双通道稳健下载
    errText: errText,
    friendlyError: friendlyError,
    reqLog: function () { return reqLog.slice(); },
    rawErrors: function () { return lastRawErrors.slice(); },
    hideBoot: hideBoot,
    // 绑定关系：微信身份 → 主账号（只读，写入走管理员通道）
    binding: {
      resolve: resolveBinding,
      clearCache: clearBindingCache
    },
    // 登录态工具：同设备免二次登录的核心（ensure 带重试、镜像恢复与回收站复活）
    session: {
      key: SESSION_KEY,
      has: hasStoredSession,
      read: readStoredSession,
      restore: restoreStoredSession,
      clear: clearStoredSession,
      purgeTrash: purgeTrash,     // 主动退出登录时必须连回收站一起清
      ensure: ensureSession,
      isTransient: isTransientError
    }
  };

  if (initResult.ok && document.readyState !== 'loading') startSessionKeepAlive();
  if (initResult.ok) {
    document.addEventListener('DOMContentLoaded', startSessionKeepAlive);
  }
})();
