import { prisma } from '../config/prisma.js';

export const DEFAULT_PICKUP_LOCATIONS = [
  { name: 'Sage Creek', sortOrder: 1 },
  { name: 'St. Vital - Dakota Street (4mins from St Vital)', sortOrder: 2 },
  { name: 'East Kildonan - Munroe Ave (near Concordia) (3mins from Sobeys Reenders Dr)', sortOrder: 3 },
];

export async function listActivePickupLocations() {
  return prisma.pickupLocation.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export async function listAllPickupLocations() {
  return prisma.pickupLocation.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

export async function getActivePickupLocationNames() {
  const locations = await listActivePickupLocations();
  return locations.map((location) => location.name);
}

export async function hasActivePickupLocation(name) {
  if (!name) {
    return false;
  }

  const existing = await prisma.pickupLocation.findFirst({
    where: {
      name,
      isActive: true,
    },
    select: { id: true },
  });

  return Boolean(existing);
}
