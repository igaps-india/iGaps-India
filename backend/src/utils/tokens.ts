import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

// ── Magic links ───────────────────────────────────────────────────────────────

/** Generate a URL-safe magic link token and its hash for storage. */
export function generateMagicToken(): { token: string; hash: string; expiry: Date } {
  const token = randomBytes(32).toString('hex');
  const hash = hashToken(token);
  const expiry = new Date(Date.now() + config.auth.magicLinkExpiresMinutes * 60 * 1000);
  return { token, hash, expiry };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Admin JWT ─────────────────────────────────────────────────────────────────

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

export function signJwt(payload: JwtPayload): string {
  return jwt.sign(payload, config.auth.jwtSecret, { expiresIn: config.auth.jwtExpiresIn } as jwt.SignOptions);
}

export function verifyJwt(token: string): JwtPayload {
  return jwt.verify(token, config.auth.jwtSecret) as JwtPayload;
}
