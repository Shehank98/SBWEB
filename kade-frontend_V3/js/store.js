/* Storefront shell shared by store/index.html, product.html and cart.html. */
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
    document.body.innerHTML = '<main class="unavailable"><div class="kd-card unavailable__card"><a class="wordmark" href="../index.html">Kade</a><h1 class="display-md">' + K.esc(title) + '</h1><p class="muted">' + K.esc(body) + '</p><a class="kd-btn kd-btn--secondary" href="../index.html">Back to Kade</a></div></main>';
    document.title = title;
  }

  /* Returns the store, or null after rendering an unavailable / not-found page. */
  K.storeInit = function (opts) {
    opts = opts || {};
    var s = D.stores[K.slug()];
    if (!s) { blocked('Store not found', 'Check the link you were sent, or ask the shop to share it again.'); return null; }
    if (s.status !== 'ACTIVE') { blocked('This store is temporarily unavailable', 'The store owner needs to renew their subscription. Please check back soon.'); return null; }
    K.applyStore(s);
    K.$('#store-header').outerHTML = '<header class="store-header"><div class="container"><span class="store-logo" aria-hidden="true">' + K.esc(K.initials(s.name)) + '</span>' +
      '<a class="store-name" href="' + K.sUrl('index.html') + '">' + K.esc(s.name) + '</a>' +
      '<a class="cart-link" href="' + K.sUrl('cart.html') + '">' + K.icon('cart').replace('<svg ', '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ') + '<span>Cart</span><span class="cart-count" id="cc">0</span></a></div></header>';
    var pays = [s.payments.cod && 'Cash on delivery', s.payments.bank && 'Bank transfer', s.payments.online && 'Card payment'].filter(Boolean).join(', ');
    K.$('#store-footer').outerHTML = '<footer class="store-footer"><div class="container"><div class="row"><div class="stack" style="gap:4px;flex:1;min-width:200px"><strong>' + K.esc(s.name) + '</strong><span class="muted">' + K.esc(s.about) + '</span></div>' +
      '<div class="stack" style="gap:4px;flex:1;min-width:200px"><strong>Contact</strong><span>' + K.esc(s.address) + '</span><a class="kd-link" href="tel:' + K.esc(s.phone.replace(/\s/g, '')) + '">' + K.esc(s.phone) + '</a></div>' +
      '<div class="stack" style="gap:4px;flex:1;min-width:200px"><strong>We accept</strong><span>' + K.esc(pays) + '</span></div></div><p class="muted" style="margin-top:24px">Store powered by <a class="kd-link" href="../index.html">Kade</a></p></div></footer>';
    if (opts.cartBar) { var cb = document.createElement('a'); cb.id = 'cartbar'; cb.className = 'cart-bar'; cb.hidden = true; cb.href = K.sUrl('cart.html'); cb.innerHTML = '<span><strong id="cb-n"></strong> in your cart</span><span class="cart-bar__go"><b id="cb-t"></b> View cart</span>'; document.body.appendChild(cb); }
    K.updateCartCount();
    return s;
  };
  K.priceHtml = function (p) { return '<span class="kd-price">' + K.rs(K.priceOf(p)) + (p.sale ? '<s>' + K.rs(p.price) + '</s>' : '') + '</span>'; };

  /* Cover banner + identity card for the storefront home page. Uses an uploaded
     cover photo when the owner has one, otherwise a pattern woven from the
     store's own brand colour, so a new shop still looks designed on day one. */
  K.storeCoverHtml = function (s) {
    var style = s.cover ? ' style="background-image:url(\'' + s.cover + '\')"' : '';
    var kind = s.cover ? 'photo' : (s.coverStyle || 'plain');
    return '<div class="store-cover" data-cover="' + kind + '"' + style + '></div>' +
      '<div class="container"><div class="store-identity st-reveal">' +
      '<span class="store-identity__logo" aria-hidden="true">' + K.esc(K.initials(s.name)) + '</span>' +
      '<div class="store-identity__text"><h1 id="h1">' + K.esc(s.name) + '</h1><p id="tag">' + K.esc(s.tagline) + '</p></div>' +
      '<div class="store-identity__actions"><a class="kd-btn kd-btn--secondary" id="wa" href="#" target="_blank" rel="noopener">Chat on WhatsApp</a>' +
      '<button type="button" class="kd-btn kd-btn--ghost store-identity__icon-btn" id="shareStore" aria-label="Share this store">' + K.icon('share') + '</button></div>' +
      '</div><div class="store-trust st-reveal" id="trust">' + K.storeTrustHtml(s) + '</div></div>';
  };
  K.storeTrustHtml = function (s) {
    var chips = [];
    if (s.payments.cod) chips.push([K.icon('truck'), 'Cash on delivery']);
    if (s.payments.bank) chips.push([K.icon('card'), 'Bank transfer']);
    if (s.delivery.pickup) chips.push([K.icon('shop'), 'Pickup from the shop']);
    chips.push([K.icon('shield'), s.delivery.freeAbove > 0 ? 'Free delivery above ' + K.rs(s.delivery.freeAbove) : 'Delivery islandwide']);
    return chips.map(function (c) { return '<span>' + c[0] + c[1] + '</span>'; }).join('');
  };
  /* Wire up the cover's WhatsApp link and share button once it is in the DOM. */
  K.storeCoverWire = function (s) {
    var wa = K.$('#wa'); if (wa) wa.href = K.wa(s, 'Hello ' + s.name + ', I have a question about your products.');
    var sh = K.$('#shareStore');
    if (sh) sh.addEventListener('click', function () {
      var url = location.href;
      if (navigator.share) navigator.share({ title: s.name, text: s.tagline, url: url }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { K.toast('Store link copied'); }, function () { K.toast('Copy the link from the address bar'); });
      else K.toast('Copy the link from the address bar');
    });
  };
})();
