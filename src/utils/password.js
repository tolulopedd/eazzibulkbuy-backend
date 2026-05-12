import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') {
    return false;
  }

  const [method, salt, hashHex] = storedHash.split(':');
  if (method !== 'scrypt' || !salt || !hashHex) {
    return false;
  }

  const derived = await scryptAsync(password, salt, 64);
  const stored = Buffer.from(hashHex, 'hex');
  const candidate = Buffer.from(derived);

  if (stored.length !== candidate.length) {
    return false;
  }

  return crypto.timingSafeEqual(stored, candidate);
}
