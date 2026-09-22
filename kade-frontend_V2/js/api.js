/* Sidadiya API client - the single place the frontend talks to the backend.
 *
 * Set the backend base URL below (or define window.KADE_API_BASE before this script,
 * e.g. from an environment-injected <script>). Leave it empty ('') to keep the pages
 * running on the mock data in js/data.js - every page still works offline for demos.
 *
 * Usage:
 *   const { store, products } = await KadeApi.getStore('abc-fashion');
 *   await KadeApi.login(email, password);
 *   const { products } = await KadeApi.myProducts();      // uses the saved token
 */
(function () {
  var BASE = (window.KADE_API_BASE || '').replace(/\/$/, '');
  // The API is enabled when the page is served over http(s) - i.e. by our own Node
  // server (same origin, BASE '') or pointed at a remote API (BASE set). Opening the
  // files directly (file://) with no BASE keeps the offline mock-data prototype.
  // Set window.KADE_API_DISABLED = true to force mock mode anywhere.
  var ENABLED = window.KADE_API_DISABLED ? false
    : (BASE ? true : (location.protocol === 'http:' || location.protocol === 'https:'));
  var TOKEN_KEY = 'kade-token';
  var USER_KEY = 'kade-user';

  function token() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setSession(t, user) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch (e) { /* private mode */ }
  }
  function currentUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; } }
  function clearSession() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch (e) {} }

  // Core fetch wrapper. Attaches the bearer token and unwraps JSON / errors.
  async function req(method, path, body, isForm) {
    var headers = {};
    var t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    var opts = { method: method, headers: headers };
    if (body != null) {
      if (isForm) { opts.body = body; } // FormData: let the browser set the boundary
      else { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    var res = await fetch(BASE + path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      var msg = (data && data.error) || ('Request failed (' + res.status + ')');
      var err = new Error(msg); err.status = res.status; err.details = data && data.details;
      throw err;
    }
    return data;
  }

  // Build the multipart body for creating/updating a product: text fields, the
  // list of existing images to keep, and any new image files (field name 'images').
  function productForm(fields, imageFiles, keepImages) {
    var fd = new FormData();
    Object.keys(fields).forEach(function (k) { fd.append(k, (k === 'options' || k === 'variants') ? JSON.stringify(fields[k]) : fields[k]); });
    fd.append('keepImages', JSON.stringify(keepImages || []));
    (imageFiles || []).forEach(function (file) { if (file) fd.append('images', file); });
    return fd;
  }

  var KadeApi = {
    base: BASE,
    enabled: ENABLED,          // pages check this to decide API vs. mock
    token: token,
    currentUser: currentUser,
    clearSession: clearSession,

    // ---- Auth ----
    async login(email, password) {
      var d = await req('POST', '/api/auth/login', { email: email, password: password });
      setSession(d.token, d.user);
      return d.user;
    },
    logout() { clearSession(); },
    // register(fields, fileMap) - fields is a plain object; fileMap like { slip: File }.
    async register(fields, fileMap) {
      var fd = new FormData();
      Object.keys(fields).forEach(function (k) { if (fields[k] != null) fd.append(k, fields[k]); });
      if (fileMap) Object.keys(fileMap).forEach(function (k) { if (fileMap[k]) fd.append(k, fileMap[k]); });
      return req('POST', '/api/auth/register', fd, true);
    },

    // ---- Public ----
    plans() { return req('GET', '/api/plans'); },
    getStore(slug) { return req('GET', '/api/store/' + encodeURIComponent(slug)); },
    getStoreProduct(slug, id) { return req('GET', '/api/store/' + encodeURIComponent(slug) + '/product/' + id); },
    placeOrder(slug, order) { return req('POST', '/api/store/' + encodeURIComponent(slug) + '/orders', order); },
    applyCoupon(slug, code, subtotal) { return req('POST', '/api/store/' + encodeURIComponent(slug) + '/coupon', { code: code, subtotal: subtotal }); },

    // ---- Owner dashboard (token required) ----
    myProducts() { return req('GET', '/api/products'); },
    // imageFiles: array of new File objects. keepImages: existing image URLs to retain
    // (in the desired order); the server keeps those first, then appends the new files.
    createProduct(fields, imageFiles, keepImages) {
      return req('POST', '/api/products', productForm(fields, imageFiles, keepImages), true);
    },
    updateProduct(id, fields, imageFiles, keepImages) {
      return req('PUT', '/api/products/' + id, productForm(fields, imageFiles, keepImages), true);
    },
    deleteProduct(id) { return req('DELETE', '/api/products/' + id); },
    categories() { return req('GET', '/api/dashboard/categories'); },
    createCategory(name) { return req('POST', '/api/dashboard/categories', { name: name }); },
    renameCategory(from, to) { return req('PUT', '/api/dashboard/categories/' + encodeURIComponent(from), { name: to }); },
    deleteCategory(name) { return req('DELETE', '/api/dashboard/categories/' + encodeURIComponent(name)); },
    overview() { return req('GET', '/api/dashboard/overview'); },
    reports(range) {
      var qs = '';
      if (range && (range.from || range.to)) {
        var parts = [];
        if (range.from) parts.push('from=' + encodeURIComponent(range.from));
        if (range.to) parts.push('to=' + encodeURIComponent(range.to));
        qs = '?' + parts.join('&');
      }
      return req('GET', '/api/dashboard/reports' + qs);
    },
    myOrders() { return req('GET', '/api/dashboard/orders'); },
    setOrderStatus(code, status) { return req('PUT', '/api/dashboard/orders/' + encodeURIComponent(code) + '/status', { status: status }); },
    subscription() { return req('GET', '/api/dashboard/subscription'); },
    renew(fields, slipFile) {
      var fd = new FormData();
      Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
      if (slipFile) fd.append('slip', slipFile);
      return req('POST', '/api/dashboard/subscription/renew', fd, true);
    },
    myStore() { return req('GET', '/api/dashboard/store'); },
    updateStore(store) { return req('PUT', '/api/dashboard/store', store); },
    deleteMyShop(password) { return req('DELETE', '/api/dashboard/account', { password: password }); },
    coupons() { return req('GET', '/api/dashboard/coupons'); },
    createCoupon(c) { return req('POST', '/api/dashboard/coupons', c); },
    updateCoupon(id, c) { return req('PUT', '/api/dashboard/coupons/' + id, c); },
    deleteCoupon(id) { return req('DELETE', '/api/dashboard/coupons/' + id); },
    staff() { return req('GET', '/api/dashboard/staff'); },
    createStaff(s) { return req('POST', '/api/dashboard/staff', s); },
    updateStaff(id, s) { return req('PUT', '/api/dashboard/staff/' + id, s); },
    deleteStaff(id) { return req('DELETE', '/api/dashboard/staff/' + id); },

    // ---- Admin (SUPER_ADMIN token required) ----
    adminStats() { return req('GET', '/api/admin/stats'); },
    adminBusinesses(status) { return req('GET', '/api/admin/businesses' + (status ? '?status=' + status : '')); },
    adminApprove(id) { return req('POST', '/api/admin/businesses/' + id + '/approve'); },
    adminReject(id, reason) { return req('POST', '/api/admin/businesses/' + id + '/reject', { reason: reason }); },
    adminSuspend(id) { return req('POST', '/api/admin/businesses/' + id + '/suspend'); },
    adminReactivate(id) { return req('POST', '/api/admin/businesses/' + id + '/reactivate'); },
    adminExtend(id, days) { return req('POST', '/api/admin/businesses/' + id + '/extend', { days: days }); },
    adminChangeSlug(id, slug) { return req('POST', '/api/admin/businesses/' + id + '/slug', { slug: slug }); },
    adminDeleteBusiness(id) { return req('DELETE', '/api/admin/businesses/' + id); },
    adminPayments(status) { return req('GET', '/api/admin/payments' + (status ? '?status=' + status : '')); },
    adminApprovePayment(id) { return req('POST', '/api/admin/payments/' + id + '/approve'); },
    adminRejectPayment(id, reason) { return req('POST', '/api/admin/payments/' + id + '/reject', { reason: reason }); },
  };

  window.KadeApi = KadeApi;
})();
