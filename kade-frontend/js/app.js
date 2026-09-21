/* Shared helpers: formatting, badges, toast, confirm dialog, cart, app shell, bar chart. Plain script, no build step. */
(function () {
  var D = window.KadeData;
  var K = {};
  var mem = {};

  /* ---------- Small utilities ---------- */
  K.host = 'kade.lk'; /* placeholder platform domain */
  K.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  K.rs = function (n) { return 'Rs. ' + Math.round(Number(n)).toLocaleString('en-US'); };
  K.fmtDate = function (iso) { if (!iso) return 'None'; return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  K.daysUntil = function (iso) { var a = new Date(D.today + 'T00:00:00'), b = new Date(iso + 'T00:00:00'); return Math.round((b - a) / 86400000); };
  K.initials = function (name) { return String(name).replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(); };
  K.priceOf = function (p) { return p.sale || p.price; };
  K.$ = function (sel, root) { return (root || document).querySelector(sel); };
  K.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  K.storage = {
    get: function (k) { try { var v = localStorage.getItem(k); return v == null ? (mem[k] === undefined ? null : mem[k]) : JSON.parse(v); } catch (e) { return mem[k] === undefined ? null : mem[k]; } },
    set: function (k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: keep in memory */ } }
  };

  /* ---------- Status badges (word + shape, never colour alone) ---------- */
  var BADGES = {
    order: { PENDING: ['warning', 'Pending'], CONFIRMED: ['info', 'Confirmed'], PROCESSING: ['info', 'Processing'], READY_TO_SHIP: ['info', 'Ready to ship'], SHIPPED: ['info', 'Shipped'], DELIVERED: ['success', 'Delivered'], CANCELLED: ['danger', 'Cancelled'] },
    sub: { PENDING_PAYMENT: ['neutral', 'Pending payment'], PENDING_APPROVAL: ['warning', 'Pending approval'], ACTIVE: ['success', 'Active'], EXPIRING: ['warning', 'Expiring'], GRACE_PERIOD: ['warning', 'Grace period'], SUSPENDED: ['danger', 'Suspended'], CANCELLED: ['danger', 'Cancelled'] },
    pay: { PENDING: ['warning', 'Pending review'], APPROVED: ['success', 'Approved'], REJECTED: ['danger', 'Rejected'] }
  };
  K.ORDER_FLOW = ['PENDING', 'CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'];
  K.orderLabel = function (s) { return BADGES.order[s][1]; };
  K.badge = function (kind, key) { var b = BADGES[kind][key] || ['neutral', key]; return '<span class="kd-badge kd-badge--' + b[0] + '">' + K.esc(b[1]) + '</span>'; };
  K.stockBadge = function (p) {
    if (p.stock <= 0) return '<span class="kd-badge kd-badge--danger">Out of stock</span>';
    if (p.stock <= p.lowAt) return '<span class="kd-badge kd-badge--warning">Low stock</span>';
    return '<span class="kd-badge kd-badge--success">In stock</span>';
  };
  K.ph = function (p, small) {
    // Real product photo when we have one; otherwise a tinted initials tile.
    if (p && p.image) return '<img class="ph ph--img' + (small ? ' ph--sm' : '') + '" src="' + K.esc(p.image) + '" alt="' + K.esc(p.name) + '" loading="lazy" decoding="async">';
    return '<div class="ph' + (small ? ' ph--sm' : '') + '" data-tone="' + K.esc(p.tone || 'f') + '" role="img" aria-label="' + K.esc(p.name) + ' (photo placeholder)">' + K.esc(K.initials(p.name)) + '</div>';
  };

  /* ---------- Loading spinner ---------- */
  K.spinner = function () { return '<span class="kd-spinner" role="status" aria-label="Loading"></span>'; };
  K.loading = function (el, msg) { if (el) el.innerHTML = '<div class="kd-loading">' + K.spinner() + '<p>' + K.esc(msg || 'Loading…') + '</p></div>'; };
  K.btnLoading = function (btn, msg) { if (!btn) return function () {}; var html = btn.innerHTML; btn.disabled = true; btn.innerHTML = K.spinner() + ' ' + K.esc(msg || 'Please wait…'); return function () { btn.disabled = false; btn.innerHTML = html; }; };

  /* ---------- Toast ---------- */
  K.toast = function (msg) {
    var r = K.$('.toast-region');
    if (!r) { r = document.createElement('div'); r.className = 'toast-region'; r.setAttribute('role', 'status'); r.setAttribute('aria-live', 'polite'); document.body.appendChild(r); }
    r.innerHTML = '<div class="toast">' + K.esc(msg) + '</div>';
    clearTimeout(K._t); K._t = setTimeout(function () { r.innerHTML = ''; }, 3200);
  };

  /* ---------- Confirm dialog ---------- */
  K.confirm = function (o) {
    return new Promise(function (resolve) {
      var d = document.createElement('dialog');
      d.setAttribute('aria-labelledby', 'cf-title');
      d.innerHTML = '<form method="dialog"><div class="dialog__head"><h2 class="heading" id="cf-title">' + K.esc(o.title) + '</h2></div>' +
        '<div class="dialog__body"><p>' + K.esc(o.body || '') + '</p>' + (o.reason ? '<div class="kd-field"><label class="kd-label" for="cf-reason">' + K.esc(o.reason) + '</label><textarea class="kd-input" id="cf-reason" name="reason" required></textarea></div>' : '') + '</div>' +
        '<div class="dialog__foot"><button class="kd-btn kd-btn--ghost" value="cancel" formnovalidate>Cancel</button><button class="kd-btn ' + (o.danger ? 'kd-btn--danger' : 'kd-btn--primary') + '" value="ok">' + K.esc(o.confirmLabel || 'Confirm') + '</button></div></form>';
      document.body.appendChild(d);
      d.addEventListener('close', function () { var ok = d.returnValue === 'ok'; var ta = d.querySelector('textarea'); var reason = ta ? ta.value : ''; d.remove(); resolve(o.reason ? (ok ? { reason: reason } : false) : ok); });
      d.showModal();
    });
  };

  /* ---------- Cart (per store) ---------- */
  K.cart = {
    key: function (slug) { return 'kade-cart-' + slug; },
    get: function (slug) { return K.storage.get(K.cart.key(slug)) || []; },
    set: function (slug, items) { K.storage.set(K.cart.key(slug), items); },
    count: function (slug) { return K.cart.get(slug).reduce(function (n, i) { return n + i.qty; }, 0); },
    add: function (slug, item) {
      var items = K.cart.get(slug), sig = JSON.stringify(item.opts || {});
      var hit = items.filter(function (i) { return i.pid === item.pid && JSON.stringify(i.opts || {}) === sig; })[0];
      if (hit) hit.qty += item.qty; else items.push(item);
      K.cart.set(slug, items);
    },
    clear: function (slug) { K.cart.set(slug, []); }
  };
  K.newOrders = { get: function () { return K.storage.get('kade-new-orders') || []; }, add: function (o) { var l = K.newOrders.get(); l.unshift(o); K.storage.set('kade-new-orders', l); } };

  /* ---------- Store helpers ---------- */
  K.slug = function () {
    var q = new URLSearchParams(location.search).get('s'); if (q) return q;
    var m = location.pathname.match(/\/store\/([^\/]+)\/?$/); if (m && !/\.html$/.test(m[1])) return m[1];
    return 'abc-fashion';
  };
  K.applyStore = function (s) { document.documentElement.setAttribute('data-preset', s.preset); document.title = s.name; };
  K.storeUrl = function (slug) { return location.origin.replace(/^null$/, '') + location.pathname.replace(/\/(dashboard|admin|store)\/[^\/]*$/, '/store/index.html') + '?s=' + slug; };

  /* ---------- Icons (24px outline, 1.5px stroke) ---------- */
  var ICON = {
    home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    bag: '<path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/>',
    box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8"/>',
    card: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    shop: '<path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9c0 1.7 1.3 3 2.7 3S9.3 10.7 9.3 9c0 1.7 1.3 3 2.7 3s2.7-1.300 2.7-3c0 1.700 1.300 3 2.700 3S20 10.700 20 9M9 20v-5h6v5"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    cart: '<path d="M3 4h2l2.4 11h10.200L20 8H6.200"/><circle cx="9" cy="19" r="1.500"/><circle cx="17" cy="19" r="1.500"/>'
  };
  K.icon = function (n) { return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICON[n] + '</svg>'; };

  /* ---------- App shell (owner dashboard and admin) ---------- */
  K.shell = function (kind, active) {
    var pendingOrders = K.orders().filter(function (o) { return o.status === 'PENDING'; }).length;
    var pendingApprovals = D.businesses.filter(function (b) { return b.status === 'PENDING_APPROVAL'; }).length;
    var pendingPay = D.payments.filter(function (p) { return p.status === 'PENDING'; }).length;
    var items = kind === 'admin'
      ? [['index', 'Overview', 'home'], ['businesses', 'Businesses', 'shop', pendingApprovals], ['payments', 'Payments', 'receipt', pendingPay]]
      : [['index', 'Overview', 'home'], ['orders', 'Orders', 'bag', pendingOrders], ['products', 'Products', 'box'], ['subscription', 'Subscription', 'card'], ['settings', 'Store settings', 'gear']];
    var nav = items.map(function (i) {
      return '<a href="' + i[0] + '.html"' + (i[0] === active ? ' aria-current="page"' : '') + '>' + K.icon(i[2]) + '<span>' + i[1] + '</span>' + (i[3] ? '<span class="count" aria-label="' + i[3] + ' waiting">' + i[3] + '</span>' : '') + '</a>';
    }).join('');
    var ctx = kind === 'admin' ? 'Platform admin' : 'ABC Fashion';
    var foot = kind === 'admin'
      ? '<a class="kd-link" href="../login.html">Log out</a>'
      : '<a class="kd-link" href="../store/index.html?s=abc-fashion" target="_blank" rel="noopener">View my store</a><a class="kd-link" href="../login.html">Log out</a>';
    var sb = K.$('#sidebar');
    sb.innerHTML = '<div class="sidebar__brand"><a class="wordmark" href="../index.html">Kade</a><span class="sidebar__ctx">' + (kind === 'admin' ? 'Admin panel' : 'Owner dashboard') + '</span></div>' +
      '<nav class="nav" aria-label="Main">' + nav + '</nav><div class="sidebar__foot">' + foot + '</div>';
    var tb = K.$('#topbar');
    tb.innerHTML = '<div class="row"><button class="kd-btn kd-btn--secondary menu-btn" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="sidebar">' + K.icon('menu') + '</button><strong>' + K.esc(ctx) + '</strong></div>' +
      '<div class="row"><button class="kd-btn kd-btn--ghost" type="button" id="theme-toggle"></button></div>';
    var btn = K.$('.menu-btn'), scrim = null;
    function close() { sb.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); if (scrim) { scrim.remove(); scrim = null; } }
    btn.addEventListener('click', function () {
      if (sb.classList.contains('open')) return close();
      sb.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
      scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.addEventListener('click', close); document.body.appendChild(scrim);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    var tt = K.$('#theme-toggle');
    function paint() { var dark = document.documentElement.getAttribute('data-theme') === 'dark'; tt.textContent = dark ? 'Switch to light' : 'Switch to dark'; }
    tt.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('kade-theme', next); } catch (e) { /* ignore */ }
      paint();
    });
    paint();
  };

  /* All orders for the demo business: seeded ones plus any placed through the demo storefront in this browser. */
  K.orders = function () { return K.newOrders.get().filter(function (o) { return o.business === 'abc-fashion'; }).concat(D.orders); };

  /* ---------- Bar chart: single series, one baseline, hover + keyboard tooltip, table view ---------- */
  function nice(max) {
    var pow = Math.pow(10, Math.floor(Math.log10(max / 4)));
    var m = [1, 2, 2.5, 5, 10].filter(function (x) { return x * pow * 4 >= max; })[0] || 10;
    var step = m * pow; return { step: step, top: Math.ceil(max / step) * step };
  }
  function compact(v) { if (v >= 1e6) return (Math.round(v / 1e5) / 10) + 'M'; if (v >= 1e3) return (Math.round(v / 100) / 10) + 'K'; return String(v); }
  K.bars = function (el, data, o) {
    o = o || {};
    var W = 640, H = 240, ml = 44, mr = 8, mt = 24, mb = 28, pw = W - ml - mr, ph = H - mt - mb;
    var max = Math.max.apply(null, data.map(function (d) { return d.value; }));
    var sc = nice(max), band = pw / data.length, bw = Math.min(24, band * 0.5);
    var y = function (v) { return mt + ph - (v / sc.top) * ph; };
    var maxI = data.reduce(function (m, d, i) { return d.value > data[m].value ? i : m; }, 0), lastI = data.length - 1;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + K.esc(o.label || 'Bar chart') + '">';
    for (var t = 0; t <= sc.top + 0.001; t += sc.step) {
      svg += '<line class="grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + y(t) + '" y2="' + y(t) + '"/><text class="axis" x="' + (ml - 8) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + compact(t) + '</text>';
    }
    data.forEach(function (d, i) {
      var cx = ml + band * i + band / 2, x = cx - bw / 2, top = y(d.value), h = mt + ph - top, r = Math.min(4, h / 2);
      svg += '<rect class="hit" tabindex="0" data-i="' + i + '" x="' + (cx - band / 2) + '" y="' + mt + '" width="' + band + '" height="' + ph + '" aria-label="' + K.esc(d.label + ': ' + (o.format || K.rs)(d.value)) + '"/>';
      svg += '<path class="bar" style="pointer-events:none" d="M' + x + ' ' + (mt + ph) + 'V' + (top + r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' -' + r + 'H' + (x + bw - r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + 'V' + (mt + ph) + 'Z"/>';
      svg += '<text class="axis" x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + K.esc(d.label) + '</text>';
      if (i === maxI || i === lastI) svg += '<text class="val" x="' + cx + '" y="' + (top - 6) + '" text-anchor="middle">' + compact(d.value) + '</text>';
    });
    svg += '</svg>';
    var fmt = o.format || K.rs;
    var table = '<table class="kd-table"><caption class="visually-hidden">' + K.esc(o.label || 'Chart data') + '</caption><thead><tr><th scope="col">' + K.esc(o.xLabel || 'Period') + '</th><th scope="col" class="kd-num">' + K.esc(o.yLabel || 'Value') + '</th></tr></thead><tbody>' +
      data.map(function (d) { return '<tr><td>' + K.esc(d.label) + '</td><td class="kd-num">' + fmt(d.value) + '</td></tr>'; }).join('') + '</tbody></table>';
    el.innerHTML = '<div class="chart">' + svg + '<div class="chart-tip" hidden></div></div><div class="row" style="margin-top:8px"><button type="button" class="kd-btn kd-btn--ghost kd-btn--sm" aria-expanded="false">View as table</button></div><div class="table-wrap" hidden>' + table + '</div>';
    var chart = K.$('.chart', el), tip = K.$('.chart-tip', el), sv = K.$('svg', el);
    function show(i) {
      var d = data[i], rect = sv.getBoundingClientRect(), k = rect.width / W;
      tip.hidden = false; tip.innerHTML = K.esc(d.title || d.label) + '<br><b>' + fmt(d.value) + '</b>';
      tip.style.left = (ml + band * i + band / 2) * k + 'px'; tip.style.top = (y(d.value) - 8) * k + 'px';
    }
    K.$$('.hit', el).forEach(function (h) {
      var i = +h.getAttribute('data-i');
      h.addEventListener('mouseenter', function () { show(i); }); h.addEventListener('focus', function () { show(i); });
      h.addEventListener('mouseleave', function () { tip.hidden = true; }); h.addEventListener('blur', function () { tip.hidden = true; });
    });
    var tb = K.$('button', el), tw = K.$('.table-wrap', el);
    tb.addEventListener('click', function () { var open = tw.hidden; tw.hidden = !open; tb.setAttribute('aria-expanded', String(open)); tb.textContent = open ? 'Hide table' : 'View as table'; });
  };

  window.Kade = K;
})();
