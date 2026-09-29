/* Safe mini-markdown used for policy pages (storefront, platform legal pages and the
   seller's policy editor preview). The text is HTML-escaped first, then:
   "## " headings, "- " and "1. " lists, blank-line paragraphs, and auto-linked
   emails and https URLs. No raw HTML is ever passed through. */
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function inline(t) {
    return esc(t)
      .replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener nofollow">$1</a>')
      .replace(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '<a href="mailto:$1">$1</a>');
  }
  window.KadeMd = function (text) {
    var out = [], list = null, para = [];
    function flushPara() { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } }
    function flushList() { if (list) { out.push('<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.tag + '>'); list = null; } }
    String(text || '').replace(/\r\n/g, '\n').split('\n').forEach(function (raw) {
      var line = raw.trim(), m;
      if (!line) { flushPara(); flushList(); return; }
      if ((m = line.match(/^#{1,3}\s+(.*)$/))) { flushPara(); flushList(); out.push('<h2>' + inline(m[1]) + '</h2>'); return; }
      if ((m = line.match(/^[-*•]\s+(.*)$/)) || (m = line.match(/^\d+[.)]\s+(.*)$/))) {
        var tag = /^\d/.test(line) ? 'ol' : 'ul';
        flushPara(); if (list && list.tag !== tag) flushList();
        if (!list) list = { tag: tag, items: [] };
        list.items.push(m[1]); return;
      }
      flushList(); para.push(line);
    });
    flushPara(); flushList();
    return out.join('');
  };
})();
