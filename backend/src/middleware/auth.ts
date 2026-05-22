import { Request, Response, NextFunction } from 'express';
import { verifyJwt } from '../utils/tokens';
import { UserRole } from '../models/User';

export interface AuthRequest extends Request {
  user?: { userId: string; email: string; role: UserRole };
}

/** Require a valid admin JWT in the Authorization header. */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorised' });
    return;
  }

  try {
    const token = header.slice(7);
    const payload = verifyJwt(token);
    req.user = { userId: payload.userId, email: payload.email, role: payload.role as UserRole };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Require admin role specifically. */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden — admin role required' });
      return;
    }
    next();
  });
}
