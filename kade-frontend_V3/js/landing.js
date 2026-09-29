/* Landing page behaviour: awning, word rotator, live demos, reveal on scroll, sticky CTA.
   Every animation starts only while its section is on screen and is skipped for prefers-reduced-motion. */
(function () {
  var K = Kade, D = KadeData;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = K.$, $$ = K.$$;

  /* ---------- Awning stripes (top of page and above the final call) ---------- */
  function awning(svg, flip) {
    var g = '';
    for (var i = 0; i < 24; i++) {
      var x = i * 64, c = i % 2 ? 'b' : 'a';
      g += '<g class="st" style="--i:' + (flip ? 24 - i : i) + '"><rect class="' + c + '" x="' + x + '" y="0" width="64" height="40"/><path class="sc ' + c + '" style="--i:' + i + '" d="M' + x + ' 39a32 16 0 0 0 64 0z"/></g>';
    }
    svg.innerHTML = g;
  }
  awning($('#awn'), false); awning($('#awn2'), true);

  /* ---------- Helpers ---------- */
  function whenVisible(el, start, threshold) {
    var stop = null;
    if (!('IntersectionObserver' in window)) { stop = start(); return; }
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting && !stop) stop = start() || function () {};
        else if (!e.isIntersecting && stop) { stop(); stop = null; }
      });
    }, { threshold: threshold || 0.25 }).observe(el);
  }
  function loop(fn, ms) { var t = setInterval(function () { if (!document.hidden) fn(); }, ms); return function () { clearInterval(t); }; }

  /* ---------- Reveal on scroll ---------- */
  var reveals = $$('.reveal');
  if (!('IntersectionObserver' in window) || reduce) reveals.forEach(function (r) { r.classList.add('in'); });
  else {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function (r) { io.observe(r); });
  }

  /* ---------- Word rotator in the headline ---------- */
  var words = $$('#rot span'), wi = 0;
  if (!reduce) loop(function () {
    words[wi].className = 'off';
    var prev = words[wi]; wi = (wi + 1) % words.length;
    words[wi].className = 'on';
    setTimeout(function () { if (prev !== words[wi]) prev.className = ''; }, 450);
  }, 2400);

  /* ---------- Marquee of shop types ---------- */
  var TYPES = ['Boutiques', 'Home bakers', 'Mobile shops', 'Handloom sellers', 'Bookshops', 'Spice sellers', 'Salons and beauty', 'Florists', 'Gift shops', 'Pet supplies', 'Plant nurseries', 'Stationery'];
  var rows = TYPES.map(function (t) { return '<span class="lp-marquee__label">' + t + '</span>'; }).join('');
  $('#marq').innerHTML = rows + rows.replace(/class="lp-marquee__label"/g, 'class="lp-marquee__label" aria-hidden="true"');

  /* ---------- Hero: live store on the phone + notifications ---------- */
  var pc = $('#pc'), cards = $$('#psgrid .ps-card'), cartN = 0, ci = 0;
  function tapCard() {
    var em = $('em', cards[ci % cards.length]); em.classList.add('tap');
    setTimeout(function () { em.classList.remove('tap'); cartN++; pc.textContent = cartN; pc.classList.add('bump'); setTimeout(function () { pc.classList.remove('bump'); }, 220); }, 180);
    ci++;
  }
  var ORDERS = [['Nimal, Galle', 'Rs. 9,750'], ['Ayesha, Colombo', 'Rs. 15,300'], ['Kasun, Matara', 'Rs. 5,550'], ['Dilini, Kandy', 'Rs. 9,350']];
  var CHIPS = [['kd-badge--warning', 'Low stock', 'Denim Jacket: 3 left'], ['kd-badge--success', 'Payment approved', 'Green Leaf Organics'], ['kd-badge--info', 'Order shipped', '#ORD-10447 to Negombo']];
  var oi = 0, hi = 0;
  function order() {
    var o = ORDERS[oi++ % ORDERS.length], el = $('#live-order'), n = el.cloneNode(false);
    n.innerHTML = '<span><span class="kd-badge kd-badge--warning">New order</span></span><b>' + o[1] + '</b><span>' + o[0] + '</span>';
    el.parentNode.replaceChild(n, el);
  }
  function chip() {
    var c = CHIPS[hi++ % CHIPS.length], el = $('#live-chip'), n = el.cloneNode(false);
    n.innerHTML = '<span><span class="kd-badge ' + c[0] + '">' + c[1] + '</span></span><span>' + c[2] + '</span>';
    el.parentNode.replaceChild(n, el);
  }
  order(); chip();
  if (!reduce) whenVisible($('.stage'), function () {
    var a = loop(tapCard, 2200), b = loop(order, 4400), c = setTimeout(function () { d = loop(chip, 4400); }, 2200), d;
    return function () { a(); b(); clearTimeout(c); if (d) d(); };
  }, 0.2);

  /* ---------- Bento 1: chat, message -> typing -> link ---------- */
  var chatSteps = $$('#v-chat .step');
  function chatReset() { chatSteps.forEach(function (s) { s.classList.remove('show'); }); }
  function chatPlay() {
    var timers = [];
    function at(ms, fn) { timers.push(setTimeout(fn, ms)); }
    function run() {
      chatReset();
      at(300, function () { chatSteps[0].classList.add('show'); });
      at(1300, function () { chatSteps[1].classList.add('show'); });
      at(2500, function () { chatSteps[1].classList.remove('show'); chatSteps[2].classList.add('show'); });
      at(4000, function () { chatSteps[3].classList.add('show'); });
    }
    run(); var l = loop(run, 8500);
    return function () { timers.forEach(clearTimeout); l(); };
  }
  if (reduce) { chatSteps[0].classList.add('show'); chatSteps[2].classList.add('show'); chatSteps[3].classList.add('show'); } else whenVisible($('#v-chat'), chatPlay, 0.4);

  /* ---------- Bento 2: orders moving through statuses ---------- */
  var FLOW = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED'];
  var LIVE_ORDERS = [{ id: '#10453', who: 'Nimal', s: 0 }, { id: '#10452', who: 'Ayesha', s: 1 }, { id: '#10451', who: 'Kasun', s: 2 }];
  function ordersHtml() {
    return LIVE_ORDERS.map(function (o, i) { return '<div class="orow" data-i="' + i + '"><span>' + o.id + ' ' + o.who + '<small>Rs. ' + (5000 + i * 3100).toLocaleString('en-US') + '</small></span>' + K.badge('order', FLOW[o.s]) + '</div>'; }).join('');
  }
  $('#v-orders').innerHTML = ordersHtml();
  var oCursor = 0;
  if (!reduce) whenVisible($('#v-orders'), function () {
    return loop(function () {
      var o = LIVE_ORDERS[oCursor % 3]; o.s = (o.s + 1) % FLOW.length; oCursor++;
      $('#v-orders').innerHTML = ordersHtml();
      var row = $('.orow[data-i="' + ((oCursor - 1) % 3) + '"]', $('#v-orders')); row.classList.add('flash');
    }, 1700);
  }, 0.4);

  /* ---------- Bento 3: payment switches ---------- */
  var sw = $$('#v-pay .mk-switch');
  if (!reduce) whenVisible($('#v-pay'), function () {
    var step = 0;
    return loop(function () {
      step = (step + 1) % 4;
      sw[0].classList.toggle('on', step === 0 || step === 3 || step === 2);
      sw[1].classList.toggle('on', step === 2 || step === 3);
      if (step === 1) { sw[0].classList.remove('on'); sw[1].classList.remove('on'); }
    }, 1400);
  }, 0.4); else sw[1].classList.add('on');

  /* ---------- Bento 4: stock counting down ---------- */
  var stN = $('#st-n'), stM = $('#st-m'), stB = $('#st-b'), stock = 12, LOW = 5;
  function paintStock() {
    stN.textContent = stock > 0 ? stock + ' left' : 'Sold out';
    stM.style.width = Math.max(stock / 12 * 100, 0) + '%';
    stM.parentNode.className = 'kd-meter' + (stock <= 0 ? ' kd-meter--danger' : stock <= LOW ? ' kd-meter--warning' : '');
    stB.innerHTML = K.stockBadge({ stock: stock, lowAt: LOW });
  }
  paintStock();
  if (!reduce) whenVisible($('#v-stock'), function () {
    return loop(function () { stock = stock <= 0 ? 12 : Math.max(stock - (stock > 6 ? 3 : 2), 0); paintStock(); }, 1100);
  }, 0.4);

  /* ---------- Bento 5: store open / paused ---------- */
  var pzT = $('#pz-t'), pzS = $('#pz-s'), pzW = $('#pz-sw'), open = true;
  function paintPause() {
    pzW.classList.toggle('on', open);
    pzT.firstChild.nodeValue = open ? 'Store open' : 'Store paused';
    pzS.textContent = open ? 'Customers can order' : 'Products and orders are kept';
  }
  if (!reduce) whenVisible($('#pz-sw'), function () { return loop(function () { open = !open; paintPause(); }, 2600); }, 0.4);

  /* ---------- Steps: fill in as they scroll into view ---------- */
  /* (handled by the reveal observer: .in on .lp-step colours the number) */

  /* ---------- Plans ---------- */
  $('#plans').innerHTML = D.plans.map(function (p) {
    return '<article class="plan' + (p.id === 'business' ? ' plan--featured' : '') + '"><h3 class="heading">' + K.esc(p.name) + '</h3>' +
      '<div class="plan__price"><strong>' + K.rs(p.price) + '</strong><span>/ ' + p.durationDays + ' days</span></div>' +
      '<ul>' + p.features.map(function (f) { return '<li>' + K.esc(f) + '</li>'; }).join('') + '</ul>' +
      '<a class="kd-btn ' + (p.id === 'business' ? 'kd-btn--primary' : 'kd-btn--secondary') + ' kd-btn--block" href="register.html?plan=' + p.id + '">Choose ' + K.esc(p.name) + '</a></article>';
  }).join('');
  /* On phones, start the plan carousel centred on the middle plan */
  var pl = $('#plans');
  if (pl.scrollWidth > pl.clientWidth) { var mid = $$('.plan', pl)[1]; pl.scrollLeft = mid.offsetLeft - (pl.clientWidth - mid.offsetWidth) / 2; }

  /* ---------- Sticky "Open my shop" bar on phones ---------- */
  var sticky = $('#sticky'), heroCta = $('#hero-cta'), fin = $('#final'), heroSeen = true, finSeen = false;
  function paintSticky() { sticky.classList.toggle('show', !heroSeen && !finSeen); }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { heroSeen = es[0].isIntersecting; paintSticky(); }).observe(heroCta);
    new IntersectionObserver(function (es) { finSeen = es[0].isIntersecting; paintSticky(); }, { threshold: 0.2 }).observe(fin);
  }
})();
