import { allowedFrontendOrigins, env } from '../config/env.js';

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function getRequestOrigin(req) {
  const origin = normalizeOrigin(req.headers.origin);
  if (origin) {
    return origin;
  }

  const referer = String(req.headers.referer || '').trim();
  if (!referer) {
    return '';
  }

  try {
    return normalizeOrigin(new URL(referer).origin);
  } catch {
    return '';
  }
}

const trustedOrigins = allowedFrontendOrigins
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

export function applySecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

  if (env.nodeEnv === 'production') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  }

  next();
}

export function requireTrustedOrigin(req, res, next) {
  const requestOrigin = getRequestOrigin(req);

  if (requestOrigin && trustedOrigins.includes(requestOrigin)) {
    return next();
  }

  return res.status(403).json({
    message: 'Request origin is not allowed.',
  });
}
