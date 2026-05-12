import { readCookie } from '../utils/cookies.js';
import { verifyAdminSessionToken } from '../utils/adminSession.js';

export function requireAdminAuth(req, res, next) {
  const token = readCookie(req, 'admin_session');
  const session = verifyAdminSessionToken(token);

  if (!session) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  req.admin = {
    email: session.email,
    userId: session.userId,
    role: session.role,
    isSuperAdmin: session.isSuperAdmin,
  };
  return next();
}

export function requireAdminRoles(...allowedRoles) {
  return function adminRoleGuard(req, res, next) {
    if (!req.admin) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (allowedRoles.includes(req.admin.role)) {
      return next();
    }

    return res.status(403).json({ message: 'Forbidden' });
  };
}
