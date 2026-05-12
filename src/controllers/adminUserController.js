import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { sanitizeEmail, sanitizeText } from '../utils/sanitize.js';
import { buildInviteExpiry, createInviteToken, hashInviteToken } from '../utils/inviteToken.js';
import { hashPassword } from '../utils/password.js';
import { sendUserInviteEmail } from '../services/emailService.js';

const userRoleSchema = z.enum(['ADMIN', 'PARTNER', 'USER']);

const listUsersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  role: userRoleSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  sortBy: z.enum(['createdAt', 'lastLoginAt', 'name', 'email', 'role']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createUserSchema = z.object({
  name: z.preprocess((value) => sanitizeText(value), z.string().min(2).max(120)),
  email: z.preprocess((value) => sanitizeEmail(value), z.string().email()),
  role: userRoleSchema,
  password: z.string().min(8).max(128).optional(),
  phone: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.string().min(7).max(30).optional()),
  address: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.string().min(5).max(250).optional()),
  isActive: z.boolean().default(true),
});

const inviteUserSchema = z.object({
  name: z.preprocess((value) => sanitizeText(value), z.string().min(2).max(120)),
  email: z.preprocess((value) => sanitizeEmail(value), z.string().email()),
  role: userRoleSchema,
  phone: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.string().min(7).max(30).optional()),
  address: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.string().min(5).max(250).optional()),
  sendEmail: z.boolean().default(true),
});

function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone,
    address: user.address,
    isActive: user.isActive,
    invitedAt: user.invitedAt,
    invitedByUserId: user.invitedByUserId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function listUsersHandler(req, res, next) {
  try {
    const query = listUsersQuerySchema.parse(req.query);

    const where = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
              { phone: { contains: query.q } },
            ],
          }
        : {}),
    };

    const skip = (query.page - 1) * query.limit;
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip,
        take: query.limit,
      }),
      prisma.user.count({ where }),
    ]);

    return res.json({
      items: users.map(serializeUser),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    });
  } catch (error) {
    next(error);
  }
}

export async function createUserHandler(req, res, next) {
  try {
    const payload = createUserSchema.parse(req.body);

    if ((payload.role === 'ADMIN' || payload.role === 'PARTNER') && !payload.password) {
      return res.status(400).json({ message: 'Password is required for ADMIN and PARTNER accounts.' });
    }

    const existing = await prisma.user.findUnique({ where: { email: payload.email } });
    if (existing) {
      return res.status(409).json({ message: 'A user with this email already exists.' });
    }

    const passwordHash = payload.password ? await hashPassword(payload.password) : null;

    const user = await prisma.user.create({
      data: {
        name: payload.name,
        email: payload.email,
        role: payload.role,
        passwordHash,
        phone: payload.phone,
        address: payload.address,
        isActive: payload.isActive,
      },
    });

    return res.status(201).json(serializeUser(user));
  } catch (error) {
    next(error);
  }
}

export async function inviteUserHandler(req, res, next) {
  try {
    const payload = inviteUserSchema.parse(req.body);
    const inviteToken = createInviteToken();
    const inviteTokenHash = hashInviteToken(inviteToken);
    const inviteTokenExpiresAt = buildInviteExpiry(7);
    const invitedAt = new Date();

    const user = await prisma.user.upsert({
      where: { email: payload.email },
      create: {
        name: payload.name,
        email: payload.email,
        role: payload.role,
        phone: payload.phone,
        address: payload.address,
        invitedAt,
        invitedByUserId: req.admin.userId,
        inviteTokenHash,
        inviteTokenExpiresAt,
        passwordHash: null,
        isActive: true,
      },
      update: {
        name: payload.name,
        role: payload.role,
        phone: payload.phone,
        address: payload.address,
        invitedAt,
        invitedByUserId: req.admin.userId,
        inviteTokenHash,
        inviteTokenExpiresAt,
        passwordHash: null,
        isActive: true,
      },
    });

    const inviteUrl = `${env.frontendUrl.replace(/\/$/, '')}/admin/invite?token=${encodeURIComponent(inviteToken)}`;

    if (payload.sendEmail) {
      await sendUserInviteEmail({
        email: user.email,
        fullName: user.name,
        role: user.role,
        inviteUrl,
        expiresAt: inviteTokenExpiresAt,
      });
    }

    return res.status(201).json({
      user: serializeUser(user),
      inviteUrl,
      inviteExpiresAt: inviteTokenExpiresAt,
      ...(env.nodeEnv === 'development' ? { inviteToken } : {}),
    });
  } catch (error) {
    next(error);
  }
}
