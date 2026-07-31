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

const customerUpdateRequestSchema = z.object({
  customerId: z.preprocess((value) => sanitizeText(value), z.string().uuid()),
  phone: z.preprocess((value) => sanitizeText(value), z.string().min(7).max(30)),
  address: z.preprocess((value) => sanitizeText(value), z.string().min(5).max(250)),
  city: z.preprocess((value) => sanitizeText(value), z.string().min(2).max(120)),
  province: z.preprocess((value) => sanitizeText(value), z.string().min(2).max(120)),
  postalCode: z.preprocess((value) => sanitizeText(value), z.string().min(3).max(20)),
});

export async function searchCustomersHandler(req, res, next) {
  try {
    const q = sanitizeText(req.query.q || '');

    if (q.length < 4) {
      return res.json([]);
    }

    const normalizedQuery = q.trim();
    const compactDigits = normalizedQuery.replace(/\D/g, '');
    const isEmailSearch = normalizedQuery.includes('@');
    const isPhoneSearch = compactDigits.length >= 7;

    if (!isEmailSearch && !isPhoneSearch) {
      return res.json([]);
    }

    const users = await prisma.user.findMany({
      where: {
        role: 'USER',
        isActive: true,
        ...(isEmailSearch
          ? { email: { contains: normalizedQuery, mode: 'insensitive' } }
          : { phone: { contains: compactDigits } }),
      },
      take: 10,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
      },
    });

    return res.json(
      users.map((user) => ({
        id: user.id,
        fullName: user.name,
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
      select: { id: true, email: true },
    });

    if (existingUser) {
      return res.status(409).json({
        message: 'A buyer with this email already exists. Please use Returning Buyer.',
      });
    }

    const user = await prisma.user.create({
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

    return res.status(201).json({
      ok: true,
      message: welcomeEmailSent
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

export async function createCustomerUpdateRequestHandler(req, res, next) {
  try {
    const payload = customerUpdateRequestSchema.parse({
      ...req.body,
      customerId: req.params.customerId,
    });

    const existingCustomer = await prisma.user.findUnique({
      where: { id: payload.customerId },
      select: {
        id: true,
        role: true,
        name: true,
      },
    });

    if (!existingCustomer || existingCustomer.role !== 'USER') {
      return res.status(404).json({ message: 'Buyer not found.' });
    }

    const existingPendingRequest = await prisma.customerUpdateRequest.findFirst({
      where: {
        userId: payload.customerId,
        status: 'PENDING',
      },
      select: { id: true },
    });

    if (existingPendingRequest) {
      return res.status(409).json({
        message: 'An update request is already pending for this buyer.',
      });
    }

    const request = await prisma.customerUpdateRequest.create({
      data: {
        userId: payload.customerId,
        phone: payload.phone,
        address: payload.address,
        city: payload.city,
        province: payload.province,
        postalCode: payload.postalCode,
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    });

    return res.status(201).json({
      ok: true,
      message: 'Update request sent to admin for approval.',
      request,
    });
  } catch (error) {
    next(error);
  }
}
