import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(user) {
  // Keep the token small: the claims the API needs to authorise every request.
  const payload = {
    sub: user.id,
    role: user.role,
    business_id: user.business_id || null,
    name: user.name,
    permissions: user.role === 'BUSINESS_STAFF' ? (user.permissions || []) : null,
  };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}
