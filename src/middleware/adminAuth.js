import { readCookie } from '../utils/cookies.js';
import { verifyAdminSessionToken } from '../utils/adminSession.js';
import { prisma } from '../config/prisma.js';

export async function requireAdminAuth(req, res, next) {
  try {
    const token = readCookie(req, 'admin_session');
    const session = verifyAdminSessionToken(token);

    if (!session) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!session.isSuperAdmin) {
      const account = await prisma.user.findUnique({
        where: { id: session.userId },
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
        },
      });

      if (
        !account ||
        !account.isActive ||
        !['ADMIN', 'PARTNER'].includes(account.role) ||
        account.email !== session.email
      ) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      req.admin = {
        email: account.email,
        userId: account.id,
        role: account.role,
        isSuperAdmin: false,
      };

      return next();
    }

    req.admin = {
      email: session.email,
      userId: session.userId,
      role: session.role,
      isSuperAdmin: session.isSuperAdmin,
    };
    return next();
  } catch (error) {
    return next(error);
  }
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
