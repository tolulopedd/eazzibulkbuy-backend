export function notFoundHandler(_req, res) {
  res.status(404).json({ message: 'Route not found' });
}

export function errorHandler(error, _req, res, _next) {
  const status = error.status || 400;
  const message = error?.issues ? 'Validation failed' : error.message || 'Request failed';

  res.status(status).json({
    message,
    details: error?.issues || undefined,
  });
}
