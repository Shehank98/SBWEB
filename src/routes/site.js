import { Router } from 'express';
import { wrap, notFound } from '../utils/http.js';
import { getSetting, trialDays } from '../services/settings.js';
import { platformPolicies, POLICY_KINDS, TITLES } from '../services/policies.js';
import { maintenanceState, publicMaintenance } from '../services/maintenance.js';

// Public platform data for the main Sidadiya site: contact details, legal pages and
// marketing numbers. Nothing here is sensitive.
export const siteRouter = Router();

siteRouter.get(
  '/',
  wrap(async (_req, res) => {
    const contact = await getSetting('platform_contact', {});
    res.json({
      contact,
      trialDays: await trialDays(),
      // Marketing social proof, editable in Admin Settings ("40+ shops onboarded").
      socialProof: await getSetting('social_proof', { count: 40, label: 'shops onboarded' }),
      policies: [...POLICY_KINDS, 'contact'].map((k) => ({ key: k, title: TITLES[k] })),
    });
  })
);

// Polled by the "shop is closed" page: is maintenance on, and how to reach us.
siteRouter.get(
  '/status',
  wrap(async (_req, res) => {
    const contact = await getSetting('platform_contact', {}).catch(() => ({}));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, maintenance: publicMaintenance(await maintenanceState()), contact: { whatsapp: (contact && contact.whatsapp) || '', email: (contact && contact.email) || '' } });
  })
);

siteRouter.get(
  '/policies/:kind',
  wrap(async (req, res) => {
    const { policies, contact } = await platformPolicies();
    if (req.params.kind === 'contact') return res.json({ key: 'contact', title: TITLES.contact, contact });
    const p = policies[req.params.kind];
    if (!p) throw notFound('Page not found.');
    res.json(p);
  })
);
