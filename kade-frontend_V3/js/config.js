/* Frontend configuration.
 *
 * Point this at your deployed backend to make the pages use the real API:
 *   window.KADE_API_BASE = 'https://your-api.up.railway.app';
 *
 * Leave it as '' to run the prototype entirely on mock data (js/data.js) - useful
 * for offline demos. Pages that have been wired to the API check KadeApi.enabled
 * and fall back to mock data automatically when this is empty.
 */
window.KADE_API_BASE = window.KADE_API_BASE || '';

/* Demo sandbox.
 * When a page is opened with ?demo=1 (the "Try the owner dashboard" link), we run
 * the whole tab on in-browser sample data - no API calls, no login - so visitors can
 * explore the Pro dashboard without an account. The flag lives in sessionStorage so it
 * survives navigating between dashboard pages, and clears when the tab closes or on
 * ?demo=0. This never touches the real backend or any real shop's data.
 */
try {
  var _demo = new URLSearchParams(location.search).get('demo');
  if (_demo === '1') sessionStorage.setItem('kade-demo', '1');
  if (_demo === '0') sessionStorage.removeItem('kade-demo');
  if (sessionStorage.getItem('kade-demo') === '1') window.KADE_API_DISABLED = true;
} catch (e) { /* private mode: demo just won't persist */ }
