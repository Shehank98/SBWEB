/* Frontend configuration.
 *
 * Point this at your deployed backend to make the pages use the real API:
 *   window.KADE_API_BASE = 'https://your-api.up.railway.app';
 *
 * Leave it as '' to run the prototype entirely on mock data (js/data.js) — useful
 * for offline demos. Pages that have been wired to the API check KadeApi.enabled
 * and fall back to mock data automatically when this is empty.
 */
window.KADE_API_BASE = window.KADE_API_BASE || '';
