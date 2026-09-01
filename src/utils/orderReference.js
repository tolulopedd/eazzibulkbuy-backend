import { getCentralDateParts } from './centralTime.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normalizeDate(dateValue) {
  const parsedDate = dateValue ? new Date(dateValue) : new Date();
  return Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
}

export function formatDisplayOrderReference({ createdAt, batchNumber, orderSequence }) {
  const safeDate = normalizeDate(createdAt);
  const centralDate = getCentralDateParts(safeDate);
  const day = String(centralDate.day).padStart(2, '0');
  const month = MONTHS[centralDate.month - 1];
  const safeBatchNumber = String(batchNumber || '').trim().toUpperCase();
  const safeSequence = String(Math.max(1, Number(orderSequence) || 1)).padStart(4, '0');

  if (!safeBatchNumber) {
    return `${day}${month}-${safeSequence}`;
  }

  return `${day}${month}-${safeBatchNumber}-${safeSequence}`;
}

export function getDisplayOrderReference(order = {}, overrides = {}) {
  const persisted = overrides.displayOrderReference ?? order?.displayOrderReference;
  if (String(persisted || '').trim()) {
    return String(persisted).trim();
  }

  return formatDisplayOrderReference({
    createdAt: overrides.createdAt ?? order?.createdAt,
    batchNumber: overrides.batchNumber ?? order?.batchNumber ?? order?.salesItem?.batchNumber,
    orderSequence: overrides.orderSequence ?? order?.orderSequence,
  });
}
