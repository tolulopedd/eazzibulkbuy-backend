import { prisma } from '../config/prisma.js';
import { DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME } from '../constants/systemSalesItems.js';

export async function getSalesItemByIdHandler(req, res, next) {
  try {
    const { salesItemId } = req.params;
    const salesItem = await prisma.salesItem.findUnique({ where: { id: salesItemId } });

    if (!salesItem) {
      return res.status(404).json({ message: 'Sales item not found' });
    }

    return res.json(salesItem);
  } catch (error) {
    next(error);
  }
}

export async function listActiveSalesItemsHandler(_req, res, next) {
  try {
    const now = new Date();
    const items = await prisma.salesItem.findMany({
      where: {
        name: { not: DISCOUNT_ORDER_SYSTEM_SALES_ITEM_NAME },
        status: 'ACTIVE',
        closingDate: { gt: now },
      },
      orderBy: { closingDate: 'asc' },
    });

    return res.json(items);
  } catch (error) {
    next(error);
  }
}
