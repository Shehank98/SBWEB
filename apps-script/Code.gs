/**
 * Sidadiya: email notifications worker (Google Apps Script)
 * ------------------------------------------------------
 * Polls the backend notifications outbox and sends branded HTML emails for:
 *   REGISTERED (waiting for approval), APPROVED (store link + login),
 *   REJECTED, NEW_ORDER (to the owner), ORDER_CONFIRMED and ORDER_SHIPPED
 *   (to the customer), EXPIRY_REMINDER, SUSPENDED.
 *
 * High volume design (Task 2):
 *   - A single time trigger runs sendPendingEmails every 2 minutes.
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
 *   3. Run installTrigger once to send every 2 minutes.
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
    auditSheetId: p.getProperty('AUDIT_SHEET_ID') || ''
  };
}

// ---- Main entry point (run on a 2 minute time trigger) ----------------------
function sendPendingEmails() {
  var c = cfg_();

  // Only one run at a time. If another run holds the lock, skip quietly; the next
  // scheduled run continues from where this one left off.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another run is in progress. Skipping.');
    return;
  }

  try {
    var remaining = MailApp.getRemainingDailyQuota();
    if (remaining <= c.quotaFloor) {
      Logger.log('Daily quota low (%s left, floor %s). Deferring to a later run.', remaining, c.quotaFloor);
      return;
    }

    var res = UrlFetchApp.fetch(c.apiBase + '/api/notifications/pending', {
      method: 'get',
      headers: { 'x-notify-token': c.token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('Poll failed (%s): %s', res.getResponseCode(), res.getContentText());
      return;
    }
    var list = (JSON.parse(res.getContentText()).notifications) || [];
    Logger.log('Pending: %s. Quota left: %s.', list.length, remaining);

    // Send at most: the batch size, and never more than the quota buffer allows.
    var allowance = Math.min(c.batch, remaining - c.quotaFloor);
    var sent = 0, failed = 0, skipped = 0;
    var seen = {}; // in-run guard against an exact duplicate slipping through

    for (var i = 0; i < list.length; i++) {
      if (sent >= allowance) {
        Logger.log('Reached this run allowance (%s). Remaining stay PENDING for next run.', allowance);
        break;
      }
      var n = list[i];
      var key = (n.recipient || '') + '|' + (n.subject || '');
      if (seen[key]) { mark_(c, n.id, 'sent'); skipped++; continue; }
      seen[key] = true;

      try {
        MailApp.sendEmail({
          to: n.recipient,
          subject: n.subject,
          htmlBody: renderEmail_(n),
          body: n.message || '',           // plain-text fallback
          name: c.fromName
        });
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
  } finally {
    lock.releaseLock();
  }
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

// ---- Install a 2 minute trigger (run once) ----------------------------------
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendPendingEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendPendingEmails').timeBased().everyMinutes(2).create();
  Logger.log('Trigger installed: sendPendingEmails every 2 minutes.');
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
      '<td style="font-family:' + SANS + ';font-size:14px;color:' + THEME.ink + ';padding:6px 0;border-bottom:1px solid ' + THEME.line + ';">' + esc_(i.qty) + ' x ' + esc_(i.name) + '</td>' +
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
    '<h2 style="margin:8px 0 6px;font-family:' + DISPLAY + ';font-size:16px;font-weight:700;color:' + THEME.ink + ';">Order summary</h2>' +
    orderTable_(d) +
    orderFulfilment_(d) +
    (d.storeUrl ? button_('Visit the shop', d.storeUrl, 'brand') : '');
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
    case 'ORDER_CONFIRMED':
    case 'ORDER_SHIPPED':
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

    default:
      body = h1_(n.subject || 'Sidadiya') + p_(esc_(n.message || ''));
  }
  return shell_(body, footer);
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
