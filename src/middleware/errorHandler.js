export function notFoundHandler(_req, res) {
  res.status(404).json({ message: 'Route not found' });
}

export function errorHandler(error, _req, res, _next) {
  const status = error.status || 400;
  const firstIssue = Array.isArray(error?.issues) ? error.issues[0] : null;
  const issueField = firstIssue?.path?.length ? firstIssue.path.join('.') : 'Request';
  const message = firstIssue
    ? `${issueField}: ${firstIssue.message}`
    : error.message || 'Request failed';

  res.status(status).json({
    message,
    details: error?.issues || undefined,
  });
}
