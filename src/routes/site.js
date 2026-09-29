import { Router } from 'express';
import { wrap, notFound } from '../utils/http.js';
import { getSetting, trialDays } from '../services/settings.js';
import { platformPolicies, POLICY_KINDS, TITLES } from '../services/policies.js';

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
      policies: [...POLICY_KINDS, 'contact'].map((k) => ({ key: k, title: TITLES[k] })),
    });
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
