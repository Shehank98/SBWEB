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

// Only the store owner (or admin) — used for subscription, settings and staff.
export function requireOwner(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'BUSINESS_OWNER') return next();
  next(forbidden('Only the store owner can do this.'));
}

// Staff must hold the named permission; owners and admins always pass.
export function requirePermission(section) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'BUSINESS_OWNER') return next();
    if (req.user.role === 'BUSINESS_STAFF' && (req.user.permissions || []).includes(section)) return next();
    next(forbidden('Your staff account does not have access to this.'));
  };
}
