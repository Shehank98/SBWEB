/* Main Sidadiya site footer: the five legal pages and the platform contact details
   (from Admin Settings via GET /api/site). Fills <footer id="site-footer">. Renders
   the links immediately, then adds contact details when they load. */
(function () {
  var el = document.getElementById('site-footer'); if (!el) return;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var LINKS = [['refund', 'Refund Policy'], ['return', 'Return Policy'], ['privacy', 'Privacy Policy'], ['terms', 'Terms & Conditions'], ['contact', 'Contact Details']];
  function paint(c) {
    c = c || {};
    var contact = [
      c.email ? '<a class="kd-link" href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>' : '',
      c.phone ? '<a class="kd-link" href="tel:' + esc(String(c.phone).replace(/\s/g, '')) + '">' + esc(c.phone) + '</a>' : '',
      c.whatsapp ? '<a class="kd-link" href="https://wa.me/' + esc(String(c.whatsapp).replace(/\D/g, '').replace(/^0/, '94')) + '" target="_blank" rel="noopener">WhatsApp ' + esc(c.whatsapp) + '</a>' : '',
      c.address ? '<span>' + esc(c.address) + '</span>' : ''
    ].filter(Boolean);
    el.innerHTML = '<div class="container site-footer__grid">' +
      '<div class="stack" style="gap:6px"><strong>' + esc(c.businessName || 'Sidadiya') + '</strong><span class="muted">Online shops for small businesses in Sri Lanka.</span>' + (contact.length ? '<address class="site-footer__contact">' + contact.join('') + '</address>' : '') + '</div>' +
      '<nav aria-label="Legal" class="site-footer__links">' + LINKS.map(function (l) { return '<a href="/legal/' + l[0] + '">' + l[1] + '</a>'; }).join('') + '</nav>' +
      '<div class="site-footer__links"><a href="/login">Log in</a><a href="/register">Start free trial</a></div></div>' +
      '<p class="container muted" style="font-size:13px;margin-top:12px">© ' + new Date().getFullYear() + ' ' + esc(c.businessName || 'Sidadiya') + '. All rights reserved.</p>';
  }
  paint(null);
  if (window.KadeApi && KadeApi.enabled && KadeApi.site) KadeApi.site().then(function (r) { paint(r.contact); window.KadeSite = r; document.dispatchEvent(new CustomEvent('kade-site', { detail: r })); }).catch(function () {});
})();
