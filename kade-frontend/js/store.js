/* Storefront shell shared by store/index.html, product.html and cart.html.
   Works against the live API (KadeApi.enabled) and falls back to mock data. */
(function () {
  var K = Kade, D = KadeData;
  K.sUrl = function (page, extra) { return page + '?s=' + encodeURIComponent(K.slug()) + (extra || ''); };
  K.wa = function (store, msg) { return 'https://wa.me/' + store.whatsapp + '?text=' + encodeURIComponent(msg); };
  K.updateCartCount = function () { var c = K.$('#cc'); if (c) { var n = K.cart.count(K.slug()); c.textContent = n; c.parentNode.setAttribute('aria-label', 'Cart, ' + n + ' item' + (n === 1 ? '' : 's')); } };

  function blocked(title, body) {
    document.body.innerHTML = '<main class="unavailable"><div class="kd-card unavailable__card"><a class="wordmark" href="../index.html">Kade</a><h1 class="display-md">' + K.esc(title) + '</h1><p class="muted">' + K.esc(body) + '</p><a class="kd-btn kd-btn--secondary" href="../index.html">Back to Kade</a></div></main>';
    document.title = title;
  }
  var NOT_FOUND = ['Store not found', 'Check the link you were sent, or ask the shop to share it again.'];
  var UNAVAILABLE = ['This store is temporarily unavailable', 'The store owner needs to renew their subscription. Please check back soon.'];

  /* Build the store header + footer once the store record is known. */
  function applyChrome(s) {
    K.applyStore(s);
    K.$('#store-header').outerHTML = '<header class="store-header"><div class="container"><span class="store-logo" aria-hidden="true">' + K.esc(K.initials(s.name)) + '</span>' +
      '<a class="store-name" href="' + K.sUrl('index.html') + '">' + K.esc(s.name) + '</a>' +
      '<a class="cart-link" href="' + K.sUrl('cart.html') + '">' + K.icon('cart').replace('<svg ', '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ') + '<span>Cart</span><span class="cart-count" id="cc">0</span></a></div></header>';
    var pays = [s.payments.cod && 'Cash on delivery', s.payments.bank && 'Bank transfer', s.payments.online && 'Card payment'].filter(Boolean).join(', ');
    K.$('#store-footer').outerHTML = '<footer class="store-footer"><div class="container"><div class="row"><div class="stack" style="gap:4px;flex:1;min-width:200px"><strong>' + K.esc(s.name) + '</strong><span class="muted">' + K.esc(s.about) + '</span></div>' +
      '<div class="stack" style="gap:4px;flex:1;min-width:200px"><strong>Contact</strong><span>' + K.esc(s.address) + '</span>' + (s.phone ? '<a class="kd-link" href="tel:' + K.esc(s.phone.replace(/\s/g, '')) + '">' + K.esc(s.phone) + '</a>' : '') + '</div>' +
      '<div class="stack" style="gap:4px;flex:1;min-width:200px"><strong>We accept</strong><span>' + K.esc(pays) + '</span></div></div><p class="muted" style="margin-top:24px">Store powered by <a class="kd-link" href="../index.html">Kade</a></p></div></footer>';
    K.updateCartCount();
  }

  /* Mock synchronous init (offline prototype). Returns the store or null. */
  K.storeInit = function () {
    var s = D.stores[K.slug()];
    if (!s) { blocked(NOT_FOUND[0], NOT_FOUND[1]); return null; }
    if (s.status !== 'ACTIVE') { blocked(UNAVAILABLE[0], UNAVAILABLE[1]); return null; }
    applyChrome(s);
    return s;
  };

  /* Async loader used by all storefront pages: cb(store, products). Uses the API
     when enabled, otherwise the mock data. Renders the unavailable/not-found page itself. */
  K.loadStore = function (cb) {
    var slug = K.slug();
    if (window.KadeApi && KadeApi.enabled) {
      KadeApi.getStore(slug).then(function (res) {
        if (res.available === false) { blocked(UNAVAILABLE[0], UNAVAILABLE[1]); return; }
        applyChrome(res.store);
        cb(res.store, res.products || []);
      }).catch(function (e) {
        if (e && e.status === 404) blocked(NOT_FOUND[0], NOT_FOUND[1]);
        else blocked('Store unavailable', 'Please try again in a moment.');
      });
    } else {
      var s = D.stores[slug];
      if (!s) { blocked(NOT_FOUND[0], NOT_FOUND[1]); return; }
      if (s.status !== 'ACTIVE') { blocked(UNAVAILABLE[0], UNAVAILABLE[1]); return; }
      applyChrome(s);
      cb(s, D.products.filter(function (p) { return p.store === slug; }));
    }
  };

  K.priceHtml = function (p) { return '<span class="kd-price">' + K.rs(K.priceOf(p)) + (p.sale ? '<s>' + K.rs(p.price) + '</s>' : '') + '</span>'; };
})();
