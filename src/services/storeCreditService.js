import { prisma } from '../config/prisma.js';

function getClient(client) {
  return client || prisma;
}

export async function getStoreCreditBalanceForUser(userId, client) {
  if (!userId) {
    return 0;
  }

  const db = getClient(client);
  const aggregate = await db.storeCreditLedger.aggregate({
    where: { userId },
    _sum: { amount: true },
  });

  return Math.max(0, aggregate._sum.amount || 0);
}

export async function useStoreCredit({
  userId,
  orderId,
  amount,
  note,
  client,
}) {
  const creditAmount = Math.max(0, Number(amount) || 0);
  if (creditAmount === 0) {
    return 0;
  }

  const db = getClient(client);
  const balance = await getStoreCreditBalanceForUser(userId, db);
  if (creditAmount > balance) {
    throw new Error(`Store credit exceeds available balance of CAD ${(balance / 100).toFixed(2)}.`);
  }

  await db.storeCreditLedger.create({
    data: {
      userId,
      orderId,
      amount: -creditAmount,
      type: 'CREDIT_USED',
      note: note || null,
    },
  });

  return creditAmount;
}

export async function issueStoreCredit({
  userId,
  sourceOrderId,
  amount,
  note,
  createdByUserId,
  client,
}) {
  const creditAmount = Math.max(0, Number(amount) || 0);
  if (creditAmount === 0) {
    return null;
  }

  const db = getClient(client);
  return db.storeCreditLedger.create({
    data: {
      userId,
      sourceOrderId,
      amount: creditAmount,
      type: 'CREDIT_ISSUED',
      note: note || null,
      createdByUserId: createdByUserId || null,
    },
  });
}
