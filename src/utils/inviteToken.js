import crypto from 'crypto';

export function createInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function buildInviteExpiry(days = 7) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt;
}
