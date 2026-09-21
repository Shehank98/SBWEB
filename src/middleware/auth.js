import { verifyToken } from '../utils/auth.js';
import { unauthorized, forbidden } from '../utils/http.js';

// Reads the Bearer token and attaches req.user = { sub, role, business_id, name }.
// Never trusts a business_id from the request body/query — it comes only from the token.
export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(unauthorized('Your session has expired. Please sign in again.'));
  }
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

// Business owner/staff routes: guarantees req.user.business_id is present so every
// query below can scope by it. This is the core of tenant isolation.
export function requireBusiness(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role === 'SUPER_ADMIN') return next(); // admin may act cross-tenant via explicit ids
  if (!req.user.business_id) return next(forbidden('This account is not linked to a store.'));
  next();
}
