/* Storefront shell shared by store/index.html, product.html and cart.html.
   Works against the live API (KadeApi.enabled) and falls back to mock data. */
(function () {
  var K = Kade, D = KadeData;
  K.sUrl = function (page, extra) { return page + '?s=' + encodeURIComponent(K.slug()) + (extra || ''); };
  K.wa = function (store, msg) { return 'https://wa.me/' + store.whatsapp + '?text=' + encodeURIComponent(msg); };
  K.updateCartCount = function () {
    var n = K.cart.count(K.slug()), c = K.$('#cc');
    if (c) { c.textContent = n; c.parentNode.setAttribute('aria-label', 'Cart, ' + n + ' item' + (n === 1 ? '' : 's')); }
    var bar = K.$('#cartbar');
    if (bar) { bar.hidden = n === 0; document.body.classList.toggle('has-cartbar', n > 0); K.$('#cb-n', bar).textContent = n + (n === 1 ? ' item' : ' items'); K.$('#cb-t', bar).textContent = K.rs(K.cartTotal(K.slug())); }
  };

  function blocked(title, body) {
    document.body.innerHTML = '<main class="unavailable"><div class="kd-card unavailable__card"><a class="wordmark" href="../index">Sidadiya</a><h1 class="display-md">' + K.esc(title) + '</h1><p class="muted">' + K.esc(body) + '</p><a class="kd-btn kd-btn--secondary" href="../index">Back to Sidadiya</a></div></main>';
    document.title = title;
  }
  var NOT_FOUND = ['Store not found', 'Check the link you were sent, or ask the shop to share it again.'];
  var UNAVAILABLE = ['This store is temporarily unavailable', 'The store owner needs to renew their subscription. Please check back soon.'];

  /* Build the store header, footer and (optionally) the mobile cart bar. */
  function applyChrome(s, opts) {
    opts = opts || {};
    K.applyStore(s);
    K.$('#store-header').outerHTML = '<header class="store-header"><div class="container"><span class="store-logo" aria-hidden="true">' + K.esc(K.initials(s.name)) + '</span>' +
      '<a class="store-name" href="' + K.sUrl('index') + '">' + K.esc(s.name) + '</a>' +
      '<a class="cart-link" href="' + K.sUrl('cart') + '">' + K.icon('cart').replace('<svg ', '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ') + '<span>Cart</span><span class="cart-count" id="cc">0</span></a></div></header>';
    var pays = [s.payments.cod && 'Cash on delivery', s.payments.bank && 'Bank transfer', s.payments.online && 'Card payment'].filter(Boolean).join(', ');
    K.$('#store-footer').outerHTML = '<footer class="store-footer"><div class="container"><div class="row"><div class="stack" style="gap:4px;flex:1;min-width:200px"><strong>' + K.esc(s.name) + '</strong><span class="muted">' + K.esc(s.about) + '</span></div>' +
      '<div class="stack" style="gap:4px;flex:1;min-width:200px"><strong>Contact</strong><span>' + K.esc(s.address) + '</span>' + (s.phone ? '<a class="kd-link" href="tel:' + K.esc(s.phone.replace(/\s/g, '')) + '">' + K.esc(s.phone) + '</a>' : '') + '</div>' +
      '<div class="stack" style="gap:4px;flex:1;min-width:200px"><strong>We accept</strong><span>' + K.esc(pays) + '</span></div></div><p class="muted" style="margin-top:24px">Store powered by <a class="kd-link" href="../index">Sidadiya</a></p></div></footer>';
    if (opts.cartBar && !K.$('#cartbar')) { var cb = document.createElement('a'); cb.id = 'cartbar'; cb.className = 'cart-bar'; cb.hidden = true; cb.href = K.sUrl('cart'); cb.innerHTML = '<span><strong id="cb-n"></strong> in your cart</span><span class="cart-bar__go"><b id="cb-t"></b> View cart</span>'; document.body.appendChild(cb); }
    K.updateCartCount();
  }

  /* Mock synchronous init (offline prototype). Returns the store or null. */
  K.storeInit = function (opts) {
    var s = D.stores[K.slug()];
    if (!s) { blocked(NOT_FOUND[0], NOT_FOUND[1]); return null; }
    if (s.status !== 'ACTIVE') { blocked(UNAVAILABLE[0], UNAVAILABLE[1]); return null; }
    applyChrome(s, opts);
    return s;
  };

  /* Async loader used by all storefront pages: cb(store, products). Uses the API
     when enabled (rendering unavailable/not-found on 200/404), else mock data. */
  K.loadStore = function (cb, opts) {
    var slug = K.slug();
    if (window.KadeApi && KadeApi.enabled) {
      KadeApi.getStore(slug).then(function (res) {
        if (res.available === false) { blocked(UNAVAILABLE[0], UNAVAILABLE[1]); return; }
        K.storeProducts = res.products || [];
        applyChrome(res.store, opts);
        cb(res.store, res.products || []);
      }).catch(function (e) {
        if (e && e.status === 404) blocked(NOT_FOUND[0], NOT_FOUND[1]);
        else blocked('Store unavailable', 'Please try again in a moment.');
      });
    } else {
      var s = D.stores[slug];
      if (!s) { blocked(NOT_FOUND[0], NOT_FOUND[1]); return; }
      if (s.status !== 'ACTIVE') { blocked(UNAVAILABLE[0], UNAVAILABLE[1]); return; }
      var list = D.products.filter(function (p) { return p.store === slug; });
      K.storeProducts = list;
      applyChrome(s, opts);
      cb(s, list);
    }
  };

  K.priceHtml = function (p) {
    if (p.variants && p.variants.length) return '<span class="kd-price"><span class="kd-price__from">From</span> ' + K.rs(K.fromPrice(p)) + '</span>';
    return '<span class="kd-price">' + K.rs(K.priceOf(p)) + (p.sale ? '<s>' + K.rs(p.price) + '</s>' : '') + '</span>';
  };

  /* Product-page media: a big cover image plus a clickable thumbnail strip when the
     product has more than one photo. Falls back to the placeholder tile when it has none. */
  K.pdpMedia = function (p) {
    var imgs = (p.images && p.images.length) ? p.images : (p.image ? [p.image] : []);
    if (!imgs.length) return '<div class="pdp__media"><div class="pdp__main">' + K.ph(p) + '</div></div>';
    var main = '<div class="pdp__main"><img id="pdp-main" class="ph ph--img" src="' + K.esc(imgs[0]) + '" alt="' + K.esc(p.name) + '" decoding="async"></div>';
    var thumbs = imgs.length > 1
      ? '<div class="pdp__thumbs" aria-label="Product photos">' + imgs.map(function (u, i) {
          return '<button type="button" class="pdp__thumb' + (i === 0 ? ' is-active' : '') + '" data-src="' + K.esc(u) + '" aria-current="' + (i === 0) + '" aria-label="Show photo ' + (i + 1) + '"><img src="' + K.esc(u) + '" alt="" loading="lazy"></button>';
        }).join('') + '</div>'
      : '';
    return '<div class="pdp__media">' + main + thumbs + '</div>';
  };
})();
