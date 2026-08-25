import { prisma } from '../config/prisma.js';

export const DEFAULT_PRODUCE_ITEMS = [
  { name: 'Tomatoes', imageUrl: '/images/products/tomatoes-box.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?tomatoes,crate', sortOrder: 1 },
  { name: 'Red Habanero', imageUrl: '/images/products/habanero-box.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?habanero,pepper,box', sortOrder: 2 },
  { name: 'Orange Habanero Pepper', imageUrl: '/images/products/orange-habanero-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?orange-habanero,pepper,box', sortOrder: 3 },
  { name: 'Brown Habanero Pepper', imageUrl: '/images/products/brown-habanero-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?brown-habanero,pepper,box', sortOrder: 4 },
  { name: 'Scorpion Pepper', imageUrl: '/images/products/scorpion-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?scorpion-pepper,pepper,box', sortOrder: 5 },
  { name: 'Armageddon Pepper', imageUrl: '/images/products/armageddon-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?armageddon-pepper,pepper,box', sortOrder: 6 },
  { name: 'Carolina Reaper Pepper', imageUrl: '/images/products/carolina-reaper-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?carolina-reaper,pepper,box', sortOrder: 7 },
  { name: 'Ghost Pepper', imageUrl: '/images/products/ghost-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?ghost-pepper,pepper,box', sortOrder: 8 },
  { name: 'Cayenne Pepper', imageUrl: '/images/products/cayenne-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?cayenne-pepper,red-pepper,box', sortOrder: 9 },
  { name: 'Crimson Pepper', imageUrl: '/images/products/crimson-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?crimson-pepper,red-pepper,box', sortOrder: 10 },
  { name: 'Shepherd Pepper', imageUrl: '/images/products/shepherd-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?shepherd-pepper,red-pepper,box', sortOrder: 11 },
  { name: 'Red Bell Pepper', imageUrl: '/images/products/red-bell-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?red-bell-pepper,vegetable,box', sortOrder: 12 },
  { name: 'Green Bell Pepper', imageUrl: '/images/products/green-bell-pepper.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?green-bell-pepper,vegetable,box', sortOrder: 13 },
  { name: 'Green Habanero Pepper', imageUrl: '/images/products/green-pepper-box.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?green-pepper,vegetable,box', sortOrder: 14 },
  { name: 'Yam', imageUrl: '/images/products/yam-box.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?yam,tuber,box', sortOrder: 15 },
  { name: 'Sweet Potatoes', imageUrl: '/images/products/caribbean-sweet-potatoes.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?sweet-potatoes,box,produce', sortOrder: 16 },
  { name: 'Red Onions', imageUrl: '/images/products/red-onions.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?red-onions,produce,bag', sortOrder: 17 },
  { name: 'Yellow Onions', imageUrl: '/images/products/yellow-onions.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?yellow-onions,produce,basket', sortOrder: 18 },
  { name: 'Plantain', imageUrl: '/images/products/plantain.jpg', fallbackUrl: 'https://source.unsplash.com/1200x800/?plantain,box,produce', sortOrder: 19 },
];

export async function listActiveProduceItems() {
  return prisma.produceItem.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export async function listAllProduceItems() {
  return prisma.produceItem.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}
