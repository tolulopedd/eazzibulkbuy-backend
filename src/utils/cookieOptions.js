import { env } from '../config/env.js';

export function getSecureCookieOptions(maxAgeMs) {
  const isProduction = env.nodeEnv !== 'development';

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: maxAgeMs,
    path: '/',
  };
}
