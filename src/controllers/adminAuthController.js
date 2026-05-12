import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { createAdminSessionToken, adminSessionMaxAgeMs } from '../utils/adminSession.js';
import { getSecureCookieOptions } from '../utils/cookieOptions.js';
import { sanitizeEmail } from '../utils/sanitize.js';
import { hashInviteToken } from '../utils/inviteToken.js';
import { buildResetExpiry, createResetToken, hashResetToken } from '../utils/resetToken.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { sendAdminPasswordResetEmail } from '../services/emailService.js';

const loginSchema = z.object({
  email: z.string().email().transform((value) => sanitizeEmail(value)),
  password: z.string().min(1),
});

const acceptInviteSchema = z.object({
  token: z.string().min(10).max(255),
  password: z.string().min(8).max(128),
});

const forgotPasswordSchema = z.object({
  email: z.string().email().transform((value) => sanitizeEmail(value)),
});

const resetPasswordSchema = z.object({
  token: z.string().min(10).max(255),
  password: z.string().min(8).max(128),
});

export async function adminLoginHandler(req, res, next) {
  try {
    const payload = loginSchema.parse(req.body);
    const isSuperAdminPrimary =
      payload.email === sanitizeEmail(env.superAdminEmail) &&
      payload.password === env.superAdminPassword;
    const isSuperAdminLegacy =
      payload.email === sanitizeEmail(env.legacyAdminEmail) &&
      payload.password === env.legacyAdminPassword;

    if (isSuperAdminPrimary || isSuperAdminLegacy) {
      const token = createAdminSessionToken({
        email: payload.email,
        role: 'SUPERADMIN',
        isSuperAdmin: true,
      });
      res.cookie('admin_session', token, getSecureCookieOptions(adminSessionMaxAgeMs));
      return res.json({
        ok: true,
        email: payload.email,
        role: 'SUPERADMIN',
        isSuperAdmin: true,
      });
    }

    const account = await prisma.user.findUnique({
      where: { email: payload.email },
    });

    if (!account || !account.isActive || !['ADMIN', 'PARTNER'].includes(account.role)) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!account.passwordHash) {
      return res.status(403).json({ message: 'Account setup pending. Accept your invite first.' });
    }

    const isMatch = await verifyPassword(payload.password, account.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    await prisma.user.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date() },
    });

    const token = createAdminSessionToken({
      email: payload.email,
      userId: account.id,
      role: account.role,
      isSuperAdmin: false,
    });
    res.cookie('admin_session', token, getSecureCookieOptions(adminSessionMaxAgeMs));
    return res.json({
      ok: true,
      email: payload.email,
      role: account.role,
      isSuperAdmin: false,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminLogoutHandler(_req, res) {
  res.clearCookie('admin_session', getSecureCookieOptions(0));
  return res.json({ ok: true });
}

export async function adminMeHandler(req, res) {
  return res.json({
    authenticated: true,
    email: req.admin.email,
    userId: req.admin.userId,
    role: req.admin.role,
    isSuperAdmin: req.admin.isSuperAdmin,
  });
}

export async function acceptInviteHandler(req, res, next) {
  try {
    const payload = acceptInviteSchema.parse(req.body);
    const now = new Date();
    const tokenHash = hashInviteToken(payload.token);

    const user = await prisma.user.findFirst({
      where: {
        inviteTokenHash: tokenHash,
        inviteTokenExpiresAt: { gt: now },
      },
    });

    if (!user) {
      return res.status(400).json({ message: 'Invite token is invalid or expired.' });
    }

    const passwordHash = await hashPassword(payload.password);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        inviteTokenHash: null,
        inviteTokenExpiresAt: null,
      },
    });

    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

export async function forgotPasswordHandler(req, res, next) {
  try {
    const payload = forgotPasswordSchema.parse(req.body);
    const genericResponse = {
      ok: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
    };

    const user = await prisma.user.findFirst({
      where: {
        email: payload.email,
        isActive: true,
        role: { in: ['ADMIN', 'PARTNER'] },
      },
    });

    if (!user) {
      return res.json(genericResponse);
    }

    const resetToken = createResetToken();
    const resetTokenHash = hashResetToken(resetToken);
    const resetTokenExpiresAt = buildResetExpiry(60);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: resetTokenHash,
        passwordResetTokenExpiresAt: resetTokenExpiresAt,
      },
    });

    const resetUrl = `${env.frontendUrl.replace(/\/$/, '')}/admin/reset-password?token=${encodeURIComponent(resetToken)}`;

    await sendAdminPasswordResetEmail({
      email: user.email,
      fullName: user.name,
      resetUrl,
      expiresAt: resetTokenExpiresAt,
    });

    return res.json(genericResponse);
  } catch (error) {
    next(error);
  }
}

export async function resetPasswordHandler(req, res, next) {
  try {
    const payload = resetPasswordSchema.parse(req.body);
    const now = new Date();
    const tokenHash = hashResetToken(payload.token);

    const user = await prisma.user.findFirst({
      where: {
        passwordResetTokenHash: tokenHash,
        passwordResetTokenExpiresAt: { gt: now },
        isActive: true,
        role: { in: ['ADMIN', 'PARTNER'] },
      },
    });

    if (!user) {
      return res.status(400).json({ message: 'Reset token is invalid or expired.' });
    }

    const passwordHash = await hashPassword(payload.password);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      },
    });

    return res.json({ ok: true, message: 'Password updated successfully. You can now sign in.' });
  } catch (error) {
    next(error);
  }
}
