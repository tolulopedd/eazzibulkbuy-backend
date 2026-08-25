import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { DEFAULT_PRODUCE_ITEMS, listActiveProduceItems, listAllProduceItems } from '../services/produceItemService.js';
import { isS3Configured } from '../config/env.js';
import {
  createProduceImageUploadTarget,
  getS3Object,
  isValidProduceImageObjectKey,
  uploadProduceImageObject,
} from '../services/storageService.js';

const produceItemPayloadSchema = z.object({
  name: z.string().trim().min(2).max(120),
  imageUrl: z.string().trim().min(2).max(500),
  fallbackUrl: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const produceItemUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  imageUrl: z.string().trim().min(2).max(500).optional(),
  fallbackUrl: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
}).refine((payload) => Object.keys(payload).length > 0, {
  message: 'No changes provided.',
});

const produceItemIdSchema = z.string().uuid();
const MAX_PRODUCE_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

const produceImageUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(160),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().min(1).max(MAX_PRODUCE_IMAGE_SIZE_BYTES),
});

const produceImageDirectUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(160),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.coerce.number().int().min(1).max(MAX_PRODUCE_IMAGE_SIZE_BYTES),
});

function normalizeProduceName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeUrlValue(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function base64UrlEncode(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function getRequestBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function buildProduceImageUrl(req, objectKey) {
  return `${getRequestBaseUrl(req)}/api/produce-items/images/${base64UrlEncode(objectKey)}`;
}

function extractS3ObjectKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('s3://')) {
    const withoutProtocol = raw.slice('s3://'.length);
    const slashIndex = withoutProtocol.indexOf('/');
    return slashIndex >= 0 ? withoutProtocol.slice(slashIndex + 1) : '';
  }
  if (isValidProduceImageObjectKey(raw)) return raw;

  try {
    const url = new URL(raw);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    return isValidProduceImageObjectKey(key) ? key : '';
  } catch {
    return '';
  }
}

function resolveProduceImageUrl(req, imageUrl) {
  const objectKey = extractS3ObjectKey(imageUrl);
  if (objectKey) {
    return buildProduceImageUrl(req, objectKey);
  }
  return imageUrl || '';
}

async function findDuplicateProduceItem(name, excludeId = '') {
  return prisma.produceItem.findFirst({
    where: {
      name,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
}

function toPublicItem(req, item) {
  return {
    id: item.id,
    name: item.name,
    image: resolveProduceImageUrl(req, item.imageUrl),
    fallback: resolveProduceImageUrl(req, item.fallbackUrl),
    sortOrder: item.sortOrder,
  };
}

function toAdminItem(req, item) {
  return {
    ...item,
    imageUrl: resolveProduceImageUrl(req, item.imageUrl),
    fallbackUrl: resolveProduceImageUrl(req, item.fallbackUrl),
  };
}

export async function listPublicProduceItemsHandler(req, res, next) {
  try {
    const items = await listActiveProduceItems();
    return res.json({ items: items.map((item) => toPublicItem(req, item)) });
  } catch (error) {
    next(error);
  }
}

export async function listAdminProduceItemsHandler(req, res, next) {
  try {
    const items = await listAllProduceItems();
    return res.json({
      items: items.map((item) => toAdminItem(req, item)),
      activeNames: items.filter((item) => item.isActive).map((item) => item.name),
      defaults: DEFAULT_PRODUCE_ITEMS,
    });
  } catch (error) {
    next(error);
  }
}

export async function createProduceItemHandler(req, res, next) {
  try {
    const payload = produceItemPayloadSchema.parse(req.body);
    const name = normalizeProduceName(payload.name);
    const duplicate = await findDuplicateProduceItem(name);

    if (duplicate) {
      return res.status(409).json({ message: 'A produce item with this name already exists.' });
    }

    const item = await prisma.produceItem.create({
      data: {
        name,
        imageUrl: normalizeUrlValue(payload.imageUrl),
        fallbackUrl: normalizeUrlValue(payload.fallbackUrl),
        isActive: payload.isActive ?? true,
        sortOrder: payload.sortOrder ?? 0,
      },
    });

    return res.status(201).json({ message: 'Produce item created successfully.', item });
  } catch (error) {
    next(error);
  }
}

export async function createProduceImageUploadHandler(req, res, next) {
  try {
    if (!isS3Configured) {
      return res.status(503).json({ message: 'S3 storage is not configured for produce image uploads.' });
    }

    const payload = produceImageUploadSchema.parse(req.body);
    const uploadTarget = await createProduceImageUploadTarget({
      fileName: payload.fileName,
      contentType: payload.contentType,
    });

    return res.status(201).json(uploadTarget);
  } catch (error) {
    next(error);
  }
}

export async function uploadProduceImageHandler(req, res, next) {
  try {
    if (!isS3Configured) {
      return res.status(503).json({ message: 'S3 storage is not configured for produce image uploads.' });
    }

    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body?.length) {
      return res.status(400).json({ message: 'Select a valid produce image before uploading.' });
    }

    const payload = produceImageDirectUploadSchema.parse({
      fileName: decodeURIComponent(String(req.get('x-file-name') || 'produce-image')),
      contentType: req.get('content-type') || '',
      sizeBytes: body.length,
    });

    const uploadTarget = await uploadProduceImageObject({
      fileName: payload.fileName,
      contentType: payload.contentType,
      body,
    });

    return res.status(201).json({
      ...uploadTarget,
      imageUrl: buildProduceImageUrl(req, uploadTarget.objectKey),
    });
  } catch (error) {
    next(error);
  }
}

export async function viewProduceImageHandler(req, res, next) {
  try {
    const objectKey = base64UrlDecode(req.params.encodedObjectKey);
    if (!isValidProduceImageObjectKey(objectKey)) {
      return res.status(404).json({ message: 'Produce image not found.' });
    }

    const object = await getS3Object(objectKey);
    if (object.ContentType) {
      res.setHeader('Content-Type', object.ContentType);
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return object.Body.pipe(res);
  } catch (error) {
    next(error);
  }
}

export async function updateProduceItemHandler(req, res, next) {
  try {
    const produceItemId = produceItemIdSchema.parse(req.params.produceItemId);
    const payload = produceItemUpdateSchema.parse(req.body);
    const existing = await prisma.produceItem.findUnique({ where: { id: produceItemId } });

    if (!existing) {
      return res.status(404).json({ message: 'Produce item not found.' });
    }

    const name = payload.name ? normalizeProduceName(payload.name) : existing.name;

    if (name !== existing.name) {
      const duplicate = await findDuplicateProduceItem(name, produceItemId);
      if (duplicate) {
        return res.status(409).json({ message: 'A produce item with this name already exists.' });
      }
    }

    const item = await prisma.produceItem.update({
      where: { id: produceItemId },
      data: {
        ...(payload.name !== undefined ? { name } : {}),
        ...(payload.imageUrl !== undefined ? { imageUrl: normalizeUrlValue(payload.imageUrl) } : {}),
        ...(payload.fallbackUrl !== undefined ? { fallbackUrl: normalizeUrlValue(payload.fallbackUrl) } : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
        ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
      },
    });

    return res.json({ message: 'Produce item updated successfully.', item });
  } catch (error) {
    next(error);
  }
}

export async function deleteProduceItemHandler(req, res, next) {
  try {
    const produceItemId = produceItemIdSchema.parse(req.params.produceItemId);
    const existing = await prisma.produceItem.findUnique({
      where: { id: produceItemId },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Produce item not found.' });
    }

    await prisma.produceItem.delete({ where: { id: produceItemId } });
    return res.json({ message: 'Produce item deleted successfully.' });
  } catch (error) {
    next(error);
  }
}
