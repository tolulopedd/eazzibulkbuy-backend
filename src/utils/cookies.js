export function readCookie(req, key) {
  const header = req.headers.cookie;
  if (!header) {
    return null;
  }

  const pairs = header.split(';');
  for (const pair of pairs) {
    const [rawKey, ...rawValue] = pair.trim().split('=');
    if (rawKey === key) {
      return decodeURIComponent(rawValue.join('='));
    }
  }

  return null;
}
