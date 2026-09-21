import { Router } from 'express';
import { query } from '../db/pool.js';
import { wrap } from '../utils/http.js';
import * as S from '../services/serialize.js';

export const plansRouter = Router();

// GET /api/plans — public, drives the pricing table and registration plan picker.
plansRouter.get(
  '/',
  wrap(async (_req, res) => {
    const { rows } = await query(`SELECT * FROM plans WHERE status = 'ACTIVE' ORDER BY sort_order, price`);
    res.json({ plans: rows.map(S.plan) });
  })
);
