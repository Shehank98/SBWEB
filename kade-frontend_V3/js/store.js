/* Storefront shell shared by store/index, product, cart, order and policy pages.
   Renders the sticky header, footer (with policy links), cards, lazy images, the
   verified seal and rating stars. Works against the live API (KadeApi.enabled) and
   falls back to the mock data in js/data.js for offline demos. */
(function () {
  var K = Kade, D = window.KadeData || {};
  var SF = {};

  /* ---------- Icons (24px outline) ---------- */
  var I = {
    cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    bank: '<path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M9 14v3M15 14v3"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    badge: '<path d="M12 2l2.4 2.1 3.2-.3.8 3.1 2.8 1.6-1.2 3 1.2 3-2.8 1.6-.8 3.1-3.2-.3L12 22l-2.4-2.1-3.2.3-.8-3.1-2.8-1.6 1.2-3-1.2-3 2.8-1.6.8-3.1 3.2.3z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    ret: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    store: '<path d="M3 9l1.5-5h15L21 9M3 9h18v11H3zM9 20v-6h6v6"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
    sort: '<path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    tag: '<path d="M3 11l8-8 10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8"/>',
    shirt: '<path d="M8 3 4 6l2 4 2-1v12h8V9l2 1 2-4-4-3a4 4 0 0 1-8 0z"/>',
    cake: '<path d="M4 21h16v-8H4zM4 16c2 1 4 1 6 0s4-1 6 0 2 1 4 0M12 8v5M12 4v1"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    leaf: '<path d="M5 21c0-9 6-15 16-16-1 10-7 16-16 16zM5 21l8-8"/>',
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
    gift: '<rect x="3" y="8" width="18" height="4"/><path d="M5 12v9h14v-9M12 8v13M12 8S10 3 7.5 4.5 9 8 12 8zM12 8s2-5 4.5-3.5S15 8 12 8z"/>',
    sparkles: '<path d="M9 3l1.5 4.5L15 9l-4.5 1.5L9 15l-1.5-4.5L3 9l4.5-1.5zM18 13l.8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8z"/>'
  };
  SF.ic = function (n, c) { return '<svg class="ic' + (c ? ' ' + c : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (I[n] || I.tag) + '</svg>'; };
  var WA = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" style="stroke:none"><path fill="currentColor" d="M20.5 3.5A11 11 0 0 0 3.2 17.1L2 22l5-1.3A11 11 0 1 0 20.5 3.5Zm-8.5 17a9 9 0 0 1-4.6-1.3l-.3-.2-3 .8.8-2.9-.2-.3A9 9 0 1 1 12 20.5Zm5-6.7c-.3-.1-1.6-.8-1.9-.9s-.4-.1-.6.1-.7.9-.9 1.1-.3.2-.6.1a7.4 7.4 0 0 1-3.7-3.2c-.3-.5.3-.5.8-1.6a.5.5 0 0 0 0-.5l-.9-2.1c-.2-.6-.5-.5-.6-.5h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.2c0-.1-.2-.2-.5-.3Z"/></svg>';
  SF.WA = WA;

  // Category chip icon by keyword (falls back to a tag).
  var CAT_IC = [[/shirt|dress|saree|cloth|fashion|kurta|jacket|batik|wear|frock|sarong|top/i, 'shirt'], [/cake|bak|food|sweet|snack|eat|cupcake|spice|tea/i, 'cake'], [/phone|mobile|charg|audio|case|electr|gadget/i, 'phone'], [/home|decor|kitchen|cushion|garden/i, 'home'], [/beauty|health|skin|care|herbal|organic/i, 'leaf'], [/book|station/i, 'book'], [/gift|toy|kid|craft/i, 'gift'], [/jewel|access|bag|shoe|sandal|watch/i, 'sparkles']];
  SF.catIcon = function (name) { for (var i = 0; i < CAT_IC.length; i++) if (CAT_IC[i][0].test(name)) return CAT_IC[i][1]; return 'tag'; };

  /* ---------- URLs ---------- */
  K.sUrl = function (page, extra) { return page + '?s=' + encodeURIComponent(K.slug()) + (extra || ''); };
  SF.homeUrl = function (slug) { return '/store/' + encodeURIComponent(slug || K.slug()); };
  SF.pUrl = function (p) { return '/store/product?s=' + encodeURIComponent(K.slug()) + '&p=' + encodeURIComponent(p.id); };
  SF.abs = function (u) { return location.origin + u; };
  K.wa = function (store, msg) { return 'https://wa.me/' + String(store.whatsapp || '').replace(/\D/g, '').replace(/^0/, '94') + '?text=' + encodeURIComponent(msg); };

  /* ---------- Small UI helpers ---------- */
  var toastT;
  SF.toast = K.toast = function (msg) {
    var t = document.getElementById('sf-toast');
    if (!t) { t = document.createElement('div'); t.id = 'sf-toast'; t.className = 'sf-toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
    t.innerHTML = SF.ic('check', 'ic-sm') + K.esc(msg); t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2200);
  };
  SF.bump = function (el) { if (!el) return; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); };
  SF.rs = function (n) { return 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-US'); };
  SF.seal = function (s, small) {
    return s && s.verified ? '<span class="seal' + (small ? ' seal--sm' : '') + '" title="This business has been verified by Sidadiya">' + SF.ic('badge') + 'Verified Sri Lankan Business</span>' : '';
  };
  SF.stars = function (avg, count, compact) {
    if (!count) return '';
    return '<span class="stars" aria-label="Rated ' + avg + ' out of 5 from ' + count + ' review' + (count === 1 ? '' : 's') + '">' + SF.ic('star') + Number(avg).toFixed(1) + (compact ? '' : '<span style="color:var(--sf-muted);font-weight:500">&nbsp;(' + count + ')</span>') + '</span>';
  };
  // Lazy image with a fade-in (native loading=lazy + decoding=async).
  SF.img = function (src, alt, eager) {
    return '<img src="' + K.esc(src) + '" alt="' + K.esc(alt || '') + '"' + (eager ? ' fetchpriority="high"' : ' loading="lazy" class="lazy" onload="this.classList.remove(\'lazy\')"') + ' decoding="async">';
  };
  SF.media = function (p, eager) {
    return p && p.image ? SF.img(p.image, p.name, eager) : '<div class="ph" aria-hidden="true">' + K.esc(K.initials(p ? p.name : '?')) + '</div>';
  };
  SF.priceOf = function (p) { return K.fromPrice(p); };
  SF.priceHtml = function (p, id) {
    var h = '<p class="price"' + (id ? ' id="' + id + '"' : '') + '>';
    if (p.variants && p.variants.length) return h + '<small>From</small> ' + SF.rs(K.fromPrice(p)) + '</p>';
    h += SF.rs(K.priceOf(p));
    if (p.sale) h += ' <s>' + SF.rs(p.price) + '</s><span class="off">' + Math.round((1 - p.sale / p.price) * 100) + '% off</span>';
    return h + '</p>';
  };
  SF.stockOf = function (p) { return p.variants && p.variants.length ? p.variants.reduce(function (n, v) { return n + Number(v.stock || 0); }, 0) : p.stock; };
  SF.stockBadge = function (stock, lowAt) {
    if (stock <= 0) return '<span class="badge b-danger">Sold out</span>';
    if (stock <= lowAt) return '<span class="badge b-warn">Only ' + stock + ' left</span>';
    return '<span class="badge b-ok">In stock</span>';
  };

  /* ---------- Wishlist (per store, this browser) ---------- */
  SF.wish = {
    key: function () { return 'kade-wish-' + K.slug(); },
    list: function () { return K.storage.get(SF.wish.key()) || []; },
    has: function (id) { return SF.wish.list().indexOf(id) >= 0; },
    toggle: function (id) { var l = SF.wish.list(), i = l.indexOf(id), on = i < 0; if (on) l.push(id); else l.splice(i, 1); K.storage.set(SF.wish.key(), l); return on; }
  };

  /* ---------- Product card (grid) ---------- */
  SF.card = function (p) {
    var stock = SF.stockOf(p), out = stock <= 0, hasOpts = (p.variants && p.variants.length) || Object.keys(p.options || {}).length > 0;
    var href = SF.pUrl(p), on = SF.wish.has(p.id);
    var action = out ? '<button class="btn btn-block" type="button" disabled>Sold out</button>'
      : hasOpts ? '<a class="btn btn-accent btn-block" href="' + href + '">Choose options</a>'
      : '<button class="btn btn-accent btn-block" type="button" data-add="' + K.esc(p.id) + '">Add to cart</button>';
    var meta = out || stock <= p.lowAt ? SF.stockBadge(stock, p.lowAt) : (p.reviews ? SF.stars(p.rating, p.reviews) : K.esc(p.category || ''));
    return '<article class="card"><a href="' + href + '" aria-labelledby="pn-' + K.esc(p.id) + '"><div class="media">' + SF.media(p) + (p.sale ? '<span class="tag">SALE</span>' : '') + '</div>' +
      '<div class="card-body"><h3 class="pname" id="pn-' + K.esc(p.id) + '">' + K.esc(p.name) + '</h3><p class="pmeta">' + meta + '</p>' + SF.priceHtml(p) + '</div></a>' +
      '<button class="heart" type="button" data-wish="' + K.esc(p.id) + '" aria-pressed="' + on + '" aria-label="Save ' + K.esc(p.name) + ' to wishlist">' + SF.ic('heart') + '</button>' +
      '<div class="card-foot">' + action + '</div></article>';
  };

  /* ---------- Blocked pages ---------- */
  function blocked(title, body) {
    document.documentElement.classList.add('sf');
    document.body.innerHTML = '<main class="gone"><div class="panel"><div style="font-size:44px" aria-hidden="true">🛍️</div><h1>' + K.esc(title) + '</h1><p style="color:var(--sf-muted)">' + K.esc(body) + '</p><a class="btn btn-soft" href="/">Visit Sidadiya</a></div></main>';
    document.title = title;
  }
  var NOT_FOUND = ['Store not found', 'Check the link you were sent, or ask the shop to share it again.'];
  var UNAVAILABLE = ['This store is temporarily unavailable', 'The shop is taking a short break. Please check back soon.'];

  /* ---------- Chrome: header + footer + cart bar ---------- */
  SF.policyLinks = function (s) {
    var P = s.policies || [];
    return P.map(function (p) { return '<a href="/store/policy?s=' + encodeURIComponent(s.slug) + '&p=' + encodeURIComponent(p.key) + '">' + K.esc(p.title) + '</a>'; }).join('');
  };
  function header(s, opts) {
    var logo = s.logo ? '<img src="' + K.esc(s.logo) + '" alt="">' : K.esc(K.initials(s.name));
    var right = opts.checkout
      ? '<span class="secure">' + SF.ic('lock', 'ic-sm') + '<span>Secure checkout</span></span>'
      : '<div class="sf-top__actions"><a class="icon-btn" href="' + K.sUrl('cart') + '" id="cartBtn" aria-label="Open cart">' + SF.ic('cart') + '<span class="sf-count" id="cc" hidden>0</span></a></div>';
    return '<header class="sf-top"><div class="wrap"><a class="sf-brand" href="' + SF.homeUrl(s.slug) + '" aria-label="' + K.esc(s.name) + ' home"><span class="sf-mark">' + logo + '</span><span>' + K.esc(s.name) + '</span></a>' + right + '</div></header>';
  }
  function footer(s) {
    var c = s.contact || {};
    var email = c.email || '', phone = c.phone || s.phone || '', addr = c.address || s.address || '';
    return '<footer class="foot"><div class="wrap">' +
      '<div class="foot-contact"><b>' + K.esc(s.name) + '</b>' + SF.seal(s, true) +
        (addr ? '<span>' + K.esc(addr) + '</span>' : '') +
        (phone ? '<a href="tel:' + K.esc(String(phone).replace(/\s/g, '')) + '">' + K.esc(phone) + '</a>' : '') +
        (email ? '<a href="mailto:' + K.esc(email) + '">' + K.esc(email) + '</a>' : '') + '</div>' +
      '<div><nav class="foot-links" aria-label="Store policies">' + SF.policyLinks(s) + '</nav>' +
      '<a class="powered" href="/" target="_blank" rel="noopener"><span class="mark">S</span>Powered by Sidadiya. Open your own shop in minutes.</a></div>' +
      '</div></footer>';
  }
  SF.cartBar = function () {
    if (document.getElementById('cartbar')) return;
    var b = document.createElement('div'); b.className = 'bar'; b.id = 'cartbar'; b.hidden = true;
    b.innerHTML = '<div class="bar-in"><div class="sum"><small id="cb-items">0 items</small><b id="cb-total">Rs 0</b></div><a class="btn btn-primary" href="' + K.sUrl('cart') + '">View cart →</a></div>';
    document.body.appendChild(b);
  };
  K.updateCartCount = SF.updateCart = function () {
    var slug = K.slug(), n = K.cart.count(slug), c = document.getElementById('cc');
    if (c) { c.textContent = n; c.hidden = !n; c.parentNode.setAttribute('aria-label', 'Open cart, ' + n + ' item' + (n === 1 ? '' : 's')); }
    var bar = document.getElementById('cartbar');
    if (bar) {
      bar.hidden = !n;
      document.getElementById('cb-items').textContent = n + (n === 1 ? ' item' : ' items') + ' in cart';
      document.getElementById('cb-total').textContent = SF.rs(K.cartTotal(slug));
    }
    document.body.classList.toggle('has-bar', !!(n && bar) || !!document.querySelector('#buybar:not([hidden])'));
  };

  function applyChrome(s, opts) {
    document.documentElement.classList.add('sf');
    document.documentElement.setAttribute('data-preset', s.preset || 'tea');
    document.documentElement.setAttribute('data-template', s.template || 'classic');
    var h = document.getElementById('sf-header'); if (h) h.outerHTML = header(s, opts);
    var f = document.getElementById('sf-footer'); if (f) f.outerHTML = footer(s);
    if (opts.cartBar) SF.cartBar();
    SF.updateCart();
  }

  SF.chrome = applyChrome;
  SF.POLICY_LINKS = [{ key: 'refund', title: 'Refund Policy' }, { key: 'return', title: 'Return Policy' }, { key: 'privacy', title: 'Privacy Policy' }, { key: 'terms', title: 'Terms & Conditions' }, { key: 'contact', title: 'Contact Details' }];

  /* Async loader used by every storefront page: cb(store, products). */
  K.loadStore = SF.load = function (cb, opts) {
    opts = opts || {};
    var slug = K.slug();
    if (window.KadeApi && KadeApi.enabled) {
      KadeApi.getStore(slug).then(function (res) {
        if (res.available === false) { blocked(UNAVAILABLE[0], UNAVAILABLE[1]); return; }
        K.storeProducts = res.products || [];
        SF.store = res.store;
        applyChrome(res.store, opts);
        cb(res.store, res.products || []);
      }).catch(function (e) {
        if (e && e.status === 404) blocked(NOT_FOUND[0], NOT_FOUND[1]);
        else blocked('Store unavailable', 'Please check your connection and try again.');
      });
    } else {
      var s = D.stores && D.stores[slug];
      if (!s) { blocked(NOT_FOUND[0], NOT_FOUND[1]); return; }
      if (s.status !== 'ACTIVE') { blocked(UNAVAILABLE[0], UNAVAILABLE[1]); return; }
      var list = D.products.filter(function (p) { return p.store === slug; });
      K.storeProducts = list; SF.store = s;
      applyChrome(s, opts);
      cb(s, list);
    }
  };

  // Policy text renderer (js/md.js), when the page loads it.
  SF.md = function (t) { return window.KadeMd ? window.KadeMd(t) : K.esc(t); };

  window.SF = SF;
})();
