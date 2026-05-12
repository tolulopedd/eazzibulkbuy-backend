import { prisma } from '../config/prisma.js';
import { z } from 'zod';
import { sanitizeEmail, sanitizeText } from '../utils/sanitize.js';
import { sendBuyerWelcomeEmail } from '../services/emailService.js';

const saveCustomerSchema = z.object({
  title: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.enum(['Mr', 'Mrs', 'Miss']).optional()),
  firstName: z.preprocess((value) => sanitizeText(value), z.string().min(2).max(80)),
  lastName: z.preprocess((value) => sanitizeText(value), z.string().min(2).max(80)),
  email: z.preprocess((value) => sanitizeEmail(value), z.string().email()),
  phone: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.string().min(7).max(30).optional()),
  address: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.string().min(5).max(250).optional()),
  city: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.string().min(2).max(120).optional()),
  province: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.string().min(2).max(120).optional()),
  postalCode: z.preprocess((value) => (value === undefined ? undefined : sanitizeText(value)), z.string().min(3).max(20).optional()),
});

export async function searchCustomersHandler(req, res, next) {
  try {
    const q = sanitizeText(req.query.q || '');

    if (q.length < 2) {
      return res.json([]);
    }

    const users = await prisma.user.findMany({
      where: {
        role: 'USER',
        isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
        ],
      },
      take: 10,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        address: true,
        city: true,
        province: true,
        postalCode: true,
      },
    });

    return res.json(
      users.map((user) => ({
        id: user.id,
        fullName: user.name,
        title: user.title,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        address: user.address,
        city: user.city,
        province: user.province,
        postalCode: user.postalCode,
      }))
    );
  } catch (error) {
    next(error);
  }
}

export async function saveCustomerDetailsHandler(req, res, next) {
  try {
    const payload = saveCustomerSchema.parse(req.body);
    const fullName = [payload.firstName, payload.lastName].filter(Boolean).join(' ');

    const existingUser = await prisma.user.findUnique({
      where: { email: payload.email },
      select: {
        id: true,
        name: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        address: true,
        city: true,
        province: true,
        postalCode: true,
      },
    });

    const user = existingUser
      ? await prisma.user.update({
          where: { email: payload.email },
          data: {
            phone: payload.phone ?? null,
            address: payload.address ?? null,
            city: payload.city ?? null,
            province: payload.province ?? null,
            postalCode: payload.postalCode ?? null,
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            title: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            province: true,
            postalCode: true,
          },
        })
      : await prisma.user.create({
          data: {
            name: fullName,
            title: payload.title,
            firstName: payload.firstName,
            lastName: payload.lastName,
            email: payload.email,
            role: 'USER',
            phone: payload.phone,
            address: payload.address,
            city: payload.city,
            province: payload.province,
            postalCode: payload.postalCode,
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            title: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            province: true,
            postalCode: true,
          },
        });

    let welcomeEmailSent = false;
    if (!existingUser) {
      try {
        await sendBuyerWelcomeEmail({
          email: user.email,
          buyerName: user.name,
        });
        welcomeEmailSent = true;
      } catch (error) {
        console.error('Failed to send buyer welcome email', {
          email: user.email,
          error: error?.message,
        });
      }
    }

    return res.status(201).json({
      ok: true,
      message: existingUser
        ? 'Buyer details updated.'
        : welcomeEmailSent
        ? 'Buyer details saved. Welcome email sent.'
        : 'Buyer details saved.',
      customer: {
        id: user.id,
        fullName: user.name,
        title: user.title,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        address: user.address,
        city: user.city,
        province: user.province,
        postalCode: user.postalCode,
      },
    });
  } catch (error) {
    next(error);
  }
}
