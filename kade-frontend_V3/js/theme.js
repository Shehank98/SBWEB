/* Runs in <head> so the saved theme applies before first paint. Pages that set data-theme themselves (storefronts) are left alone. */
(function () {
  try {
    var root = document.documentElement;
    if (root.hasAttribute('data-theme')) return;
    var saved = localStorage.getItem('kade-theme');
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
    else root.setAttribute('data-theme', window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
})();

/* Desktop dashboard sidebar: collapsed (icon rail) or expanded, remembered per browser. */
(function () {
  try { if (localStorage.getItem('kade-sidebar') === 'collapsed') document.documentElement.classList.add('sb-collapsed'); } catch (e) { /* ignore */ }
})();
