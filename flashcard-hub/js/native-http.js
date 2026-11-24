/* ============================================================
 * native-http.js — 原生 HTTP 通道（绕开 WebView fetch）
 *
 * 背景：真机 WebView 的 fetch 在部分机型/内核上对跨域请求整体失败
 * （Failed to fetch），导致登录、列表、上传全部不可用；而桌面浏览器
 * 与真实 HTTP 探针均正常。Capacitor 的原生 HTTP 插件走 native 层的
 * HttpURLConnection，不经过 WebView 的 fetch/CORS 栈，也不受其影响。
 *
 * 本文件把 CapacitorHttp.request 包装成标准 fetch(url, opts) -> Response
 * 的兼容层，供 cloud.js 在原生环境注入给 SDK。SDK 只用到：
 *   resp.ok / resp.status / resp.statusText / resp.headers.get(name) /
 *   resp.text() / resp.json() / resp.blob()
 * 全部在这里实现。非原生环境直接透传给 window.fetch，网页行为不变。
 * ============================================================ */

(function () {
  'use strict';

  function native() {
    var cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  }

  function httpPlugin() {
    var cap = window.Capacitor;
    if (!cap) return null;
    // Capacitor 8 从 core 导出 CapacitorHttp；也被挂到 Plugins 上（兼容不同版本）
    if (cap.CapacitorHttp && typeof cap.CapacitorHttp.request === 'function') return cap.CapacitorHttp;
    var p = cap.Plugins && cap.Plugins.CapacitorHttp;
    if (p && typeof p.request === 'function') return p;
    return null;
  }

  /* ---- 把任意 headers 输入规整成 { name: value } 普通对象 ---- */
  function normalizeHeaders(src) {
    var out = {};
    if (!src) return out;
    if (typeof Headers !== 'undefined' && src instanceof Headers) {
      src.forEach(function (v, k) { out[k] = v; });
      return out;
    }
    if (Array.isArray(src)) {
      for (var i = 0; i < src.length; i++) out[src[i][0]] = src[i][1];
      return out;
    }
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = String(src[k]);
    }
    return out;
  }

  /* ---- base64 → ArrayBuffer（原生 HTTP 的二进制统一以 base64 返回） ---- */
  function b64ToBuffer(b64, responseType) {
    if (b64 == null) return new ArrayBuffer(0);
    if (typeof b64 !== 'string') {
      // 已是数组/对象的直接按响应类型处理
      if (responseType === 'json') return b64;
      return b64;
    }
    var bin;
    try { bin = atob(b64); }
    catch (e) { bin = ''; }
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  /* ---- 构造标准 Response 兼容对象 ----
   * parsedJson：CapacitorHttp 原生层对 JSON content-type 响应会无条件解析成
   * 对象返回（Android HttpRequestHandler.readData 忽略 responseType），此时
   * json() 直接回传对象，text() 以 JSON.stringify 兑底，不能走 base64 链路。 */
  function makeResponse(status, headersObj, textBody, buffer, contentType, parsedJson) {
    var ok = status >= 200 && status < 300;
    var headersNorm = normalizeHeaders(headersObj);
    // headers.get 需大小写不敏感
    function header(name) {
      if (!name) return null;
      var lower = String(name).toLowerCase();
      for (var k in headersNorm) {
        if (k.toLowerCase() === lower) return headersNorm[k];
      }
      return null;
    }
    var textCache = textBody;
    function getText() {
      if (textCache != null) return Promise.resolve(String(textCache));
      if (parsedJson !== undefined) {
        // JSON 已被原生解析成对象：text() 以序列化结果兑底，绝不能给空串
        textCache = JSON.stringify(parsedJson);
        return Promise.resolve(String(textCache));
      }
      // 只有 buffer：按 UTF-8 解码
      try {
        textCache = new TextDecoder('utf-8').decode(new Uint8Array(buffer || new ArrayBuffer(0)));
      } catch (e) {
        var u = new Uint8Array(buffer || new ArrayBuffer(0)), s = '';
        for (var i = 0; i < u.length; i += 8192) {
          s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
        }
        try { textCache = decodeURIComponent(escape(s)); } catch (e2) { textCache = s; }
      }
      return Promise.resolve(String(textCache));
    }
    var ct = contentType || header('content-type') || '';
    return {
      // 标记：text() 内部有缓存可重复读（cloud.js 的 401 自愈层据此免重建响应）
      __fcTextIdempotent: true,
      ok: ok,
      status: status,
      statusText: status === 200 ? 'OK' : String(status),
      headers: { get: header, has: function (n) { return header(n) != null; } },
      text: getText,
      json: function () {
        if (parsedJson !== undefined) return Promise.resolve(parsedJson);
        return getText().then(function (t) {
          try { return JSON.parse(t); }
          catch (e) {
            // 解析失败时抛可读错误，避免 SDK 把空串错误吞成状态码
            throw new Error('响应不是合法 JSON：' + String(t).slice(0, 200));
          }
        });
      },
      blob: function () {
        var type = ct || 'application/octet-stream';
        return Promise.resolve(new Blob([buffer || new ArrayBuffer(0)], { type: type }));
      },
      arrayBuffer: function () { return Promise.resolve(buffer || new ArrayBuffer(0)); }
    };
  }

  /* ---- 把 fetch 的 body 规整为 CapacitorHttp 的 data ----
   * CapacitorHttp 规则：
   *   - string 原样发送
   *   - object 会被 JSON.stringify（并设置 application/json，若未指定 content-type）
   * SDK 调用形态已知：
   *   - GET/DELETE：无 body
   *   - auth/DB：body 已是 JSON 字符串
   *   - storage 直传：body 是字符串（HTML）或二进制
   * 二进制统一用 base64 data URL 交给原生，避免被当 object 序列化。 */
  function toNativeData(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
      return { __fcBinaryB64: bufToB64(body) };
    }
    if (ArrayBuffer.isView && ArrayBuffer.isView(body)) {
      return { __fcBinaryB64: bufToB64(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)) };
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      // Blob 不能被原生桥直接传，调用方（home.js）应改用 ArrayBuffer；这里给同步不可用的兜底
      return { __fcBinaryB64: '' };
    }
    if (typeof body === 'object') return body;   // SDK 传对象时让原生层按 JSON 处理
    return String(body);
  }

  function bufToB64(buffer) {
    var u = new Uint8Array(buffer), s = '';
    var CH = 0x8000;
    for (var i = 0; i < u.length; i += CH) {
      s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    }
    return btoa(s);
  }

  /* ------------ 原生 fetch 兼容函数 ------------ */
  async function nativeFetch(url, opts) {
    opts = opts || {};
    var plugin = httpPlugin();
    if (!plugin) {
      // 原生层缺失：退回 WebView fetch（理论上不会发生）
      return window.fetch(url, opts);
    }
    var method = String(opts.method || 'GET').toUpperCase();
    var headers = normalizeHeaders(opts.headers);
    var data = toNativeData(opts.body);

    var isFileBody = !!(data && data.__fcBinaryB64 !== undefined);
    if (isFileBody) {
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['content-type'] = 'application/octet-stream';
      }
      data = data.__fcBinaryB64;
    }

    var req = { url: String(url), method: method, headers: headers, responseType: 'arraybuffer' };
    if (data !== undefined) req.data = data;
    // 二进制 body 必须声明 dataType:'file'：原生层（CapacitorHttpUrlConnection.
    // setRequestBody）只在该分支做 Base64.decode 写入真实字节；漏掉的话 base64
    // 会被当成纯文本写进文件（缩略图会变成 base64 文本而不是 JPEG 图片）。
    if (isFileBody) req.dataType = 'file';
    // 超时保护：小请求 25s；大 body（≥512KB）按移动网络上传速率放宽到 120s，
    // 否则 4.75MB 闪卡在弱网上传到一半就被本地计时器拦腰。
    var bodyLen = typeof data === 'string' ? data.length : 0;
    var TIMEOUT = bodyLen >= 512 * 1024 ? 120000 : 25000;
    var timer = null;
    var timeoutP = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new TypeError('native http timeout')); }, TIMEOUT);
    });
    var resp;
    try {
      resp = await Promise.race([plugin.request(req), timeoutP]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    var status = (resp && typeof resp.status === 'number') ? resp.status : 0;
    var raw = resp && resp.data;
    // errorStream 分支：Java 端对非 JSON 错误体返回纯文本字符串且 error:true，
    // 绝不能当 base64 解，否则错误原文全部丢失（toast 只剩状态码）。
    var isErrText = !!(resp && resp.error === true);
    var ct = (function () {
      var h = normalizeHeaders(resp && resp.headers);
      for (var k in h) if (k.toLowerCase() === 'content-type') return h[k];
      return '';
    })();
    var buffer = null, textBody = null, parsedJson;
    if (raw != null && typeof raw === 'object') {
      // 真机 Android：JSON content-type 响应已被原生解析为对象返回
      //（HttpRequestHandler.readData 忽略 responseType），必须直接透传，
      // 否则 json() 解到空串必挂 —— 上一版登录/列表/上传全挂的根因。
      parsedJson = raw;
    } else if (typeof raw === 'string' && raw.length) {
      if (isErrText) {
        // 错误体：原生给的就是明文，保留原文供 SDK 提示真实错误
        textBody = raw;
        try { buffer = new TextEncoder().encode(raw).buffer; } catch (e) { buffer = null; }
      } else {
        // 正常二进制：原生以 base64 返回，先解码为 ArrayBuffer
        buffer = b64ToBuffer(raw);
        if (ct.indexOf('json') >= 0 || ct.indexOf('text') >= 0 || ct.indexOf('xml') >= 0 ||
            ct.indexOf('www-form') >= 0 || !ct) {
          try { textBody = new TextDecoder('utf-8').decode(new Uint8Array(buffer)); }
          catch (e) { textBody = ''; }
        }
      }
    } else {
      buffer = new ArrayBuffer(0);
    }
    return makeResponse(status, resp && resp.headers, textBody, buffer, ct, parsedJson);
  }

  /* ------------ 对外：选择一个 fetch 实现 ------------ */
  function selectFetch() {
    if (native() && httpPlugin()) return nativeFetch;
    return function (u, o) { return window.fetch(u, o); };
  }

  /* ------------ 真机诊断：一键看网络通道与 SDK 状态 ------------ */
  async function diagnose() {
    var lines = [];
    try {
      var cap = window.Capacitor;
      lines.push('平台: ' + (native() ? '原生 ' + (cap && cap.getPlatform ? cap.getPlatform() : '') : '网页'));
      lines.push('原生HTTP插件: ' + (httpPlugin() ? '可用' : '不可用'));
      lines.push('origin: ' + location.origin);
      lines.push('navigator.onLine: ' + navigator.onLine);
      lines.push('SDK加载: ' + (typeof window.WorkBuddyCloud !== 'undefined'));
      lines.push('云初始化: ' + (window.FC && FC.cloudReady));
      lines.push('本机会话: ' + (window.FC && FC.session && FC.session.has()));
    } catch (e) { lines.push('基本信息读取失败: ' + (e && e.message)); }

    // 最近请求日志：一张截图就能看出是哪个请求、带了什么凭证、返回什么状态
    try {
      var log = (window.FC && typeof FC.reqLog === 'function') ? FC.reqLog() : null;
      if (log && log.length) {
        lines.push('---- 最近请求（新→旧最多25条）----');
        for (var li = log.length - 1; li >= 0; li--) {
          var r = log[li];
          lines.push(r.time + ' ' + r.method + ' ' + r.path + ' → ' + r.status +
            (r.auth ? ' [带token]' : ' [无token]') + (r.note ? ' (' + r.note + ')' : ''));
        }
      } else {
        lines.push('最近请求: （暂无记录）');
      }
    } catch (e2) { lines.push('请求日志读取失败: ' + (e2 && e2.message)); }

    // 最近的错误原文（翻译前）：决定"登录失效"到底来自 401 invalid_grant 还是验证码错误
    try {
      var raws = (window.FC && typeof FC.rawErrors === 'function') ? FC.rawErrors() : null;
      if (raws && raws.length) {
        lines.push('---- 最近错误原文（翻译前，新→旧）----');
        for (var ri = raws.length - 1; ri >= 0; ri--) {
          lines.push(raws[ri].t + ' ' + raws[ri].raw);
        }
      }
    } catch (e3) { /* 诊断绝不因日志失败中断 */ }

    var probeUrl = (window.FC && FC.PUBLIC_CONFIG && FC.PUBLIC_CONFIG.endpoint)
      ? FC.PUBLIC_CONFIG.endpoint + '/.cloud/auth/v1/health' : null;
    if (probeUrl) {
      for (var mode = 0; mode < 2; mode++) {
        var label = mode === 0 ? 'WebView fetch' : '原生 HTTP';
        try {
          var r = mode === 0
            ? await window.fetch(probeUrl, { method: 'GET' })
            : await nativeFetch(probeUrl, { method: 'GET' });
          lines.push(label + ': HTTP ' + r.status + ' (ok=' + r.ok + ')');
          // 只看状态不够：上一版的问题正是「状态 200 但 JSON 解析挂了」。
          // 健康接口无论返回什么都试一次 json()/text()，能读到内容才算通。
          try {
            var body = await r.text();
            var head = String(body).slice(0, 60).replace(/\s+/g, ' ');
            lines.push(label + ' 响应体: ' + (body ? head + '…（' + body.length + ' 字符）' : '（空）'));
          } catch (e2) {
            lines.push(label + ' 响应体读取失败: ' + (e2 && e2.message ? e2.message : String(e2)));
          }
        } catch (e) {
          lines.push(label + ': 失败 ' + (e && e.message ? e.message : String(e)));
        }
      }
    }
    return lines.join('\n');
  }

  window.FC_NativeHttp = {
    nativeFetch: nativeFetch,
    selectFetch: selectFetch,
    diagnose: diagnose,
    isNative: native
  };
})();
