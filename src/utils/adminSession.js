import crypto from 'crypto';
import { env } from '../config/env.js';

const SESSION_TTL_SECONDS = 60 * 60 * 12;

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', env.adminSessionSecret).update(payload).digest('base64url');
}

export function createAdminSessionToken({ email, userId = null, role = 'ADMIN', isSuperAdmin = false }) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = base64Url(JSON.stringify({ email, userId, role, isSuperAdmin, exp }));
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export function verifyAdminSessionToken(token) {
  if (!token || !token.includes('.')) {
    return null;
  }

  const [payload, signature] = token.split('.');
  const expected = sign(payload);

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.email || !data?.exp) {
      return null;
    }

    if (Math.floor(Date.now() / 1000) > data.exp) {
      return null;
    }

    return {
      email: data.email,
      exp: data.exp,
      userId: data.userId || null,
      role: data.role || 'ADMIN',
      isSuperAdmin: Boolean(data.isSuperAdmin),
    };
  } catch {
    return null;
  }
}

export const adminSessionMaxAgeMs = SESSION_TTL_SECONDS * 1000;
