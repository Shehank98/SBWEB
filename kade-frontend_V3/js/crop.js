/* KadeCrop: a small, dependency-free image cropper for logos and covers.
   KadeCrop.open(file, { aspect: 1, round: true, width: 600, height: 600, title: 'Crop your logo' })
     -> Promise<File|null>   (null when the seller cancels)
   Drag to move, pinch / mouse wheel / slider to zoom. The frame is always filled,
   so the result never has empty edges. Output is a new File (PNG for logos that
   may be transparent, JPEG otherwise), never larger than the chosen area. */
(function () {
  'use strict';
  var cropped = typeof WeakSet === 'function' ? new WeakSet() : null;

  function mark(f) { if (f && cropped) cropped.add(f); return f; }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function open(file, o) {
    o = o || {};
    var aspect = o.aspect || 1;
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type) || /svg|gif/.test(file.type)) { resolve(mark(file) || null); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onerror = function () { URL.revokeObjectURL(url); resolve(mark(file)); };
      img.onload = function () { build(img); };
      img.src = url;

      function build(img) {
        var iw = img.naturalWidth, ih = img.naturalHeight;
        var prevFocus = document.activeElement;
        var back = el('div', 'kcrop');
        var box = el('div', 'kcrop__box');
        box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'kcrop-t');
        box.innerHTML =
          '<h2 class="kcrop__title" id="kcrop-t">' + (o.title || 'Crop your image') + '</h2>' +
          '<p class="kcrop__hint">Drag to move. Pinch or use the slider to zoom.</p>' +
          '<div class="kcrop__stage"><div class="kcrop__frame' + (o.round ? ' is-round' : '') + '"></div></div>' +
          '<label class="kcrop__zoom"><span>Zoom</span><input type="range" min="1" max="4" step="0.01" value="1" aria-label="Zoom"></label>' +
          '<div class="kcrop__actions"><button type="button" class="kd-btn kd-btn--ghost" data-k="cancel">Cancel</button>' +
          '<button type="button" class="kd-btn kd-btn--primary" data-k="ok">Use this</button></div>';
        back.appendChild(box); document.body.appendChild(back);
        document.documentElement.style.overflow = 'hidden';

        var stage = box.querySelector('.kcrop__stage'), frame = box.querySelector('.kcrop__frame'), range = box.querySelector('input[type=range]');
        img.className = 'kcrop__img'; img.alt = ''; img.draggable = false;
        stage.insertBefore(img, frame);

        var fw, fh, base, zoom = 1, x = 0, y = 0; // x,y = image top-left relative to frame
        function layout() {
          var maxW = Math.min(stage.clientWidth, 560), maxH = Math.min(window.innerHeight * 0.5, 420);
          fw = maxW; fh = fw / aspect;
          if (fh > maxH) { fh = maxH; fw = fh * aspect; }
          stage.style.height = fh + 'px';
          frame.style.width = fw + 'px'; frame.style.height = fh + 'px';
          frame.style.left = (stage.clientWidth - fw) / 2 + 'px';
          var oldBase = base; base = Math.max(fw / iw, fh / ih);
          if (!oldBase) { x = (fw - iw * base) / 2; y = (fh - ih * base) / 2; }
          paint();
        }
        function clamp() {
          var s = base * zoom, w = iw * s, h = ih * s;
          x = Math.min(0, Math.max(fw - w, x)); y = Math.min(0, Math.max(fh - h, y));
        }
        function paint() {
          clamp();
          var s = base * zoom;
          img.style.width = iw * s + 'px'; img.style.height = ih * s + 'px';
          img.style.transform = 'translate(' + (parseFloat(frame.style.left) + x) + 'px,' + y + 'px)';
        }
        function setZoom(z, cx, cy) {
          z = Math.max(1, Math.min(4, z));
          if (cx == null) { cx = fw / 2; cy = fh / 2; }
          var k = z / zoom; x = cx - (cx - x) * k; y = cy - (cy - y) * k; zoom = z;
          range.value = z; paint();
        }

        // Pointer drag + pinch.
        var pts = {}, last = null, pinch = null;
        function frameXY(e) { var r = frame.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
        stage.addEventListener('pointerdown', function (e) { stage.setPointerCapture(e.pointerId); pts[e.pointerId] = [e.clientX, e.clientY]; last = [e.clientX, e.clientY]; pinch = null; e.preventDefault(); });
        stage.addEventListener('pointermove', function (e) {
          if (!pts[e.pointerId]) return;
          pts[e.pointerId] = [e.clientX, e.clientY];
          var ids = Object.keys(pts);
          if (ids.length >= 2) {
            var a = pts[ids[0]], b = pts[ids[1]], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
            var r = frame.getBoundingClientRect(), mx = (a[0] + b[0]) / 2 - r.left, my = (a[1] + b[1]) / 2 - r.top;
            if (pinch) setZoom(zoom * d / pinch, mx, my);
            pinch = d; return;
          }
          x += e.clientX - last[0]; y += e.clientY - last[1]; last = [e.clientX, e.clientY]; paint();
        });
        function up(e) { delete pts[e.pointerId]; pinch = null; var ids = Object.keys(pts); if (ids.length) last = pts[ids[0]]; }
        stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
        stage.addEventListener('wheel', function (e) { e.preventDefault(); var p = frameXY(e); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), p[0], p[1]); }, { passive: false });
        range.addEventListener('input', function () { setZoom(Number(range.value)); });
        // Keyboard: arrows move, +/- zoom.
        stage.tabIndex = 0; stage.setAttribute('aria-label', 'Image position. Use arrow keys to move, plus and minus to zoom.');
        stage.addEventListener('keydown', function (e) {
          var step = e.shiftKey ? 30 : 8;
          if (e.key === 'ArrowLeft') x += step; else if (e.key === 'ArrowRight') x -= step;
          else if (e.key === 'ArrowUp') y += step; else if (e.key === 'ArrowDown') y -= step;
          else if (e.key === '+' || e.key === '=') { setZoom(zoom * 1.1); return; } else if (e.key === '-') { setZoom(zoom / 1.1); return; } else return;
          e.preventDefault(); paint();
        });

        function close(result) {
          window.removeEventListener('resize', layout); document.removeEventListener('keydown', onKey);
          back.remove(); document.documentElement.style.overflow = '';
          URL.revokeObjectURL(url);
          if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) {}
          resolve(result);
        }
        function onKey(e) { if (e.key === 'Escape') close(null); }
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', layout);
        back.addEventListener('click', function (e) { if (e.target === back) close(null); });
        box.querySelector('[data-k=cancel]').addEventListener('click', function () { close(null); });
        box.querySelector('[data-k=ok]').addEventListener('click', function () {
          var s = base * zoom;
          var sx = -x / s, sy = -y / s, sw = fw / s, sh = fh / s;
          var ow = Math.round(Math.min(o.width || sw, sw)), oh = Math.round(ow / aspect);
          var c = document.createElement('canvas'); c.width = ow; c.height = oh;
          var g = c.getContext('2d');
          var png = o.keepAlpha !== false && /png|webp/.test(file.type);
          if (!png) { g.fillStyle = '#fff'; g.fillRect(0, 0, ow, oh); }
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, sx, sy, sw, sh, 0, 0, ow, oh);
          var type = png ? 'image/png' : 'image/jpeg';
          c.toBlob(function (blob) {
            if (!blob) { close(mark(file)); return; }
            var name = file.name.replace(/\.[^.]+$/, '') + (png ? '.png' : '.jpg');
            var out = new File([blob], name, { type: type, lastModified: Date.now() });
            mark(out);
            close(out);
          }, type, 0.9);
        });

        layout();
        range.focus();
      }
    });
  }

  window.KadeCrop = {
    open: open,
    isCropped: function (f) { return !!(f && cropped && cropped.has(f)); },
    LOGO: { aspect: 1, round: true, width: 600, title: 'Crop your logo' },
    COVER: { aspect: 8 / 3, width: 1600, title: 'Crop your cover photo', keepAlpha: false }
  };
})();
