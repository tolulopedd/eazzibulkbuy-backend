import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import {
  DEFAULT_PICKUP_LOCATIONS,
  getActivePickupLocationNames,
  listActivePickupLocations,
  listAllPickupLocations,
} from '../services/pickupLocationService.js';

const pickupLocationPayloadSchema = z.object({
  name: z.string().trim().min(2).max(180),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const pickupLocationUpdateSchema = z.object({
  name: z.string().trim().min(2).max(180).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
}).refine((payload) => Object.keys(payload).length > 0, {
  message: 'No changes provided.',
});

const pickupLocationIdSchema = z.string().uuid();

function normalizePickupLocationName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function findDuplicatePickupLocation(name, excludeId = '') {
  const existing = await prisma.pickupLocation.findFirst({
    where: {
      name,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });

  return existing;
}

export async function listPublicPickupLocationsHandler(_req, res, next) {
  try {
    const locations = await listActivePickupLocations();
    return res.json({
      items: locations.map((location) => ({
        id: location.id,
        name: location.name,
        sortOrder: location.sortOrder,
      })),
    });
  } catch (error) {
    next(error);
  }
}

export async function listAdminPickupLocationsHandler(_req, res, next) {
  try {
    const [locations, activeNames] = await Promise.all([
      listAllPickupLocations(),
      getActivePickupLocationNames(),
    ]);

    return res.json({
      items: locations,
      activeNames,
      defaults: DEFAULT_PICKUP_LOCATIONS,
    });
  } catch (error) {
    next(error);
  }
}

export async function createPickupLocationHandler(req, res, next) {
  try {
    const payload = pickupLocationPayloadSchema.parse(req.body);
    const name = normalizePickupLocationName(payload.name);
    const duplicate = await findDuplicatePickupLocation(name);

    if (duplicate) {
      return res.status(409).json({ message: 'A pickup location with this name already exists.' });
    }

    const location = await prisma.pickupLocation.create({
      data: {
        name,
        isActive: payload.isActive ?? true,
        sortOrder: payload.sortOrder ?? 0,
      },
    });

    return res.status(201).json({
      message: 'Pickup location created successfully.',
      item: location,
    });
  } catch (error) {
    next(error);
  }
}

export async function updatePickupLocationHandler(req, res, next) {
  try {
    const pickupLocationId = pickupLocationIdSchema.parse(req.params.pickupLocationId);
    const payload = pickupLocationUpdateSchema.parse(req.body);
    const existing = await prisma.pickupLocation.findUnique({
      where: { id: pickupLocationId },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Pickup location not found.' });
    }

    const name = payload.name ? normalizePickupLocationName(payload.name) : existing.name;

    if (name !== existing.name) {
      const duplicate = await findDuplicatePickupLocation(name, pickupLocationId);
      if (duplicate) {
        return res.status(409).json({ message: 'A pickup location with this name already exists.' });
      }
    }

    const location = await prisma.pickupLocation.update({
      where: { id: pickupLocationId },
      data: {
        ...(payload.name !== undefined ? { name } : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
        ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
      },
    });

    return res.json({
      message: 'Pickup location updated successfully.',
      item: location,
    });
  } catch (error) {
    next(error);
  }
}

export async function deletePickupLocationHandler(req, res, next) {
  try {
    const pickupLocationId = pickupLocationIdSchema.parse(req.params.pickupLocationId);
    const existing = await prisma.pickupLocation.findUnique({
      where: { id: pickupLocationId },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Pickup location not found.' });
    }

    await prisma.pickupLocation.delete({
      where: { id: pickupLocationId },
    });

    return res.json({ message: 'Pickup location deleted successfully.' });
  } catch (error) {
    next(error);
  }
}
