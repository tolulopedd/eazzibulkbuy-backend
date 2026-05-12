import crypto from 'crypto';

export function createResetToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function buildResetExpiry(minutes = 60) {
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + minutes);
  return expiresAt;
}
