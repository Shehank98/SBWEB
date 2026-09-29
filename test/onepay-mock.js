// A tiny stand-in for the OnePay API, for tests and local development ONLY.
// It implements the two endpoints the integration uses, checks the hash exactly as
// the spec defines it, and lets a test decide how each transaction ends.
//
// Run the app against it:
//   ONEPAY_API_BASE=http://localhost:4455 ONEPAY_APP_ID=test-app ONEPAY_HASH_SALT=test-salt npm start
// Standalone:  node test/onepay-mock.js   (listens on MOCK_ONEPAY_PORT or 4455)
import http from 'http';
import { createHash, randomBytes } from 'crypto';

export function startOnePayMock({ port = Number(process.env.MOCK_ONEPAY_PORT || 4455), salts = { 'test-app': 'test-salt' } } = {}) {
  const txs = new Map(); // ipg id -> { amount, currency, reference, outcome, overrideAmount, redirect }
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let b = {};
      try { b = body ? JSON.parse(body) : {}; } catch { return send(400, { message: 'bad json' }); }
      calls.push({ path: req.url, body: b });
      if (req.method === 'POST' && req.url === '/v3/checkout/link/') {
        const salt = salts[b.app_id];
        if (!salt) return send(401, { message: 'unknown app' });
        const want = createHash('sha256').update(`${b.app_id}${b.currency}${b.amount}${salt}`).digest('hex');
        if (b.hash !== want) return send(400, { message: 'hash mismatch' });
        if (!/^\d+\.\d{2}$/.test(b.amount) || b.currency !== 'LKR') return send(400, { message: 'bad amount/currency' });
        if (!/^\+94\d{9}$/.test(b.customer_phone_number || '')) return send(400, { message: 'bad phone' });
        const id = 'IPG' + randomBytes(6).toString('hex').toUpperCase();
        txs.set(id, { amount: b.amount, currency: b.currency, reference: b.reference, outcome: 'pending', redirect: b.transaction_redirect_url, additionalData: b.additionalData });
        return send(200, { status: 200, message: 'success', data: { ipg_transaction_id: id, amount: { gross_amount: Number(b.amount) }, gateway: { redirect_url: `http://localhost:${port}/pay/${id}` } } });
      }
      if (req.method === 'POST' && req.url === '/v3/transaction/status/') {
        const t = txs.get(b.onepay_transaction_id);
        if (!t || !salts[b.app_id]) return send(404, { message: 'not found' });
        return send(200, { status: 200, message: 'ok', data: { status: t.outcome === 'paid', amount: t.overrideAmount || t.amount, currency: t.overrideCurrency || t.currency, paid_on: t.outcome === 'paid' ? new Date().toISOString() : null } });
      }
      if (req.method === 'GET' && req.url.startsWith('/pay/')) { // the "OnePay page": pays and returns
        const t = txs.get(req.url.slice(5));
        if (!t) return send(404, {});
        t.outcome = 'paid';
        res.writeHead(302, { Location: t.redirect }); return res.end();
      }
      send(404, { message: 'no route' });
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({
    port, txs, calls,
    set(id, patch) { Object.assign(txs.get(id), patch); },
    close: () => new Promise((r) => server.close(r)),
  })));
}

if (process.argv[1] && process.argv[1].endsWith('onepay-mock.js')) {
  startOnePayMock().then((m) => console.log(`[onepay-mock] listening on http://localhost:${m.port}`));
}
