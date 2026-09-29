export function sanitizeText(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '');
}

export function sanitizeEmail(value) {
  return sanitizeText(value).toLowerCase();
}

export function standardizeName(value) {
  return sanitizeText(value)
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-CA')
    .replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, prefix, letter) => `${prefix}${letter.toLocaleUpperCase('en-CA')}`);
}

export function standardizeAddress(value) {
  return standardizeName(value);
}
