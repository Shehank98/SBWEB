// "How to get OnePay" guide shown to sellers in Shop settings > Payment gateways.
// Admin-editable (Admin Settings > OnePay guide, stored in platform_settings under
// 'onepay_guide'). The default content is the information supplied by the product
// owner from OnePay's documentation and onboarding process; review it with OnePay
// before launch, as fees and document lists can change.
import { getSetting } from './settings.js';

export const DEFAULT_GUIDE = {
  intro: 'Accept Visa, Mastercard and Amex on your store with your own OnePay merchant account. Money goes straight to your bank account.',
  steps: [
    'Contact OnePay (support@onepay.lk or onepay.lk/contact-us) and say you want to register as an individual seller.',
    'OnePay sends you the document checklist. Submit the documents listed below.',
    'OnePay reviews your documents and prepares the merchant agreement.',
    'Sign the agreement digitally.',
    'OnePay submits your application and your store website to the bank for card network clearance (a maximum of 3 working days).',
    'When approved, open the OnePay merchant dashboard, create an app, copy the App ID and Hash salt into this page, and paste your callback URL into the app settings.',
  ],
  documents: [
    'NIC copy (passport if you are not a Sri Lankan citizen)',
    'Bank account proof: a bank verification document or an online banking statement less than 3 months old, showing the bank logo, bank name, account holder name and account number',
    'Utility bill or other address proof (passport holders can use an electricity or water bill, or a Grama Niladhari address verification)',
    'Your website or social media page showing prices (your Sidadiya store link)',
    'Refund, return and privacy policies (your Sidadiya policy pages)',
    'Grama Niladhari (Gramasewaka) certificate',
    'Business registration certificate (only for sole proprietors, not individuals)',
    'Recent education qualification (only for the education category)',
  ],
  complianceNote: 'OnePay checks that these 5 items are live on your store before your application goes to the bank for card network review: Refund Policy, Privacy Policy, Return Policy, Terms & Conditions, and Contact Details (email, physical address and phone). Complete them in Policies & compliance first.',
  costs: [
    'Setup fee: about LKR 1,500 (refunded if card network compliance is rejected).',
    'Monthly OnePay plan: Standard LKR 499 (3.5% fee, LKR 100,000 monthly limit), Essential LKR 799, Elevate LKR 2,999, Premier LKR 5,999.',
    'A fee per transaction (MDR) depending on your plan.',
    'Payouts to your bank account: T+2. Refunds to buyers take 3 to 5 working days.',
  ],
  unsupported: ['Drop-shipping', 'Print-on-demand', 'Multi-vendor marketplaces', 'Gems and jewellery', 'Gambling', 'Dating', 'Donation platforms'],
  refunds: 'Refunds are made from your OnePay dashboard (full or partial). Then mark the order as Refunded in Sidadiya with a note.',
  contacts: { email: 'support@onepay.lk', email2: 'info@onepay.lk', phone: '', website: 'https://www.onepay.lk/contact-us', docs: 'https://docs.onepay.lk/guide/policy-samples' },
  phonePlaceholder: 'OnePay phone number: not provided yet. Admin: add it in Admin Settings > OnePay guide.',
};

export async function onepayGuide() {
  const saved = await getSetting('onepay_guide', null);
  if (!saved || typeof saved !== 'object') return DEFAULT_GUIDE;
  return { ...DEFAULT_GUIDE, ...saved, contacts: { ...DEFAULT_GUIDE.contacts, ...(saved.contacts || {}) } };
}
