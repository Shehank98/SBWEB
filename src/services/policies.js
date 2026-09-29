// Mandatory policy pages (card network / OnePay compliance): Refund, Privacy, Return,
// Terms & Conditions, plus Contact Details. Default templates are written for Sri
// Lanka and filled with the shop's own name and contact data. The text uses a tiny
// markdown subset rendered safely by the frontend: "## " headings, "- " bullets and
// blank-line paragraphs.
//
// NOTE: these are sensible starting templates, not legal advice. Sellers (and the
// platform) should review them; OnePay also publishes samples at
// docs.onepay.lk/guide/policy-samples.
import { query } from '../db/pool.js';
import { getSetting } from './settings.js';

export const POLICY_KINDS = ['refund', 'privacy', 'return', 'terms'];
export const TITLES = {
  refund: 'Refund Policy',
  privacy: 'Privacy Policy',
  return: 'Return Policy',
  terms: 'Terms & Conditions',
  contact: 'Contact Details',
};

// P.O. Box style addresses are not accepted: card networks need a physical address.
const PO_BOX = /\b(p\s*\.?\s*o\s*\.?\s*box|p\s*\.?\s*o\s*\.?\s*b\b|post\s*office\s*box|post\s*box|pobox|po#)|තැපැල්\s*පෙට්ටිය|அஞ்சல்\s*பெட்டி/i;
export function isPoBox(address) { return PO_BOX.test(String(address || '')); }

export function validateContact({ email, phone, address }) {
  const errors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim())) errors.email = 'Enter a business email like shop@example.com.';
  const digits = String(phone || '').replace(/[\s()-]/g, '');
  if (!/^(\+94|0)\d{9}$/.test(digits)) errors.phone = 'Enter a Sri Lankan phone number like 077 123 4567.';
  const a = String(address || '').trim();
  if (isPoBox(a)) errors.address = 'A P.O. Box is not accepted. Enter the physical address where you run your business.';
  else if (a.length < 10 || !/[a-z඀-෿஀-௿]{3,}/i.test(a) || !/[\s,]/.test(a)) errors.address = 'Enter a full physical address (house or building number, street and town).';
  return errors;
}

const SHIPPING = {
  buyer: 'The buyer pays the return shipping cost, unless the item arrived damaged, faulty or not as described.',
  seller: 'We pay the return shipping cost.',
  seller_if_faulty: 'We pay the return shipping cost when the item arrived damaged, faulty or not as described. For other returns (for example a change of mind) the buyer pays it.',
};

// ---- Templates -------------------------------------------------------------------
// ctx: { name, email, phone, address, city, returnDays, refundDays, returnShipping, platform }
export const TEMPLATES = {
  refund: (c) => `This Refund Policy explains when and how ${c.name} refunds purchases made on our online store.

## When you can get a refund
- The item arrived damaged, faulty or different from what you ordered.
- The item was not delivered.
- You returned an item under our Return Policy and we accepted the return.
- We cancelled your order, or could not supply the item.

## When refunds are not given
- Items that were used, washed, altered or damaged after delivery.
- Perishable goods (such as food) unless they arrived spoiled or unsafe.
- Personalised or made-to-order items, unless they arrived faulty.
- Requests made after the time limit below.

## Time limit
Please contact us within ${c.refundDays} days of receiving your order. For a missing delivery, contact us within ${c.refundDays} days of the expected delivery date.

## How to request a refund
1. Contact us at ${c.email}${c.phone ? ` or ${c.phone}` : ''} with your order number.
2. Tell us what went wrong and, where possible, send clear photos.
3. We reply within 3 working days and tell you if the item needs to be returned first.

## How you are refunded
- Card payments are refunded to the same card. Banks usually take 5 to 10 working days to show it.
- Cash on delivery and bank transfer payments are refunded by bank transfer to an account in your name.
- Delivery charges are refunded when the refund is due to our mistake.

If a refund is approved we process it within 7 working days. Full or partial refunds depend on the condition of the returned item.

## Contact
${c.name}, ${c.address}. Email ${c.email}${c.phone ? `, phone ${c.phone}` : ''}.`,

  privacy: (c) => `This Privacy Policy explains how ${c.name} ("we") collects, uses and protects your personal data when you use our online store. We follow the Personal Data Protection Act, No. 9 of 2022 of Sri Lanka.

## Data we collect
- Your name, phone number, WhatsApp number and email address.
- Your delivery address, town and district.
- Your order details: products, amounts, payment method and notes you add.
- Basic technical data such as the page you came from, to understand how people find our store.

We do not see or store your card number. Card payments are handled by our payment provider (OnePay), which is PCI DSS compliant.

## How we use your data
- To confirm, deliver and support your orders, including calls or WhatsApp messages about them.
- To send order updates, receipts and tracking details.
- To handle returns, refunds and complaints.
- To keep records required by Sri Lankan law.

We do not sell your personal data. We share it only with the people who need it to fulfil your order: couriers (name, phone and address), our payment provider, and our e-commerce platform provider Sidadiya, which hosts our store.

## How long we keep it
We keep order records for as long as needed for the purposes above and to meet legal and tax requirements, usually up to 7 years, then delete or anonymise them.

## How we protect it
Your data is stored with secure, access-controlled services and sent over encrypted (HTTPS) connections.

## Your rights
Under the Personal Data Protection Act you can ask us to:
- show you the personal data we hold about you,
- correct data that is wrong or incomplete,
- delete your data when we no longer need it (unless the law requires us to keep it),
- stop using your data for a particular purpose.

## Deletion requests and questions
Email ${c.email}${c.phone ? ` or call ${c.phone}` : ''} with your name, phone number and request. We reply within 21 days.

${c.name}, ${c.address}.`,

  return: (c) => `This Return Policy explains how to return an item bought from ${c.name}.

## Return window
You can ask to return an item within ${c.returnDays} days of receiving it.

## Conditions
- The item is unused, unwashed and in its original condition, with tags and packaging.
- You have your order number or receipt.
- Some items cannot be returned for hygiene or safety reasons (for example underwear, cosmetics that were opened, perishable food and personalised items), unless they arrived damaged or faulty.

## Exchanges
If you need a different size or colour, tell us when you contact us and we will exchange it if it is in stock.

## Return shipping
${SHIPPING[c.returnShipping] || SHIPPING.buyer}

## How to return an item
1. Contact us at ${c.email}${c.phone ? ` or ${c.phone}` : ''} within ${c.returnDays} days, with your order number and the reason.
2. We confirm the return and send you the return address and instructions.
3. Send or bring the item back well packed. Keep your courier receipt.
4. Once we receive and check the item, we arrange your exchange or refund under our Refund Policy.

## Damaged or wrong items
If your item arrives damaged, faulty or is not what you ordered, contact us within 48 hours of delivery with photos, and we will make it right.

${c.name}, ${c.address}.`,

  terms: (c) => `These Terms & Conditions apply to every purchase from ${c.name} through our online store. By placing an order you agree to them.

## About us
${c.name} is a business based in ${c.city || 'Sri Lanka'}. Address: ${c.address}. Email: ${c.email}${c.phone ? `. Phone: ${c.phone}` : ''}. Our store runs on the Sidadiya e-commerce platform; the sale is between you and ${c.name}.

## Scope
These terms cover browsing our store, placing orders, payment, delivery, returns and refunds. Our Refund Policy, Return Policy and Privacy Policy form part of these terms.

## Orders and prices
- All prices are in Sri Lankan Rupees (LKR) and include any applicable taxes unless stated.
- An order is a request to buy. It is accepted when we confirm it.
- We may cancel an order if an item is out of stock, a price was shown in error, or we cannot verify the order. If you already paid, we refund you in full.

## Payment terms
- We accept the payment methods shown at checkout, which may include cash on delivery, bank transfer and card payments.
- Card payments are processed securely by OnePay with 3D Secure. We never see or store your full card details.
- For bank transfers, we dispatch after the payment is received in our account.

## Delivery
We deliver within Sri Lanka through courier partners. Delivery times shown are estimates. Risk in the goods passes to you on delivery.

## Returns and refunds
Returns and refunds are handled under our Return Policy and Refund Policy. Nothing in these terms limits your rights under the Consumer Affairs Authority Act, No. 9 of 2003.

## Limitation of liability
To the extent the law allows, our total liability for any order is limited to the amount you paid for that order. We are not responsible for indirect or consequential losses, or for delays caused by events outside our reasonable control (such as natural disasters, strikes or courier disruptions).

## Dispute resolution
If you are unhappy, please contact us first at ${c.email} and we will try to resolve it within 14 days. If we cannot agree, either side may refer the dispute to mediation or to the Consumer Affairs Authority of Sri Lanka, or to the courts.

## Governing law
These terms are governed by the laws of the Democratic Socialist Republic of Sri Lanka, and the courts of Sri Lanka have jurisdiction.

## Changes
We may update these terms. The version shown on our store when you place your order applies to that order.`,
};

function ctxFor(store, biz) {
  return {
    name: store.name || (biz && biz.name) || 'Our store',
    email: store.contact_email || (biz && biz.email) || '',
    phone: store.phone || (biz && biz.phone) || '',
    address: store.address || [store.city, biz && biz.district].filter(Boolean).join(', ') || 'Sri Lanka',
    city: store.city || '',
    returnDays: store.return_days || 14,
    refundDays: store.refund_days || 7,
    returnShipping: store.return_shipping || 'buyer',
  };
}

// Make sure all four policy rows exist for a shop (called on signup; the migration
// back-filled existing shops).
export async function ensurePolicies(businessId, client) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO store_policies (business_id, kind) SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`,
    [businessId, POLICY_KINDS]
  );
}

// All four policies for a shop with the effective (rendered or custom) text.
export async function loadPolicies(businessId) {
  await ensurePolicies(businessId);
  const store = (await query('SELECT * FROM stores WHERE business_id = $1', [businessId])).rows[0] || {};
  const biz = (await query('SELECT name, email, phone, district FROM businesses WHERE id = $1', [businessId])).rows[0] || {};
  const rows = (await query('SELECT * FROM store_policies WHERE business_id = $1', [businessId])).rows;
  const ctx = ctxFor(store, biz);
  const out = {};
  for (const kind of POLICY_KINDS) {
    const r = rows.find((x) => x.kind === kind) || {};
    out[kind] = {
      key: kind,
      title: TITLES[kind],
      content: r.is_custom && r.content ? r.content : TEMPLATES[kind](ctx),
      isCustom: !!r.is_custom,
      confirmedAt: r.confirmed_at || null,
      updatedAt: r.updated_at || null,
    };
  }
  return { policies: out, store, biz, ctx };
}

// The five-item compliance checklist. Card payments stay off until all are done.
export async function compliance(businessId) {
  const { policies, store, biz } = await loadPolicies(businessId);
  const contactErrors = validateContact({ email: store.contact_email || biz.email, phone: store.phone, address: store.address });
  const items = POLICY_KINDS.map((k) => ({
    key: k,
    label: TITLES[k],
    done: !!policies[k].confirmedAt,
    hint: policies[k].confirmedAt ? 'Published' : 'Review the text and publish it',
  }));
  items.push({
    key: 'contact',
    label: TITLES.contact,
    done: Object.keys(contactErrors).length === 0,
    hint: Object.keys(contactErrors).length ? Object.values(contactErrors)[0] : 'Email, physical address and phone are complete',
    errors: contactErrors,
  });
  return { items, complete: items.every((i) => i.done), doneCount: items.filter((i) => i.done).length };
}

// ---- Platform (Sidadiya) legal pages ----------------------------------------------
export async function platformPolicies() {
  const contact = await getSetting('platform_contact', {});
  const custom = await getSetting('platform_policies', {});
  const ctx = {
    name: contact.businessName || 'Sidadiya',
    email: contact.email || '[platform email]',
    phone: contact.phone || '',
    address: contact.address || '[platform address]',
    city: '',
    returnDays: 14,
    refundDays: 7,
    returnShipping: 'seller_if_faulty',
  };
  const out = {};
  for (const kind of POLICY_KINDS) {
    const text = custom && custom[kind] ? custom[kind] : PLATFORM_TEMPLATES[kind](ctx);
    out[kind] = { key: kind, title: TITLES[kind], content: text, isCustom: !!(custom && custom[kind]) };
  }
  return { policies: out, contact };
}

// Platform versions: Sidadiya sells subscriptions to sellers, so the wording is about
// the platform service rather than physical goods.
const PLATFORM_TEMPLATES = {
  refund: (c) => `This Refund Policy covers payments made to ${c.name} for store subscriptions (Starter, Business and Pro plans).

## Free trial
Every new shop gets a free trial. You are not charged during the trial and no card is needed to start.

## Subscription payments
- Plans are billed per month in Sri Lankan Rupees (LKR), in advance.
- If you were charged twice, or charged for a plan you did not select, we refund the extra payment in full.
- If our service was unavailable for a significant part of a paid month because of a fault on our side, contact us and we will refund or credit the affected days.
- Change-of-mind refunds for a month that has already started are not given, but you can stop renewing at any time and keep your store data.

## How to request a refund
Email ${c.email} within 14 days of the payment with your shop name, the payment date and the reason. We reply within 3 working days. Approved card refunds go back to the same card (usually 5 to 10 working days); bank transfer payments are refunded by bank transfer.

## Purchases from shops
Products you buy from a shop on Sidadiya are sold by that shop. Each shop publishes its own refund and return policy on its store.`,

  privacy: (c) => `This Privacy Policy explains how ${c.name} collects and uses personal data. We follow the Personal Data Protection Act, No. 9 of 2022 of Sri Lanka.

## Who we are
${c.name} provides online stores for small businesses in Sri Lanka. For data about shop owners (sellers) we are the controller. For data about buyers, each shop is the controller and we process it on the shop's behalf to run its store.

## Data we collect
- Sellers: name, email, phone, business details, store content, payment records, and identity/address documents submitted for verification.
- Buyers: the details entered at checkout (name, phone, email, address) and order details.
- Technical data: pages visited and where visitors came from (referrer and campaign tags), to give shops traffic reports.

We never store full card numbers. Card payments are processed by OnePay.

## How we use it
To run stores and orders, send order and account emails, process subscription payments, verify sellers, prevent fraud, provide weekly reports to sellers, and meet legal obligations.

## Sharing
We share data only with service providers that help us run the platform (hosting, file storage, email, payment processing) and with the relevant shop for its own orders. We do not sell personal data.

## Security and retention
Data is encrypted in transit, access is restricted, and verification documents are stored privately. We keep data while an account is active and as required by law, then delete or anonymise it.

## Your rights
You can ask to access, correct or delete your personal data, or object to a use of it. Email ${c.email}. We reply within 21 days.`,

  return: (c) => `${c.name} provides a digital service (online stores), so there is nothing physical to return for our subscriptions. See our Refund Policy for subscription refunds.

## Returning products bought from a shop
Products bought from a shop on Sidadiya are returned to that shop, under the shop's own Return Policy, shown in the footer of its store. The default return window we suggest to shops is ${c.returnDays} days.

## If a shop does not respond
If you cannot resolve a return with a shop, email ${c.email} with the shop name and your order number and we will contact the shop.`,

  terms: (c) => `These Terms & Conditions apply to your use of ${c.name}, the online store platform, and to subscription plans bought from us. By creating a shop or using the platform you agree to them.

## The service
${c.name} lets businesses in Sri Lanka open an online store, list products, take orders and receive payments. Each shop is responsible for its own products, prices, delivery, returns and compliance with the law.

## Accounts and trial
You must give accurate details and keep your login safe. New shops get a free trial with Starter features. After the trial, the store is paused until a plan is paid; your data is kept.

## Payment terms
- Plans are priced in LKR per month and paid in advance by card (via OnePay) or bank transfer.
- Unpaid plans pause the store after the grace period. Paying reopens it with all data intact.
- Prices may change with at least 14 days' notice by email.

## Seller rules
Shops must not sell illegal, counterfeit or restricted goods, or mislead buyers. Card payments through OnePay are subject to OnePay's approval; some business types (for example drop-shipping, print-on-demand, gems and jewellery, gambling, dating and donations) are not accepted for card payments. We may suspend shops that break these rules.

## Limitation of liability
To the extent the law allows, our total liability is limited to the subscription fees you paid in the 3 months before the claim. We are not liable for sales, orders or disputes between shops and buyers, or for indirect losses.

## Dispute resolution
Contact us first at ${c.email}; we aim to resolve complaints within 14 days. Unresolved disputes may be referred to mediation or the courts.

## Governing law
These terms are governed by the laws of the Democratic Socialist Republic of Sri Lanka, and the courts of Sri Lanka have jurisdiction.`,
};
