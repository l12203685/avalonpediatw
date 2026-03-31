import { Request, Response, NextFunction } from 'express';
import { verifyIdToken, getUserProfile, createUserProfile } from '../services/firebase';
import { User } from '@avalon/shared';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      uid?: string;
    }
  }
}

/**
 * Optional auth middleware — attaches req.user if a valid Bearer token is present.
 * Does NOT reject requests without a token.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next();
  }

  const token = header.slice(7);
  try {
    const decoded = await verifyIdToken(token);
    const uid = decoded.uid;

    let user = await getUserProfile(uid);
    if (!user) {
      const newUser: User = {
        uid,
        email: decoded.email || '',
        displayName: decoded.name || (decoded.email || '').split('@')[0],
        photoURL: decoded.picture,
        provider: decoded.firebase?.sign_in_provider === 'github.com' ? 'github' : 'google',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await createUserProfile(newUser);
      user = newUser;
    }

    req.user = user;
    req.uid = uid;
  } catch {
    // Invalid token — continue as unauthenticated
  }

  next();
}

/**
 * Required auth middleware — rejects with 401 if no valid Bearer token.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  await optionalAuth(req, res, async () => {
    if (!req.uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });
}
