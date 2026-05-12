const store = new Map();

export function createRateLimiter({ windowMs, max, keyPrefix }) {
  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = `${keyPrefix}:${req.ip}`;

    const entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ message: 'Too many requests. Try again later.' });
    }

    entry.count += 1;
    store.set(key, entry);
    return next();
  };
}
