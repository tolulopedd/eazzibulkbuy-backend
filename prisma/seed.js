import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const closingDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const defaults = [
    {
      title: 'Bulk Rice 5kg',
      description: 'Community rice bulk order',
      unitPrice: 1899,
      currency: 'CAD',
    },
    {
      title: 'Cooking Oil 3L',
      description: 'Sunflower oil group buy',
      unitPrice: 1299,
      currency: 'CAD',
    },
  ];

  for (const item of defaults) {
    await prisma.groupBuy.upsert({
      where: { id: `${item.title.toLowerCase().replace(/\s+/g, '-')}` },
      update: item,
      create: {
        id: `${item.title.toLowerCase().replace(/\s+/g, '-')}`,
        ...item,
      },
    });
  }

  const salesDefaults = [
    {
      name: 'Bulk Rice February Campaign',
      description: 'Limited community sale item',
      pickupInstructions: 'Pickup at 25 King St W, Toronto, Saturdays 10am-2pm. Bring order reference and ID.',
      pricePerUnit: 1899,
      currency: 'CAD',
      status: 'ACTIVE',
      closingDate,
    },
    {
      name: 'Cooking Oil Spring Campaign',
      description: 'Discounted community sale item',
      pickupInstructions: 'Pickup window will be emailed within 48 hours after confirmation.',
      pricePerUnit: 1299,
      currency: 'CAD',
      status: 'ACTIVE',
      closingDate,
    },
  ];

  for (const item of salesDefaults) {
    const existing = await prisma.salesItem.findFirst({ where: { name: item.name } });
    if (existing) {
      await prisma.salesItem.update({
        where: { id: existing.id },
        data: item,
      });
    } else {
      await prisma.salesItem.create({ data: item });
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
