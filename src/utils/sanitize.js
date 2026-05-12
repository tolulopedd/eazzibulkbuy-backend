export function sanitizeText(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '');
}

export function sanitizeEmail(value) {
  return sanitizeText(value).toLowerCase();
}
