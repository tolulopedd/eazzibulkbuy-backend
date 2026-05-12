import { prisma } from '../config/prisma.js';

export async function listActiveGroupBuysHandler(_req, res, next) {
  try {
    const groupBuys = await prisma.groupBuy.findMany({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json(groupBuys);
  } catch (error) {
    next(error);
  }
}
