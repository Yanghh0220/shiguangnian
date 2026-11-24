/* ============================================================
 * cover.js — 自定义封面
 * 职责：
 *   ① 选一张本地图片 → 压到最长边 480 的 JPEG（透明 PNG 垫白底）
 *   ② 通用「设置封面」弹窗：预览 / 选择图片 / 恢复默认 / 保存
 *   ③ 保存 = 传 thumbs/<uuid>.jpg → 更新索引 thumb_path → 清掉旧封面文件
 * 暴露：window.FC.cover = { pickImage, makeCoverBlob, open }
 * 依赖：cloud.js（FC.cloud / FC.uuid / FC.signedUrl / FC.toast）
 *
 * 两个使用场景：
 *   · 导入前：home.js 只用 pickImage + makeCoverBlob 拿到 Blob，随卡片一起传；
 *   · 已收藏：home.js / detail.js 调 open(card, cb)，弹窗自己完成换绑。
 * ============================================================ */

(function () {
  'use strict';

  var FC = window.FC;
  var MAX_MB = 12;        // 原始图片体积上限
  var MAX_EDGE = 480;     // 封面最长边，与上传时的缩略图规格保持一致
  var QUALITY = 0.85;

  /* Android 文件选择器（content://）对部分图片返回的 type 为空或
   * application/octet-stream，按 MIME 拒绝会误杀真实图片。
   * 统一策略：只拦体积，能不能用交给「解码验证」判定。 */

  /* ==================== 选图 ==================== */

  // 必须在用户手势（click）里同步调用，iOS/微信内核对 file input 的手势检测较严
  function pickImage() {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;';
      document.body.appendChild(input);

      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        try { input.remove(); } catch (e) { /* 忽略 */ }
        resolve(v);
      }

      input.addEventListener('change', function () {
        finish(input.files && input.files[0] ? input.files[0] : null);
      });
      // 取消选择时多数浏览器不派发 change：回到页面后延时收尾，避免残留 pending
      window.addEventListener('focus', function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(function () { finish(null); }, 1000);
      });
      input.click();
    });
  }

  /* ==================== 压缩成封面 JPEG ==================== */

  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () { resolve({ img: im, url: url }); };
      im.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这张图片无法解析，请换一张'));
      };
      im.src = url;
    });
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', QUALITY);
        return;
      }
      // 兜底：老浏览器没有 toBlob，用 dataURL 转回来
      try {
        var b64 = canvas.toDataURL('image/jpeg', QUALITY).split(',')[1];
        var bin = atob(b64);
        var buf = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        resolve(new Blob([buf], { type: 'image/jpeg' }));
      } catch (e) { resolve(null); }
    });
  }

  async function makeCoverBlob(file) {
    if (!file) throw new Error('没有选择图片');
    if (file.size > MAX_MB * 1048576) throw new Error('图片不能超过 ' + MAX_MB + 'MB');

    var got;
    try {
      got = await readImage(file);
    } catch (e) {
      // 区分最常见的两种不可用来源，提示可执行
      var t = file.type || '';
      if (/^image\/hei[cf]|\.heic$|\.heif$/i.test(t + ' ' + (file.name || ''))) {
        throw new Error('iPhone HEIC 格式暂不支持，请先用相册另存为 JPEG 再选');
      }
      throw new Error('这张图片无法解析，请换一张');
    }
    var im = got.img;
    var w0 = im.naturalWidth || im.width;
    var h0 = im.naturalHeight || im.height;
    if (!w0 || !h0) {
      URL.revokeObjectURL(got.url);
      throw new Error('这张图片无法解析，请换一张');
    }

    var scale = Math.min(MAX_EDGE / w0, MAX_EDGE / h0, 1);
    var w = Math.max(1, Math.round(w0 * scale));
    var h = Math.max(1, Math.round(h0 * scale));

    var blob = null;
    try {
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      // PNG 可能带透明通道，转 JPEG 会变黑底，先垫一层纸白
      ctx.fillStyle = '#FBF8F1';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(im, 0, 0, w, h);
    } catch (e) {
      URL.revokeObjectURL(got.url);
      throw new Error('封面生成失败，请换一张图片');
    }
    URL.revokeObjectURL(got.url);

    blob = await canvasToBlob(canvas);
    if (!blob || !blob.size) throw new Error('封面生成失败，请换一张图片');
    return blob;
  }

  /* ==================== 写库 + 传文件 ==================== */

  async function currentUid() {
    var res = await FC.cloud.auth.getSession();
    if (res.error || !res.data || !res.data.user) throw new Error('登录状态已失效，请刷新页面后重试');
    return res.data.user.id;
  }

  // blob 为 null 表示恢复默认封面（thumb_path = null）
  async function applyCover(card, blob) {
    var uid = await currentUid();
    var oldPath = card.thumb_path || null;
    var newPath = blob ? FC.cloud.storage.userPath(uid, 'thumbs/' + FC.uuid() + '.jpg') : null;

    if (newPath) {
      var up = await FC.cloud.storage.upload(newPath, blob, { contentType: 'image/jpeg' });
      if (up.error) throw new Error(up.error.message);
    }

    var res = await FC.cloud.database.from('cards').update({ thumb_path: newPath }).eq('id', card.id).select();
    if (res.error || !res.data || !res.data.length) {
      // 索引没写成功就把刚传的封面清掉，避免存储里留孤儿文件
      if (newPath) {
        try { await FC.cloud.storage.remove([newPath]); } catch (e) { /* 尽力而为 */ }
      }
      throw new Error((res.error && res.error.message) || '修改被拒绝：卡片不存在或不是你的收藏');
    }

    // 旧封面不再被引用，尽力清理（失败不影响使用）
    if (oldPath && oldPath !== newPath) {
      try { await FC.cloud.storage.remove([oldPath]); }
      catch (e) { console.warn('旧封面清理失败', e && e.message); }
    }

    card.thumb_path = newPath;
    return newPath;
  }

  /* ==================== 封面弹窗 ==================== */

  var dom = null;    // 弹窗 DOM（首次打开时创建，之后复用）
  var cur = null;    // 当前会话状态

  function build() {
    if (dom) return dom;

    var wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.id = 'cover-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '设置封面');
    wrap.innerHTML =
      '<div class="modal cover-modal">' +
      '  <div class="modal-head">' +
      '    <div>' +
      '      <h3>设置封面</h3>' +
      '      <p class="modal-sub" style="margin:6px 0 0">只影响它在册子里的封面，卡片文件保持原样。</p>' +
      '    </div>' +
      '    <button class="modal-close" data-act="close" aria-label="关闭">×</button>' +
      '  </div>' +
      '  <div class="cover-stage">' +
      '    <div class="cover-frame">' +
      '      <img id="cover-preview" alt="封面预览">' +
      '      <span class="cover-empty" id="cover-empty">尚无封面</span>' +
      '    </div>' +
      '    <div class="cover-note" id="cover-note">可从图片里选一张，也可以恢复为自动生成的封面。</div>' +
      '  </div>' +
      '  <div class="cover-ops">' +
      '    <button class="btn btn-ghost" data-act="pick">从相册选择</button>' +
      '    <button class="btn btn-ghost" data-act="clear">恢复默认</button>' +
      '  </div>' +
      '  <div class="modal-btns">' +
      '    <button class="btn btn-ghost" data-act="close">取消</button>' +
      '    <button class="btn btn-primary" data-act="save" id="cover-save">保存</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (wrap.classList.contains('open')) close();
    });

    wrap.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) {
        if (e.target === wrap) close();
        return;
      }
      var a = act.getAttribute('data-act');
      if (a === 'close') close();
      else if (a === 'pick') onPick();
      else if (a === 'clear') onClear();
      else if (a === 'save') onSave();
    });

    dom = {
      wrap: wrap,
      img: wrap.querySelector('#cover-preview'),
      empty: wrap.querySelector('#cover-empty'),
      note: wrap.querySelector('#cover-note'),
      save: wrap.querySelector('#cover-save')
    };
    return dom;
  }

  function paint(src) {
    var d = build();
    if (src) {
      d.img.src = src;
      d.img.style.display = '';
      d.empty.style.display = 'none';
    } else {
      d.img.removeAttribute('src');
      d.img.style.display = 'none';
      d.empty.style.display = '';
    }
  }

  function revokePreview() {
    if (cur && cur.previewUrl) {
      try { URL.revokeObjectURL(cur.previewUrl); } catch (e) { /* 忽略 */ }
      cur.previewUrl = null;
    }
  }

  // 打开弹窗：card 为索引行，cb 在保存成功后回调 { changed, blob, path }
  async function open(card, cb) {
    if (!FC.cloudReady) { FC.toast('云服务不可用，请刷新页面重试', 'err'); return; }
    if (!card) { FC.toast('卡片信息加载中，请稍后再试', 'err'); return; }

    var d = build();
    cur = { card: card, cb: cb || function () {}, blob: null, previewUrl: null, remove: false, busy: false };
    d.empty.textContent = '尚无封面';
    d.note.textContent = '可从图片里选一张，也可以恢复为自动生成的封面。';
    d.save.disabled = false;
    d.save.textContent = '保存';
    paint(null);
    d.wrap.classList.add('open');

    // 已有封面：签名后展示当前效果（失败就停在「尚无封面」，不影响换封面）
    if (card.thumb_path) {
      var mine = cur;
      try {
        var u = await FC.signedUrl(card.thumb_path, 1800);
        if (cur === mine && !mine.blob && !mine.remove) paint(u);
      } catch (e) { /* 忽略 */ }
    }
  }

  function close() {
    if (cur && cur.busy) { FC.toast('正在保存，请稍候', 'err'); return; }
    revokePreview();
    if (dom) dom.wrap.classList.remove('open');
    cur = null;
  }

  function onPick() {
    if (!cur || cur.busy) return;
    // 这一句必须与点击同一轮事件循环，否则部分移动端会拦截文件选择
    pickImage().then(function (file) {
      if (!file || !cur) return;
      return makeCoverBlob(file).then(function (blob) {
        if (!cur) return;
        revokePreview();
        cur.blob = blob;
        cur.remove = false;
        cur.previewUrl = URL.createObjectURL(blob);
        paint(cur.previewUrl);
        dom.note.textContent = '已选好新封面，点「保存」生效。';
      });
    }).catch(function (e) {
      FC.toast(FC.errText(e, '封面图片处理失败'), 'err');
    });
  }

  function onClear() {
    if (!cur || cur.busy) return;
    revokePreview();
    cur.blob = null;
    cur.remove = true;
    paint(null);
    dom.empty.textContent = '将恢复默认封面';
    dom.note.textContent = '保存后回到自动生成的封面（若卡片内没有可用图片，则显示首字版式）。';
  }

  async function onSave() {
    if (!cur || cur.busy) return;
    var mine = cur;

    // 没有任何改动：直接关闭，不打扰服务端
    if (!mine.blob && !mine.remove) { close(); return; }

    mine.busy = true;
    dom.save.disabled = true;
    dom.save.textContent = '保存中…';
    var keepPreview = mine.previewUrl;
    mine.previewUrl = null;   // 预览图交给回调方继续使用，这里不回收

    try {
      await applyCover(mine.card, mine.blob);
      var blob = mine.blob;
      var path = mine.card.thumb_path;
      FC.toast(blob ? '封面已更新' : '已恢复默认封面', 'ok');
      cur = null;
      dom.wrap.classList.remove('open');
      try { mine.cb({ changed: true, blob: blob, path: path }); } catch (e) { /* 回调异常不影响 */ }
    } catch (e) {
      FC.toast(FC.errText(e, '封面保存失败，请重试'), 'err');
      mine.busy = false;
      mine.previewUrl = keepPreview;
      dom.save.disabled = false;
      dom.save.textContent = '保存';
    }
  }

  window.FC.cover = {
    pickImage: pickImage,
    makeCoverBlob: makeCoverBlob,
    open: open
  };
})();
