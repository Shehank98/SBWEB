/**
 * Sidadiya: email notifications worker (Google Apps Script)
 * ------------------------------------------------------
 * Polls the backend notifications outbox and sends branded HTML emails for:
 *   REGISTERED (waiting for approval), APPROVED (store link + login),
 *   REJECTED, NEW_ORDER (to the owner), ORDER_CONFIRMATION (to the customer),
 *   ORDER_STATUS (incl. delivered), EXPIRY_REMINDER, SUSPENDED.
 *
 * Setup: see README.md in this folder. In short:
 *   1. Project Settings, Script properties: add API_BASE and NOTIFY_TOKEN.
 *   2. Run `sendPendingEmails` once and grant permissions.
 *   3. Run `installTrigger` once to send every 5 minutes.
 */

// ---- Config (read from Script properties, with safe fallbacks) --------------
function cfg_() {
  var p = PropertiesService.getScriptProperties();
  return {
    apiBase: (p.getProperty('API_BASE') || 'https://sbweb-production.up.railway.app').replace(/\/+$/, ''),
    token: p.getProperty('NOTIFY_TOKEN') || '',
    fromName: p.getProperty('FROM_NAME') || 'Sidadiya',
    batch: Number(p.getProperty('BATCH') || 50)
  };
}

// ---- Main entry point (run on a time trigger) -------------------------------
function sendPendingEmails() {
  var c = cfg_();
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
  Logger.log('Pending notifications: %s', list.length);

  list.forEach(function (n) {
    try {
      MailApp.sendEmail({
        to: n.recipient,
        subject: n.subject,
        htmlBody: renderEmail_(n),
        body: n.message || '',           // plain-text fallback
        name: c.fromName
      });
      mark_(c, n.id, 'sent');
    } catch (err) {
      Logger.log('Send failed for %s: %s', n.id, err);
      mark_(c, n.id, 'failed');
    }
  });
}

function mark_(c, id, what) {
  UrlFetchApp.fetch(c.apiBase + '/api/notifications/' + id + '/' + what, {
    method: 'post',
    headers: { 'x-notify-token': c.token },
    muteHttpExceptions: true
  });
}

// ---- Install a 5-minute trigger (run once) ----------------------------------
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendPendingEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendPendingEmails').timeBased().everyMinutes(5).create();
  Logger.log('Trigger installed: sendPendingEmails every 5 minutes.');
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

// Wraps body HTML in the branded shell.
function shell_(bodyHtml) {
  return '' +
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>@import url("https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=Figtree:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap");</style>' +
    '</head><body style="margin:0;padding:0;background:' + THEME.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + THEME.bg + ';padding:24px 12px;">' +
      '<tr><td align="center">' +
        '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:' + THEME.card + ';border:1px solid ' + THEME.line + ';border-radius:16px;overflow:hidden;">' +
          // header
          '<tr><td style="background:' + THEME.brand + ';padding:20px 28px;">' +
            '<span style="font-family:' + DISPLAY + ';font-size:24px;font-weight:700;color:' + THEME.onBrand + ';letter-spacing:-0.01em;">Sidadiya</span>' +
            '<span style="font-family:' + SANS + ';font-size:13px;color:' + THEME.soft + ';margin-left:10px;">online shops for small businesses</span>' +
          '</td></tr>' +
          // body
          '<tr><td style="padding:28px;">' + bodyHtml + '</td></tr>' +
          // footer
          '<tr><td style="padding:18px 28px;border-top:1px solid ' + THEME.line + ';">' +
            '<p style="margin:0;font-family:' + SANS + ';font-size:12px;color:' + THEME.muted + ';">You are receiving this because you use Sidadiya. Reply to this email if you need help.</p>' +
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

// Build the per-type body; unknown types fall back to the plain message.
function renderEmail_(n) {
  var d = n.data || {};
  var base = cfg_().apiBase;
  var body;

  switch (n.type) {
    case 'REGISTERED':
      body = h1_(d.heading || 'Application received') +
        p_('Thank you for registering <strong>' + esc_(d.business) + '</strong>. Our team is checking your payment slip now.') +
        p_('We will email you the moment your store is approved, usually within a day. Thank you for choosing Sidadiya.');
      break;

    case 'APPROVED':
      body = h1_(d.heading || 'Your store is live 🎉') +
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
        return '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + THEME.ink + ';padding:4px 0;">' + esc_(i.qty) + ' × ' + esc_(i.name) + '</td>' +
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

    case 'ORDER_CONFIRMATION':
      var citems = (d.items || []).map(function (i) {
        return '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + THEME.ink + ';padding:4px 0;">' + esc_(i.qty) + ' x ' + esc_(i.name) + '</td>' +
          '<td align="right" style="font-family:' + MONO + ';font-size:14px;color:' + THEME.ink + ';padding:4px 0;">' + rs_(i.qty * i.price) + '</td></tr>';
      }).join('');
      body = h1_(d.heading || 'Thank you for your order') +
        p_('Thank you for ordering from <strong>' + esc_(d.storeName || d.business) + '</strong>. We have received your order and will let you know when it is on the way.') +
        infoBox_(
          kv_('Order', esc_(d.orderCode)) +
          kv_('Shop', esc_(d.storeName || d.business)) +
          (citems ? '<table role="presentation" width="100%" style="margin-top:8px;border-top:1px solid ' + THEME.line + ';padding-top:8px;">' + citems +
            '<tr><td style="font-family:' + SANS + ';font-weight:700;padding-top:8px;">Total</td><td align="right" style="font-family:' + MONO + ';font-weight:700;padding-top:8px;">' + rs_(d.total) + '</td></tr></table>'
            : kv_('Total', rs_(d.total)))
        ) +
        (d.storeUrl ? button_('Visit the shop', d.storeUrl, 'brand') : '');
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
  return shell_(body);
}

// ---- Handy for testing: preview an email without sending --------------------
function previewApproved() {
  var html = renderEmail_({
    type: 'APPROVED', subject: 'Your online store is ready',
    message: '', data: {
      heading: 'Your store is live', business: 'ABC Fashion', storeName: 'ABC Fashion',
      slug: 'abc-fashion', storeUrl: cfg_().apiBase + '/store/abc-fashion',
      loginUrl: cfg_().apiBase + '/login', email: 'kasun@abc-fashion.lk', planName: 'Business'
    }
  });
  Logger.log(html);
  // MailApp.sendEmail({ to: Session.getActiveUser().getEmail(), subject: 'Preview: store ready', htmlBody: html, name: 'Sidadiya' });
}
