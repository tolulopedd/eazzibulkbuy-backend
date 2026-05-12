export function stripeWebhookGuard(req, res, next) {
  const signature = req.headers['stripe-signature'];
  const contentType = req.headers['content-type'] || '';

  if (!signature) {
    return res.status(400).send('Missing stripe-signature header');
  }

  if (!String(contentType).includes('application/json')) {
    return res.status(415).send('Unsupported content type');
  }

  return next();
}
