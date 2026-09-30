/**
 * Sidadiya: email notifications worker (Google Apps Script)
 * ------------------------------------------------------
 * Polls the backend notifications outbox and sends branded HTML emails for:
 *   REGISTERED (waiting for approval), APPROVED (store link + login),
 *   REJECTED, NEW_ORDER (to the owner), ORDER_CONFIRMED and ORDER_SHIPPED
 *   (to the customer), EXPIRY_REMINDER, SUSPENDED.
 * Added in the V3 upgrade (older types above are unchanged):
 *   TRIAL_STARTED, TRIAL_REMINDER (day 10 / day 13), TRIAL_EXPIRED,
 *   SUBSCRIPTION_RECEIPT (OnePay card payment for a plan),
 *   VERIFICATION_SUBMITTED (to the admin), VERIFICATION_APPROVED / _REJECTED,
 *   ORDER_PAID (to the owner) and ORDER_PAYMENT_RECEIPT (to the buyer) for card
 *   orders, ORDER_SHIPPED now carries courier + tracking number, WEEKLY_SUMMARY.
 *   Also ORDER_PLACED / ORDER_PACKED / ORDER_DELIVERED / ORDER_CANCELLED to the buyer,
 *   sent with the shop name as sender and the shop email as reply-to.
 *
 * Optional Google Sheet sync (V3): set SHEETS_SYNC_ID and run installSyncTrigger
 * once. Every hour syncSheets() rewrites three tabs from the backend:
 *   Shops     (plan, trial, verification, contact details, policy status, OnePay)
 *   Payments  (subscription payments, bank + OnePay, with transaction ids)
 *   Shipments (courier + tracking numbers, card payment status)
 * The sheet is a read-only mirror: edits there are overwritten on the next sync.
 *
 * High volume design (Task 2):
 *   - A single time trigger runs sendPendingEmails every minute; the backend also pings the web app (doGet) the moment an email is queued, so most emails leave within seconds.
 *   - A script lock stops two runs from overlapping, so a row is never sent twice.
 *   - Before sending, the daily MailApp quota is checked. If it is low the run
 *     defers: rows stay PENDING and the next run picks them up (resume safe).
 *   - The batch is capped by both BATCH and the remaining quota.
 *   - Deduplication happens on the backend (a unique dedupe_key per event) and is
 *     double checked here inside a run.
 *   - Every send is marked SENT on the backend (sent_at is the audit stamp) and,
 *     if AUDIT_SHEET_ID is set, appended to a Google Sheet for a full audit log.
 *
 * Setup: see README.md in this folder. In short:
 *   1. Project Settings, Script properties: add API_BASE and NOTIFY_TOKEN.
 *   2. Run sendPendingEmails once and grant permissions.
 *   3. Run installTrigger once (every minute), deploy as a web app and set APPS_SCRIPT_URL on Railway for instant sending. Run testConnection if emails do not arrive.
 */

// ---- Config (read from Script properties, with safe fallbacks) --------------
function cfg_() {
  var p = PropertiesService.getScriptProperties();
  return {
    apiBase: (p.getProperty('API_BASE') || 'https://sbweb-production.up.railway.app').replace(/\/+$/, ''),
    token: p.getProperty('NOTIFY_TOKEN') || '',
    fromName: p.getProperty('FROM_NAME') || 'Sidadiya',
    // Absolute base for images in emails (the logo). Defaults to the live site.
    siteBase: (p.getProperty('SITE_BASE') || 'https://www.sidadiya.com').replace(/\/+$/, ''),
    batch: Number(p.getProperty('BATCH') || 50),
    // Do not send if fewer than this many emails remain in today's quota; keep a
    // buffer for the next run so a burst never drains the account completely.
    quotaFloor: Number(p.getProperty('QUOTA_FLOOR') || 15),
    auditSheetId: p.getProperty('AUDIT_SHEET_ID') || '',
    // V3: spreadsheet that syncSheets() mirrors shops / payments / shipments into.
    sheetsSyncId: p.getProperty('SHEETS_SYNC_ID') || ''
  };
}

// ---- Main entry point: the web app ping (instant) and a 1 minute trigger ----
function sendPendingEmails() {
  var c = cfg_();
  if (!c.token) { Logger.log('NOTIFY_TOKEN is not set in Script properties. Run testConnection for help.'); return { ok: false, error: 'no token' }; }

  // Only one run at a time. If another run holds the lock, skip quietly; the next
  // scheduled run continues from where this one left off.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another run is in progress. Skipping.');
    return { ok: true, busy: true };
  }

  try {
    var remaining = MailApp.getRemainingDailyQuota();
    if (remaining <= c.quotaFloor) {
      Logger.log('Daily quota low (%s left, floor %s). Deferring to a later run.', remaining, c.quotaFloor);
      return { ok: false, error: 'quota' };
    }

    var res = UrlFetchApp.fetch(c.apiBase + '/api/notifications/pending', {
      method: 'get',
      headers: { 'x-notify-token': c.token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('Poll failed (%s): %s. Run testConnection for help.', res.getResponseCode(), res.getContentText().slice(0, 300));
      return { ok: false, error: 'poll ' + res.getResponseCode() };
    }
    var list = (JSON.parse(res.getContentText()).notifications) || [];
    Logger.log('Pending: %s. Quota left: %s.', list.length, remaining);

    // Send at most: the batch size, and never more than the quota buffer allows.
    var allowance = Math.min(c.batch, remaining - c.quotaFloor);
    var sent = 0, failed = 0, skipped = 0;
    var seen = {}; // in-run guard: never process the same row id twice in one run

    for (var i = 0; i < list.length; i++) {
      if (sent >= allowance) {
        Logger.log('Reached this run allowance (%s). Remaining stay PENDING for next run.', allowance);
        break;
      }
      var n = list[i];
      // Guard on the unique row id only. Each notification row is a distinct email
      // for a specific order and customer, so two rows must never be collapsed by
      // their content (order codes are unique per shop, not globally). Deduplication
      // of repeated events is already enforced in the database (dedupe_key).
      if (seen[n.id]) { skipped++; continue; }
      seen[n.id] = true;

      try {
        // V3: buyer order emails are sent on behalf of the shop: the shop name is
        // the sender name and replies go to the shop's email (data.fromName /
        // data.replyTo). Everything else is sent as FROM_NAME.
        var dd = n.data || {};
        var mail = {
          to: n.recipient,
          subject: n.subject,
          htmlBody: renderEmail_(n),
          body: n.message || '',           // plain-text fallback
          name: dd.fromName ? String(dd.fromName).slice(0, 60) : c.fromName
        };
        if (dd.replyTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dd.replyTo)) mail.replyTo = dd.replyTo;
        MailApp.sendEmail(mail);
        mark_(c, n.id, 'sent');
        audit_(c, n, 'SENT');
        sent++;
      } catch (err) {
        Logger.log('Send failed for %s: %s', n.id, err);
        mark_(c, n.id, 'failed');
        audit_(c, n, 'FAILED: ' + err);
        failed++;
      }
    }
    Logger.log('Done. sent=%s failed=%s skipped=%s', sent, failed, skipped);
    return { ok: true, sent: sent, failed: failed, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

// ---- Instant sending: the backend pings this web app right after it queues an
// email (APPS_SCRIPT_URL on Railway = this web app's /exec URL). The 1 minute
// trigger stays as the safety net if a ping is missed.
// Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
function doGet(e) { return ping_(e); }
function doPost(e) { return ping_(e); }
function ping_(e) {
  var c = cfg_();
  var given = (e && e.parameter && e.parameter.token) || '';
  var out;
  if (!c.token || given !== c.token) out = { ok: false, error: 'bad token' };
  else out = sendPendingEmails() || { ok: true };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ---- Run this when emails are not arriving: it checks every setting and says
// what is wrong in plain words (View > Execution log). ----------------------------
function testConnection() {
  var c = cfg_();
  Logger.log('API_BASE: %s', c.apiBase);
  if (!c.token) { Logger.log('PROBLEM: NOTIFY_TOKEN is empty. Add it in Project Settings > Script properties (same value as NOTIFY_TOKEN on Railway).'); return; }
  var res;
  try {
    res = UrlFetchApp.fetch(c.apiBase + '/api/notifications/pending', { method: 'get', headers: { 'x-notify-token': c.token }, muteHttpExceptions: true });
  } catch (err) {
    Logger.log('PROBLEM: cannot reach %s (%s). Check API_BASE: it must be your live Railway URL, starting with https://', c.apiBase, err);
    return;
  }
  var code = res.getResponseCode();
  if (code === 401) { Logger.log('PROBLEM: the token was refused. NOTIFY_TOKEN here must match NOTIFY_TOKEN on Railway exactly (or JWT_SECRET if NOTIFY_TOKEN is not set there).'); return; }
  if (code === 404) { Logger.log('PROBLEM: %s has no notifications API. API_BASE points at the wrong site, or that site runs an old version.', c.apiBase); return; }
  if (code !== 200) { Logger.log('PROBLEM: the API answered %s: %s', code, res.getContentText().slice(0, 300)); return; }
  var n = (JSON.parse(res.getContentText()).notifications || []).length;
  Logger.log('OK: connected. %s email(s) waiting to be sent.', n);
  Logger.log('Gmail quota left today: %s', MailApp.getRemainingDailyQuota());
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'sendPendingEmails'; });
  Logger.log(triggers.length ? 'OK: the 1 minute trigger is installed.' : 'PROBLEM: no trigger. Run installTrigger once.');
  Logger.log('Tip: run sendPendingEmails now to send what is waiting.');
}

function mark_(c, id, what) {
  UrlFetchApp.fetch(c.apiBase + '/api/notifications/' + id + '/' + what, {
    method: 'post',
    headers: { 'x-notify-token': c.token },
    muteHttpExceptions: true
  });
}

// Append one row to the audit sheet, if AUDIT_SHEET_ID is configured. Best effort:
// a logging failure never blocks email delivery.
function audit_(c, n, outcome) {
  if (!c.auditSheetId) return;
  try {
    var sheet = SpreadsheetApp.openById(c.auditSheetId).getSheets()[0];
    sheet.appendRow([new Date(), n.id, n.type, n.recipient, n.subject, outcome]);
  } catch (err) {
    Logger.log('Audit log failed for %s: %s', n.id, err);
  }
}

// ---- Install the 1 minute safety-net trigger (run once) ---------------------
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendPendingEmails') ScriptApp.deleteTrigger(t);
  });
  // 1 minute is the shortest time trigger Google allows. Near-instant sending comes
  // from the backend's web app ping (doGet / doPost above).
  ScriptApp.newTrigger('sendPendingEmails').timeBased().everyMinutes(1).create();
  Logger.log('Trigger installed: sendPendingEmails every minute.');
}

// =============================================================================
// Email rendering. Matches the Sidadiya site (Figtree / Bricolage, brand green)
// =============================================================================
var THEME = {
  bg: '#faf7f0', card: '#ffffff', ink: '#17211d', muted: '#4a5650',
  line: '#ddd5c4', brand: '#0f5b4a', onBrand: '#ffffff',
  accent: '#e8a317', onAccent: '#17211d', soft: '#d9eee5'
};
var SANS = "'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
var DISPLAY = "'Bricolage Grotesque', 'Figtree', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
var MONO = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
  });
}
function rs_(n) { return 'Rs. ' + Math.round(Number(n || 0)).toLocaleString('en-US'); }

function button_(label, url, kind) {
  var bg = kind === 'accent' ? THEME.accent : THEME.brand;
  var fg = kind === 'accent' ? THEME.onAccent : THEME.onBrand;
  return '<a href="' + esc_(url) + '" style="display:inline-block;background:' + bg + ';color:' + fg +
    ';font-family:' + SANS + ';font-weight:600;font-size:15px;text-decoration:none;padding:12px 22px;border-radius:10px;margin:4px 6px 4px 0">' +
    esc_(label) + '</a>';
}

// Wraps body HTML in the branded shell. An optional footer note replaces the
// default one (order emails put the shop contact there).
function shell_(bodyHtml, footerHtml) {
  return '' +
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>@import url("https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=Figtree:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap");</style>' +
    '</head><body style="margin:0;padding:0;background:' + THEME.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + THEME.bg + ';padding:24px 12px;">' +
      '<tr><td align="center">' +
        '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:' + THEME.card + ';border:1px solid ' + THEME.line + ';border-radius:16px;overflow:hidden;">' +
          // header (Sidadiya logo on the brand-green bar; alt text keeps the brand
          // visible if a mail client blocks images)
          '<tr><td style="background:' + THEME.brand + ';padding:18px 28px;">' +
            '<img src="' + cfg_().siteBase + '/assets/logo-light.png" alt="Sidadiya" height="30" style="height:30px;display:inline-block;vertical-align:middle;border:0;">' +
          '</td></tr>' +
          // body
          '<tr><td style="padding:28px;">' + bodyHtml + '</td></tr>' +
          // footer
          '<tr><td style="padding:18px 28px;border-top:1px solid ' + THEME.line + ';">' +
            (footerHtml || '<p style="margin:0;font-family:' + SANS + ';font-size:12px;color:' + THEME.muted + ';">You are receiving this because you use Sidadiya. Reply to this email if you need help.</p>') +
          '</td></tr>' +
        '</table>' +
      '</td></tr>' +
    '</table></body></html>';
}

function h1_(t) { return '<h1 style="margin:0 0 12px;font-family:' + DISPLAY + ';font-size:24px;font-weight:700;color:' + THEME.ink + ';">' + esc_(t) + '</h1>'; }
function p_(t) { return '<p style="margin:0 0 14px;font-family:' + SANS + ';font-size:16px;line-height:24px;color:' + THEME.ink + ';">' + t + '</p>'; }
function infoBox_(rowsHtml) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + THEME.soft +
    ';border-radius:12px;margin:6px 0 18px;"><tr><td style="padding:14px 16px;">' + rowsHtml + '</td></tr></table>';
}
function kv_(k, v) {
  return '<div style="font-family:' + SANS + ';font-size:14px;line-height:22px;color:' + THEME.ink + ';">' +
    '<span style="color:' + THEME.muted + ';">' + esc_(k) + ': </span><strong>' + v + '</strong></div>';
}

// ---- Order emails (Task 3): summary table + delivery/pickup + shop contact ---
function orderTable_(d) {
  var rows = (d.items || []).map(function (i) {
    return '<tr>' +
      // Product photo when the item has one (https only: email clients block other URLs).
      '<td style="font-family:' + SANS + ';font-size:14px;color:' + THEME.ink + ';padding:6px 0;border-bottom:1px solid ' + THEME.line + ';">' +
        (/^https:\/\//.test(i.image || '') ? '<img src="' + esc_(i.image) + '" width="44" height="44" alt="" style="width:44px;height:44px;border-radius:8px;object-fit:cover;vertical-align:middle;margin-right:10px;border:0;">' : '') +
        esc_(i.qty) + ' x ' + esc_(i.name) + '</td>' +
      '<td align="right" style="font-family:' + MONO + ';font-size:14px;color:' + THEME.ink + ';padding:6px 0;border-bottom:1px solid ' + THEME.line + ';white-space:nowrap;">' + rs_(i.qty * i.price) + '</td>' +
      '</tr>';
  }).join('');

  function totalRow(label, value, strong) {
    return '<tr>' +
      '<td style="font-family:' + SANS + ';font-size:14px;padding:4px 0;' + (strong ? 'font-weight:700;' : 'color:' + THEME.muted + ';') + '">' + esc_(label) + '</td>' +
      '<td align="right" style="font-family:' + MONO + ';font-size:14px;padding:4px 0;' + (strong ? 'font-weight:700;' : '') + 'white-space:nowrap;">' + value + '</td>' +
      '</tr>';
  }

  var totals = '';
  if (d.subtotal != null) totals += totalRow('Subtotal', rs_(d.subtotal), false);
  if (Number(d.discount) > 0) totals += totalRow('Discount', '-' + rs_(d.discount), false);
  if (d.deliveryFee != null && d.fulfilment !== 'pickup') totals += totalRow('Delivery', Number(d.deliveryFee) ? rs_(d.deliveryFee) : 'Free', false);
  totals += totalRow('Total', rs_(d.total), true);

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 16px;">' +
    rows +
    '<tr><td colspan="2" style="height:6px;"></td></tr>' +
    totals +
    '</table>';
}

function orderFulfilment_(d) {
  if (d.fulfilment === 'pickup') {
    return infoBox_(
      kv_('Collection', 'Pick up from the shop') +
      (d.shopAddress ? kv_('Shop address', esc_(d.shopAddress)) : '') +
      (d.payment ? kv_('Payment', esc_(d.payment)) : '')
    );
  }
  var where = [d.address, d.city, d.district].filter(function (x) { return x; }).map(esc_).join(', ');
  return infoBox_(
    kv_('Delivering to', where || esc_(d.customer)) +
    (d.payment ? kv_('Payment', esc_(d.payment)) : '')
  );
}

function orderFooter_(d) {
  var bits = [];
  if (d.shopPhone) bits.push('Call ' + esc_(d.shopPhone));
  if (d.shopWhatsapp) bits.push('WhatsApp ' + esc_(d.shopWhatsapp));
  var contact = bits.length ? bits.join('  |  ') : 'Reply to this email';
  return '<p style="margin:0;font-family:' + SANS + ';font-size:12px;color:' + THEME.muted + ';">' +
    'Questions about your order? ' + contact + '.<br>Sent by ' + esc_(d.storeName || d.business || 'the shop') + ' through Sidadiya.' +
    '</p>';
}

function orderBody_(d) {
  return h1_(d.heading) +
    p_(d.intro) +
    infoBox_(
      kv_('Order', esc_(d.orderCode)) +
      kv_('Shop', esc_(d.storeName || d.business)) +
      (d.customer ? kv_('Name', esc_(d.customer)) : '')
    ) +
    // V3: courier + tracking number (ORDER_SHIPPED from "Mark as shipped").
    (d.trackingNumber ? infoBox_(
      kv_('Courier', esc_(d.courier || '')) +
      kv_('Tracking number', '<span style="font-family:' + MONO + ';">' + esc_(d.trackingNumber) + '</span>') +
      (d.trackingUrl ? '<div style="margin-top:8px;">' + button_('Track your parcel', d.trackingUrl, 'accent') + '</div>' : '')
    ) : '') +
    // V3: card payment reference (ORDER_PAYMENT_RECEIPT).
    (d.transactionId ? infoBox_(kv_('Paid by card', 'OnePay reference ' + esc_(d.transactionId))) : '') +
    '<h2 style="margin:8px 0 6px;font-family:' + DISPLAY + ';font-size:16px;font-weight:700;color:' + THEME.ink + ';">Order summary</h2>' +
    orderTable_(d) +
    orderFulfilment_(d) +
    // V3: public tracking page + 30-day digital receipt.
    ((d.trackUrl || d.statusUrl) ? button_('Track your order here', d.trackUrl || d.statusUrl, 'brand') : '') +
    (d.receiptUrl ? button_('View your receipt', d.receiptUrl, 'accent') : '') +
    (d.receiptUrl && d.receiptExpiresOn ? '<p style="margin:4px 0 12px;font-family:' + SANS + ';font-size:12px;color:' + THEME.muted + ';">Your receipt link works until ' + esc_(d.receiptExpiresOn) + '.</p>' : '') +
    (d.storeUrl && !d.receiptUrl ? button_('Visit the shop', d.storeUrl, (d.trackUrl || d.statusUrl) ? 'accent' : 'brand') : '');
}

// Build the per-type body; unknown types fall back to the plain message.
function renderEmail_(n) {
  var d = n.data || {};
  var body, footer = null;

  switch (n.type) {
    case 'REGISTERED':
      body = h1_(d.heading || 'Application received') +
        p_('Thank you for registering <strong>' + esc_(d.business) + '</strong>. Our team is checking your payment slip now.') +
        p_('We will email you the moment your store is approved, usually within a day. Thank you for choosing Sidadiya.');
      break;

    case 'APPROVED':
      body = h1_(d.heading || 'Your store is live') +
        p_('Congratulations! <strong>' + esc_(d.business) + '</strong> has been approved and your online store is ready.') +
        infoBox_(
          kv_('Your store link', '<a href="' + esc_(d.storeUrl) + '" style="color:' + THEME.brand + ';">' + esc_(d.storeUrl) + '</a>') +
          kv_('Sign in with', esc_(d.email || '')) +
          (d.planName ? kv_('Plan', esc_(d.planName)) : '')
        ) +
        p_('Log in and create your listings, then share your store link on WhatsApp, Facebook and Instagram to start selling.') +
        '<div style="margin-top:6px;">' + button_('Create my listings', d.loginUrl, 'accent') + button_('Open my store', d.storeUrl, 'brand') + '</div>';
      break;

    case 'REJECTED':
      body = h1_(d.heading || 'Your application needs attention') +
        p_('We could not approve <strong>' + esc_(d.business) + '</strong> just yet.') +
        (d.reason ? infoBox_(kv_('Reason', esc_(d.reason))) : '') +
        p_('Please reply to this email and we will help you get set up.');
      break;

    case 'NEW_ORDER':
      var items = (d.items || []).map(function (i) {
        return '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + THEME.ink + ';padding:4px 0;">' + esc_(i.qty) + ' x ' + esc_(i.name) + '</td>' +
          '<td align="right" style="font-family:' + MONO + ';font-size:14px;color:' + THEME.ink + ';padding:4px 0;">' + rs_(i.qty * i.price) + '</td></tr>';
      }).join('');
      body = h1_(d.heading || 'New order received') +
        p_('<strong>' + esc_(d.business) + '</strong> just received a new order.') +
        infoBox_(
          kv_('Order', esc_(d.orderCode)) +
          kv_('Customer', esc_(d.customer)) +
          (d.phone ? kv_('Phone', esc_(d.phone)) : '') +
          (items ? '<table role="presentation" width="100%" style="margin-top:8px;border-top:1px solid ' + THEME.line + ';padding-top:8px;">' + items +
            '<tr><td style="font-family:' + SANS + ';font-weight:700;padding-top:8px;">Total</td><td align="right" style="font-family:' + MONO + ';font-weight:700;padding-top:8px;">' + rs_(d.total) + '</td></tr></table>'
            : kv_('Total', rs_(d.total)))
        ) +
        button_('View order', d.ordersUrl, 'brand');
      break;

    // Customer emails, redesigned. Both share the order summary layout.
    case 'ORDER_PLACED':      // V3: sent as soon as the buyer orders (receipt + tracking)
    case 'ORDER_CONFIRMED':
    case 'ORDER_PACKED':      // V3
    case 'ORDER_SHIPPED':
    case 'ORDER_DELIVERED':   // V3
    case 'ORDER_CANCELLED':   // V3
      body = orderBody_(d);
      footer = orderFooter_(d);
      break;

    // Legacy: order confirmation at placement (no longer queued, kept for any
    // rows still in the outbox).
    case 'ORDER_CONFIRMATION':
      body = orderBody_({
        heading: d.heading || 'Thank you for your order',
        intro: 'Thank you for ordering from ' + (d.storeName || d.business) + '. We have received your order and will let you know when it is on the way.',
        orderCode: d.orderCode, storeName: d.storeName, business: d.business, customer: d.customer,
        items: d.items, total: d.total, subtotal: d.subtotal, discount: d.discount,
        deliveryFee: d.deliveryFee, fulfilment: d.fulfilment, address: d.address, city: d.city,
        district: d.district, payment: d.payment, shopPhone: d.shopPhone, shopWhatsapp: d.shopWhatsapp,
        shopAddress: d.shopAddress, storeUrl: d.storeUrl
      });
      footer = orderFooter_(d);
      break;

    case 'ORDER_STATUS':
      var delivered = String(d.status || '').toUpperCase() === 'DELIVERED';
      body = h1_(delivered ? 'Your order has been delivered' : 'Order ' + esc_(d.orderCode) + ' update') +
        p_('Your order <strong>' + esc_(d.orderCode) + '</strong> from <strong>' + esc_(d.business) + '</strong> is now <strong>' + esc_(String(d.status || '').toLowerCase()) + '</strong>.') +
        p_(delivered ? 'We hope you love it. Thank you for shopping with us!' : 'Thank you for shopping with us!');
      break;

    case 'EXPIRY_REMINDER':
      body = h1_(d.heading || 'Renewal reminder') +
        p_('<strong>' + esc_(d.business) + '</strong>, your subscription expires in <strong>' + esc_(d.days) + ' day' + (d.days === 1 ? '' : 's') + '</strong>' + (d.expiry ? ' (on ' + esc_(d.expiry) + ')' : '') + '.') +
        p_('Renew now so your store stays open for customers.') +
        button_('Renew now', d.renewUrl, 'accent');
      break;

    case 'SUSPENDED':
      body = h1_(d.heading || 'Your store has been paused') +
        p_('<strong>' + esc_(d.business) + '</strong>, your subscription has lapsed and your store is paused for now.') +
        p_('Your products, photos and orders are all safe. Renew to bring your store back online instantly.') +
        button_('Renew now', d.renewUrl, 'accent');
      break;

    // ---- V3: free trial --------------------------------------------------------
    case 'TRIAL_STARTED':
      body = h1_(d.heading || 'Your store is live') +
        p_('Welcome to Sidadiya! <strong>' + esc_(d.business) + '</strong> is open and your <strong>' + esc_(d.trialDays) + '-day free trial</strong> has started.') +
        infoBox_(
          kv_('Your store link', '<a href="' + esc_(d.storeUrl) + '" style="color:' + THEME.brand + ';">' + esc_(d.storeUrl) + '</a>') +
          kv_('Sign in with', esc_(d.email || '')) +
          kv_('Free until', esc_(d.trialEndsOn || ''))
        ) +
        p_('Add your products, then share your store link on WhatsApp, Facebook and Instagram. Choose a plan any time before the trial ends; your remaining free days are kept.') +
        '<div style="margin-top:6px;">' + button_('Add my products', d.dashboardUrl || d.loginUrl, 'accent') + button_('Open my store', d.storeUrl, 'brand') + '</div>';
      break;

    case 'TRIAL_REMINDER':
      body = h1_(d.heading || 'Your free trial is ending') +
        p_('<strong>' + esc_(d.business) + '</strong>, your free trial ends ' + (Number(d.daysLeft) <= 1 ? '<strong>tomorrow</strong>' : 'in <strong>' + esc_(d.daysLeft) + ' days</strong>') + (d.trialEndsOn ? ' (on ' + esc_(d.trialEndsOn) + ')' : '') + '.') +
        p_('Choose a plan now so buyers can keep ordering. You can pay by card or bank transfer, and your products, orders and settings stay exactly as they are.') +
        button_('Choose a plan', d.planUrl, 'accent');
      break;

    case 'TRIAL_EXPIRED':
      body = h1_(d.heading || 'Your free trial has ended') +
        p_('<strong>' + esc_(d.business) + '</strong> is closed to buyers for now because the free trial has ended.') +
        p_('Everything you set up is saved. Choose a plan and your store opens again straight away.') +
        button_('Choose a plan', d.planUrl, 'accent');
      break;

    // ---- V3: OnePay receipts ------------------------------------------------------
    case 'SUBSCRIPTION_RECEIPT':
      body = h1_(d.heading || 'Payment received') +
        p_('Thank you. We received your payment for <strong>' + esc_(d.business) + '</strong>.') +
        infoBox_(
          kv_('Plan', esc_(d.plan)) +
          kv_('Amount', rs_(d.amount)) +
          kv_('Paid by', esc_(d.method || 'Card (OnePay)')) +
          kv_('Paid on', esc_(d.paidOn)) +
          kv_('Active until', esc_(d.validUntil)) +
          kv_('Reference', esc_(d.reference)) +
          (d.transactionId ? kv_('OnePay transaction', esc_(d.transactionId)) : '')
        ) +
        p_('Keep this email as your receipt.') +
        button_('View my subscription', d.planUrl, 'brand');
      break;

    case 'ORDER_PAID':
      body = h1_(d.heading || 'Card payment received') +
        p_('<strong>' + esc_(d.customer) + '</strong> paid <strong>' + rs_(d.total) + '</strong> by card for order <strong>' + esc_(d.orderCode) + '</strong>.') +
        infoBox_(kv_('OnePay transaction', esc_(d.transactionId || '')) + kv_('Payout', 'OnePay pays out to your bank account (usually T+2).')) +
        button_('View order', d.ordersUrl, 'brand');
      break;

    case 'ORDER_PAYMENT_RECEIPT':
      body = orderBody_(d);
      footer = orderFooter_(d);
      break;

    // ---- V3: seller verification ---------------------------------------------------
    case 'VERIFICATION_SUBMITTED':
      body = h1_(d.heading || 'New verification to review') +
        p_('<strong>' + esc_(d.business) + '</strong> uploaded an ID copy and an address proof.') +
        button_('Review documents', d.reviewUrl, 'accent');
      break;

    case 'VERIFICATION_APPROVED':
      body = h1_(d.heading || 'Your business is verified') +
        p_('Congratulations! <strong>' + esc_(d.business) + '</strong> is now a <strong>Verified Sri Lankan Business</strong> on Sidadiya.') +
        p_('The verified seal now shows on your store and product pages, so buyers know they can trust you.') +
        (d.storeUrl ? button_('See my store', d.storeUrl, 'brand') : '');
      break;

    case 'VERIFICATION_REJECTED':
      body = h1_(d.heading || 'Verification needs attention') +
        p_('We could not verify <strong>' + esc_(d.business) + '</strong> yet.') +
        (d.reason ? infoBox_(kv_('Reason', esc_(d.reason))) : '') +
        p_('Please upload clear copies of both documents again in Store settings.') +
        button_('Upload documents', d.settingsUrl, 'accent');
      break;

    // ---- V3: weekly summary (Monday morning) ---------------------------------------
    case 'WEEKLY_SUMMARY':
      body = weeklyBody_(d);
      break;

    default:
      body = h1_(n.subject || 'Sidadiya') + p_(esc_(n.message || ''));
  }
  return shell_(body, footer);
}

// V3: the Monday summary. Numbers first, then top products and traffic sources.
function weeklyBody_(d) {
  function change(pct) {
    if (pct === null || pct === undefined) return '';
    var up = Number(pct) >= 0;
    return ' <span style="font-size:13px;color:' + (up ? '#1b6b3f' : '#b3261e') + ';">' + (up ? '▲ +' : '▼ ') + esc_(pct) + '%</span>';
  }
  var top = (d.topProducts || []).map(function (p) {
    return '<tr><td style="font-family:' + SANS + ';font-size:14px;padding:5px 0;border-bottom:1px solid ' + THEME.line + ';">' + esc_(p.name) + '</td>' +
      '<td align="right" style="font-family:' + MONO + ';font-size:14px;padding:5px 0;border-bottom:1px solid ' + THEME.line + ';">' + esc_(p.units) + ' sold</td></tr>';
  }).join('');
  var src = (d.trafficSources || []).map(function (t) {
    return '<tr><td style="font-family:' + SANS + ';font-size:14px;padding:5px 0;text-transform:capitalize;border-bottom:1px solid ' + THEME.line + ';">' + esc_(t.source) + '</td>' +
      '<td align="right" style="font-family:' + MONO + ';font-size:14px;padding:5px 0;border-bottom:1px solid ' + THEME.line + ';">' + esc_(t.sessions) + ' visitors' + (t.orders ? ', ' + esc_(t.orders) + ' orders' : '') + '</td></tr>';
  }).join('');
  function h2(t) { return '<h2 style="margin:16px 0 6px;font-family:' + DISPLAY + ';font-size:16px;font-weight:700;color:' + THEME.ink + ';">' + t + '</h2>'; }
  return h1_(d.heading || 'Your weekly summary') +
    p_('<strong>' + esc_(d.business) + '</strong>, here is how your store did from ' + esc_(d.periodStart) + ' to ' + esc_(d.periodEnd) + '.') +
    infoBox_(
      kv_('Sales', rs_(d.revenue) + change(d.revenueChangePct)) +
      kv_('Orders', esc_(d.orders) + change(d.ordersChangePct)) +
      kv_('Average order', rs_(d.avgOrder)) +
      kv_('Visitors', esc_(d.visitors))
    ) +
    h2('Top products') + (top ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + top + '</table>' : p_('No sales this week. A new photo or a WhatsApp status post can bring buyers back.')) +
    h2('Where visitors came from') + (d.trafficLocked ? p_('See which posts and apps bring your buyers: WhatsApp, Facebook, Instagram, Google and TikTok. ' + (d.planUrl ? '<a href="' + esc_(d.planUrl) + '" style="color:' + THEME.brand + ';font-weight:700;">Upgrade to Pro</a>' : 'Available on the Pro plan.')) : src ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + src + '</table>' : p_('No visits recorded. Share your store link to get started.')) +
    '<div style="margin-top:14px;">' + button_('See full reports', d.reportsUrl, 'brand') + (d.storeUrl ? button_('Open my store', d.storeUrl, 'accent') : '') + '</div>' +
    '<p style="margin:14px 0 0;font-family:' + SANS + ';font-size:12px;color:' + THEME.muted + ';">You get this every Monday. Turn it off in <a href="' + esc_(d.settingsUrl) + '" style="color:' + THEME.muted + ';">Store settings</a>.</p>';
}

// ---- Handy for testing: preview an order email without sending --------------
function previewOrderConfirmed() {
  var html = renderEmail_({
    type: 'ORDER_CONFIRMED', subject: 'Your order is confirmed', message: '',
    data: {
      heading: 'Your order is confirmed',
      intro: 'Thanks for shopping with ABC Fashion. We have confirmed your order and started getting it ready.',
      business: 'ABC Fashion', storeName: 'ABC Fashion', orderCode: 'ORD-10452', customer: 'Nimal Silva',
      items: [{ name: 'Cotton Shirt (Blue, L)', qty: 2, price: 3500 }, { name: 'Leather Belt', qty: 1, price: 2200 }],
      subtotal: 9200, discount: 500, deliveryFee: 350, total: 9050,
      fulfilment: 'delivery', address: '42 Galle Road', city: 'Dehiwala', district: 'Colombo',
      payment: 'Cash on delivery', shopPhone: '077 123 4567', shopWhatsapp: '077 123 4567',
      shopAddress: 'Hyde Park, Colombo', storeUrl: cfg_().apiBase + '/store/abc-fashion'
    }
  });
  Logger.log(html);
  // MailApp.sendEmail({ to: Session.getActiveUser().getEmail(), subject: 'Preview: order confirmed', htmlBody: html, name: 'Sidadiya' });
}

// =============================================================================
// V3: Google Sheet sync. Mirrors Shops / Payments / Shipments from the API into
// the spreadsheet in Script property SHEETS_SYNC_ID. Each tab is rewritten in
// full every run (headers come from the API, so new columns need no script
// change). Read-only: nothing in the Sheet is ever sent back to the platform.
// =============================================================================
var SYNC_TABS_ = [['Shops', 'shops'], ['Payments', 'payments'], ['Shipments', 'shipments']];

function syncSheets() {
  var c = cfg_();
  if (!c.token) throw new Error('Set NOTIFY_TOKEN in Script properties first.');
  if (!c.sheetsSyncId) throw new Error('Set SHEETS_SYNC_ID (the spreadsheet ID) in Script properties first.');
  var ss = SpreadsheetApp.openById(c.sheetsSyncId);
  SYNC_TABS_.forEach(function (t) {
    var res = UrlFetchApp.fetch(c.apiBase + '/api/notifications/export/' + t[1], {
      method: 'get', headers: { 'x-notify-token': c.token }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('Sync ' + t[0] + ' failed: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
      return; // keep the old data in that tab rather than blanking it
    }
    var body = JSON.parse(res.getContentText());
    var values = [body.columns].concat(body.rows || []).map(function (r) {
      return r.map(function (v) { return v === null || v === undefined ? '' : v; });
    });
    var sh = ss.getSheetByName(t[0]) || ss.insertSheet(t[0]);
    sh.clearContents();
    sh.getRange(1, 1, values.length, body.columns.length).setValues(values);
    sh.getRange(1, 1, 1, body.columns.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    Logger.log('Synced ' + t[0] + ': ' + (values.length - 1) + ' rows.');
  });
  var info = ss.getSheetByName('Sync info') || ss.insertSheet('Sync info');
  info.getRange(1, 1, 1, 2).setValues([['Last synced', new Date()]]);
}

// Run once: hourly sheet sync (the 1 minute email trigger is separate).
function installSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncSheets') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncSheets').timeBased().everyHours(1).create();
  Logger.log('Trigger installed: syncSheets every hour.');
}

// ---- V3 previews: log the HTML (uncomment the MailApp line to email yourself) --
function previewV3_(type, data) {
  var html = renderEmail_({ type: type, subject: type, message: '', data: data });
  Logger.log(html);
  // MailApp.sendEmail({ to: Session.getActiveUser().getEmail(), subject: 'Preview: ' + type, htmlBody: html, name: 'Sidadiya' });
  return html;
}
function previewTrialStarted() {
  var b = cfg_().apiBase;
  return previewV3_('TRIAL_STARTED', { business: 'ABC Fashion', storeUrl: b + '/store/abc-fashion', dashboardUrl: b + '/dashboard/', email: 'owner@example.com', trialDays: 14, trialEndsOn: '2026-10-13' });
}
function previewTrialReminder() {
  return previewV3_('TRIAL_REMINDER', { business: 'ABC Fashion', daysLeft: 3, trialEndsOn: '2026-10-13', planUrl: cfg_().apiBase + '/dashboard/subscription' });
}
function previewSubscriptionReceipt() {
  return previewV3_('SUBSCRIPTION_RECEIPT', { business: 'ABC Fashion', plan: 'Business', amount: 1399, reference: 'SUB-8F2K1', transactionId: 'OP123456', paidOn: '2026-09-29 10:42', validUntil: '2026-10-29', planUrl: cfg_().apiBase + '/dashboard/subscription' });
}
function previewOrderShippedTracking() {
  var b = cfg_().apiBase;
  return previewV3_('ORDER_SHIPPED', {
    heading: 'Your order is on the way', intro: 'Your order from ABC Fashion has shipped with Domex.',
    business: 'ABC Fashion', storeName: 'ABC Fashion', orderCode: 'ORD-10452', customer: 'Nimal Silva',
    items: [{ name: 'Cotton Shirt (Blue, L)', qty: 2, price: 3500 }], subtotal: 7000, deliveryFee: 350, total: 7350,
    fulfilment: 'delivery', address: '42 Galle Road', city: 'Dehiwala', district: 'Colombo', payment: 'Cash on delivery',
    courier: 'Domex', trackingNumber: 'DX123456789LK', trackingUrl: 'https://www.domex.lk/',
    statusUrl: b + '/store/order?s=abc-fashion&o=ORD-10452&k=demo', storeUrl: b + '/store/abc-fashion'
  });
}
function previewWeeklySummary() {
  var b = cfg_().apiBase;
  return previewV3_('WEEKLY_SUMMARY', {
    business: 'ABC Fashion', periodStart: '2026-09-21', periodEnd: '2026-09-27',
    revenue: 48500, orders: 12, avgOrder: 4042, revenueChangePct: 18, ordersChangePct: -5, visitors: 340,
    topProducts: [{ name: 'Cotton Shirt', units: 7 }, { name: 'Leather Belt', units: 3 }],
    trafficSources: [{ source: 'facebook', sessions: 180, orders: 6 }, { source: 'whatsapp', sessions: 95, orders: 4 }],
    storeUrl: b + '/store/abc-fashion', reportsUrl: b + '/dashboard/reports', settingsUrl: b + '/dashboard/settings#weekly'
  });
}
