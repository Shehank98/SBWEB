import { getSetting } from './settings.js';

// Platform notice shown to buyers when they open a store (Admin > Settings >
// Buyer notice). It tells buyers that each shop is responsible for its own
// products, delivery and refunds. {shop} is replaced with the shop's name.
export const DEFAULT_BUYER_NOTICE = {
  on: true,
  title: 'Before you shop',
  message: '{shop} is an independent shop that uses Sidadiya to sell online.\n{shop} is responsible for its products, prices, delivery, returns and refunds. Please contact the shop directly with any questions about your order.',
  button: 'I understand',
  updatedAt: null,
};

export async function buyerNoticeSetting() {
  const v = await getSetting('buyer_notice', null).catch(() => null);
  return v ? { ...DEFAULT_BUYER_NOTICE, ...v } : { ...DEFAULT_BUYER_NOTICE };
}

// What the storefront gets: null when switched off. `version` changes whenever the
// admin edits the text, so buyers see the new notice once.
export async function publicBuyerNotice() {
  const n = await buyerNoticeSetting();
  if (!n.on || !String(n.message || '').trim()) return null;
  return { title: n.title, message: n.message, button: n.button || 'I understand', version: n.updatedAt || 'default' };
}
