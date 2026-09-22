# Sidadiya email notifications — Google Apps Script

This turns the backend's **notifications outbox** into real emails, sent from your
Google account, styled to match the Sidadiya site (Figtree / Bricolage, brand green).

The API never sends email itself. It writes rows to a `notifications` table. This
script polls those rows every 2 minutes, sends a branded email for each, and marks
it as sent. If Google is down, nothing is lost: the rows just wait.

**Built for high volume.** One trigger runs every 2 minutes behind a script lock, so
two runs never overlap and no email goes out twice. Before sending, it checks the
remaining daily Gmail quota and defers the rest of the queue if the quota is low, so
a burst of orders never drains your account. Each run sends up to `BATCH` emails and
stops early if the quota buffer runs out; whatever is left stays `PENDING` and the
next run resumes from there. Deduplication is enforced on the backend (a unique key
per order event) and double checked inside each run.

## What it sends

| Type | When | Goes to |
| --- | --- | --- |
| `REGISTERED` | A business registers | Owner |
| `APPROVED` | Admin approves a business | Owner — **includes the store link + login** |
| `REJECTED` | Admin rejects a business | Owner (with the reason) |
| `NEW_ORDER` | A customer places an order | Owner (with items + total) |
| `ORDER_CONFIRMED` | Owner marks the order confirmed | Customer (full order summary) |
| `ORDER_SHIPPED` | Owner marks the order shipped | Customer (full order summary) |
| `EXPIRY_REMINDER` | 7 / 3 / 1 days before expiry | Owner |
| `SUSPENDED` | Subscription lapses | Owner |

The customer is emailed only at the two moments that matter to them, when the order
is **confirmed** and when it **ships**, so inboxes stay uncluttered.

## Setup (about 5 minutes)

1. Go to **https://script.google.com** → **New project**.
2. Delete the sample `Code.gs`, then paste the contents of **`Code.gs`** from this
   folder.
3. Click the gear (**Project Settings**) → scroll to **Script properties** →
   **Add script property** for each:

   | Property | Value |
   | --- | --- |
   | `API_BASE` | Your backend URL, e.g. `https://sbweb-production.up.railway.app` |
   | `NOTIFY_TOKEN` | The same value as `NOTIFY_TOKEN` in the backend env (falls back to `JWT_SECRET` if you never set one) |
   | `FROM_NAME` | Optional. The sender name shown in inboxes (default `Sidadiya`) |
   | `BATCH` | Optional. Max emails sent per run (default `50`) |
   | `QUOTA_FLOOR` | Optional. Stop sending when fewer than this many emails remain in today's quota (default `15`) |
   | `AUDIT_SHEET_ID` | Optional. A Google Sheet ID; every send is appended as one row for auditing |

4. Back in the editor, select the function **`sendPendingEmails`** and click **Run**.
   Google asks you to **review permissions** the first time. Approve them
   (it needs "send email as you" and "connect to an external service").
5. Select **`installTrigger`** and click **Run** once. This schedules
   `sendPendingEmails` to run **every 2 minutes** automatically.

That's it. New registrations, approvals, orders and reminders now arrive as email.

### Audit log (optional)

To keep a full record of every email sent, create a blank Google Sheet, copy its ID
from the URL (`docs.google.com/spreadsheets/d/<THIS_PART>/edit`), and set it as
`AUDIT_SHEET_ID`. Each send appends a row: timestamp, notification id, type,
recipient, subject and outcome. The backend also records the send: the row's
`status` becomes `SENT` with a `sent_at` timestamp, and `attempts` counts retries.

## Test it

- In the editor, run **`previewOrderConfirmed`**, then open **Execution log**
  (View → Logs) to see the rendered HTML. Uncomment the last line to email a
  test copy to yourself.
- Or trigger a real one: register a shop on the site, then run `sendPendingEmails`
  and check the inbox.

## Backend requirement

Set `NOTIFY_TOKEN` on the backend (Railway → Variables) to a long random string and
use the **same** value here. The outbox endpoints are protected by this token:

```
GET  /api/notifications/pending        (header: x-notify-token)
POST /api/notifications/:id/sent
POST /api/notifications/:id/failed
```

## Notes & limits

- Gmail's daily send limit is **500** for consumer accounts and **2,000** for Google
  Workspace. Plenty for a growing platform; if you outgrow it, switch the transport
  to SendGrid/Mailgun (same script, change `MailApp.sendEmail` to a `UrlFetchApp`
  call to their API).
- Email clients rarely load web fonts, so the templates fall back gracefully to the
  system sans-serif while keeping the Sidadiya colours, layout and buttons.
- Customers only get order-status emails if they enter an email at checkout; the
  storefront also offers a WhatsApp message for those who don't.
