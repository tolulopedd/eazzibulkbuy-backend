import { env } from '../config/env.js';

export function getSecureCookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: env.nodeEnv !== 'development',
    sameSite: 'strict',
    maxAge: maxAgeMs,
    path: '/',
  };
}
