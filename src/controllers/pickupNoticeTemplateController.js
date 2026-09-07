import { z } from 'zod';
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma.js';

const listPickupNoticeTemplatesQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ALL'),
});

const pickupNoticeTemplatePayloadSchema = z.object({
  name: z.string().trim().min(2).max(140),
  address: z.string().trim().min(3).max(255),
  readyDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeWindow: z.string().trim().min(3).max(120),
  emailSubject: z.string().trim().max(180).optional(),
  emailBody: z.string().trim().max(6000).optional(),
  instructions: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const pickupNoticeTemplateUpdateSchema = pickupNoticeTemplatePayloadSchema.partial().refine((payload) => Object.keys(payload).length > 0, {
  message: 'No changes provided.',
});

const pickupNoticeTemplateIdSchema = z.string().uuid();

function normalizeTemplateName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeInstructions(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizeOptionalText(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function mapPickupNoticeTemplateRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    address: row.address,
    readyDate: row.readyDate ?? row.ready_date,
    timeWindow: row.timeWindow ?? row.time_window,
    emailSubject: row.emailSubject ?? row.email_subject,
    emailBody: row.emailBody ?? row.email_body,
    instructions: row.instructions,
    isActive: row.isActive ?? row.is_active,
    sortOrder: row.sortOrder ?? row.sort_order,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

function hasPickupNoticeTemplateDelegate() {
  return Boolean(prisma.pickupNoticeTemplate);
}

async function findDuplicateTemplate(name, excludeId = '') {
  if (!hasPickupNoticeTemplateDelegate()) {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT "id"
      FROM "pickup_notice_templates"
      WHERE "name" = $1
        AND ($2 = '' OR "id" <> $2)
      LIMIT 1
    `, name, excludeId);
    return rows[0] || null;
  }

  return prisma.pickupNoticeTemplate.findFirst({
    where: {
      name,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
}

export async function findActivePickupNoticeTemplateById(templateId) {
  if (hasPickupNoticeTemplateDelegate()) {
    return prisma.pickupNoticeTemplate.findFirst({
      where: { id: templateId, isActive: true },
    });
  }

  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      "id",
      "name",
      "address",
      "ready_date",
      "time_window",
      "email_subject",
      "email_body",
      "instructions",
      "is_active",
      "sort_order",
      "created_at",
      "updated_at"
    FROM "pickup_notice_templates"
    WHERE "id" = $1
      AND "is_active" = true
    LIMIT 1
  `, templateId);

  return mapPickupNoticeTemplateRow(rows[0]);
}

export async function listPickupNoticeTemplatesHandler(req, res, next) {
  try {
    const query = listPickupNoticeTemplatesQuerySchema.parse(req.query);
    if (!hasPickupNoticeTemplateDelegate()) {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT
          "id",
          "name",
          "address",
          "ready_date",
          "time_window",
          "email_subject",
          "email_body",
          "instructions",
          "is_active",
          "sort_order",
          "created_at",
          "updated_at"
        FROM "pickup_notice_templates"
        WHERE ($1 = 'ALL')
          OR ($1 = 'ACTIVE' AND "is_active" = true)
          OR ($1 = 'INACTIVE' AND "is_active" = false)
        ORDER BY "sort_order" ASC, "created_at" DESC
      `, query.status);

      return res.json({ items: rows.map(mapPickupNoticeTemplateRow) });
    }

    const templates = await prisma.pickupNoticeTemplate.findMany({
      where: {
        ...(query.status === 'ACTIVE' ? { isActive: true } : {}),
        ...(query.status === 'INACTIVE' ? { isActive: false } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });

    return res.json({ items: templates });
  } catch (error) {
    next(error);
  }
}

export async function createPickupNoticeTemplateHandler(req, res, next) {
  try {
    const payload = pickupNoticeTemplatePayloadSchema.parse(req.body);
    const name = normalizeTemplateName(payload.name);
    const duplicate = await findDuplicateTemplate(name);

    if (duplicate) {
      return res.status(409).json({ message: 'A pickup notice template with this name already exists.' });
    }

    const data = {
      id: randomUUID(),
      name,
      address: payload.address.trim(),
      readyDate: payload.readyDate,
      timeWindow: payload.timeWindow.trim(),
      emailSubject: normalizeOptionalText(payload.emailSubject),
      emailBody: normalizeOptionalText(payload.emailBody),
      instructions: normalizeInstructions(payload.instructions),
      isActive: payload.isActive ?? true,
      sortOrder: payload.sortOrder ?? 0,
    };
    const template = hasPickupNoticeTemplateDelegate()
      ? await prisma.pickupNoticeTemplate.create({
          data: {
            name: data.name,
            address: data.address,
            readyDate: data.readyDate,
            timeWindow: data.timeWindow,
            emailSubject: data.emailSubject,
            emailBody: data.emailBody,
            instructions: data.instructions,
            isActive: data.isActive,
            sortOrder: data.sortOrder,
          },
        })
      : mapPickupNoticeTemplateRow((await prisma.$queryRawUnsafe(`
          INSERT INTO "pickup_notice_templates" (
            "id",
            "name",
            "address",
            "ready_date",
            "time_window",
            "email_subject",
            "email_body",
            "instructions",
            "is_active",
            "sort_order"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING
            "id",
            "name",
            "address",
            "ready_date",
            "time_window",
            "email_subject",
            "email_body",
            "instructions",
            "is_active",
            "sort_order",
            "created_at",
            "updated_at"
        `, data.id, data.name, data.address, data.readyDate, data.timeWindow, data.emailSubject, data.emailBody, data.instructions, data.isActive, data.sortOrder))[0]);

    return res.status(201).json({
      message: 'Pickup notice template created successfully.',
      item: template,
    });
  } catch (error) {
    next(error);
  }
}

export async function updatePickupNoticeTemplateHandler(req, res, next) {
  try {
    const templateId = pickupNoticeTemplateIdSchema.parse(req.params.templateId);
    const payload = pickupNoticeTemplateUpdateSchema.parse(req.body);
    const existing = hasPickupNoticeTemplateDelegate()
      ? await prisma.pickupNoticeTemplate.findUnique({ where: { id: templateId } })
      : mapPickupNoticeTemplateRow((await prisma.$queryRawUnsafe(`
          SELECT
            "id",
            "name",
            "address",
            "ready_date",
            "time_window",
            "email_subject",
            "email_body",
            "instructions",
            "is_active",
            "sort_order",
            "created_at",
            "updated_at"
          FROM "pickup_notice_templates"
          WHERE "id" = $1
          LIMIT 1
        `, templateId))[0]);

    if (!existing) {
      return res.status(404).json({ message: 'Pickup notice template not found.' });
    }

    const name = payload.name !== undefined ? normalizeTemplateName(payload.name) : existing.name;

    if (name !== existing.name) {
      const duplicate = await findDuplicateTemplate(name, templateId);
      if (duplicate) {
        return res.status(409).json({ message: 'A pickup notice template with this name already exists.' });
      }
    }

    const template = hasPickupNoticeTemplateDelegate()
      ? await prisma.pickupNoticeTemplate.update({
          where: { id: templateId },
          data: {
            ...(payload.name !== undefined ? { name } : {}),
            ...(payload.address !== undefined ? { address: payload.address.trim() } : {}),
            ...(payload.readyDate !== undefined ? { readyDate: payload.readyDate } : {}),
            ...(payload.timeWindow !== undefined ? { timeWindow: payload.timeWindow.trim() } : {}),
            ...(payload.emailSubject !== undefined ? { emailSubject: normalizeOptionalText(payload.emailSubject) } : {}),
            ...(payload.emailBody !== undefined ? { emailBody: normalizeOptionalText(payload.emailBody) } : {}),
            ...(payload.instructions !== undefined ? { instructions: normalizeInstructions(payload.instructions) } : {}),
            ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
            ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
          },
        })
      : mapPickupNoticeTemplateRow((await prisma.$queryRawUnsafe(`
          UPDATE "pickup_notice_templates"
          SET
            "name" = $2,
            "address" = $3,
            "ready_date" = $4,
            "time_window" = $5,
            "email_subject" = $6,
            "email_body" = $7,
            "instructions" = $8,
            "is_active" = $9,
            "sort_order" = $10,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = $1
          RETURNING
            "id",
            "name",
            "address",
            "ready_date",
            "time_window",
            "email_subject",
            "email_body",
            "instructions",
            "is_active",
            "sort_order",
            "created_at",
            "updated_at"
        `,
        templateId,
        name,
        payload.address !== undefined ? payload.address.trim() : existing.address,
        payload.readyDate !== undefined ? payload.readyDate : existing.readyDate,
        payload.timeWindow !== undefined ? payload.timeWindow.trim() : existing.timeWindow,
        payload.emailSubject !== undefined ? normalizeOptionalText(payload.emailSubject) : existing.emailSubject,
        payload.emailBody !== undefined ? normalizeOptionalText(payload.emailBody) : existing.emailBody,
        payload.instructions !== undefined ? normalizeInstructions(payload.instructions) : existing.instructions,
        payload.isActive !== undefined ? payload.isActive : existing.isActive,
        payload.sortOrder !== undefined ? payload.sortOrder : existing.sortOrder,
      ))[0]);

    return res.json({
      message: 'Pickup notice template updated successfully.',
      item: template,
    });
  } catch (error) {
    next(error);
  }
}

export async function deletePickupNoticeTemplateHandler(req, res, next) {
  try {
    const templateId = pickupNoticeTemplateIdSchema.parse(req.params.templateId);
    const existing = hasPickupNoticeTemplateDelegate()
      ? await prisma.pickupNoticeTemplate.findUnique({
          where: { id: templateId },
          select: { id: true },
        })
      : (await prisma.$queryRawUnsafe(`
          SELECT "id"
          FROM "pickup_notice_templates"
          WHERE "id" = $1
          LIMIT 1
        `, templateId))[0];

    if (!existing) {
      return res.status(404).json({ message: 'Pickup notice template not found.' });
    }

    if (hasPickupNoticeTemplateDelegate()) {
      await prisma.pickupNoticeTemplate.delete({ where: { id: templateId } });
    } else {
      await prisma.$executeRawUnsafe(`
        DELETE FROM "pickup_notice_templates"
        WHERE "id" = $1
      `, templateId);
    }

    return res.json({ message: 'Pickup notice template deleted successfully.' });
  } catch (error) {
    next(error);
  }
}
