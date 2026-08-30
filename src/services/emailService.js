import nodemailer from 'nodemailer';
import { env, isResendConfigured, isSmtpConfigured } from '../config/env.js';

const smtpTransporter = isSmtpConfigured
  ? nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass,
      },
    })
  : null;

function formatMoney(cents) {
  return `CAD ${(cents / 100).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function compactOptionalNoticeLines(lines) {
  return lines.filter((line) => line !== null && line !== undefined);
}

const PICKUP_NOTICE_INSTRUCTIONS = [
  'Please bring a valid means of identification.',
  'Your Order Number, exact name and email address used to place your order will be required for verification.',
  'If you ordered half of any item, please bring a suitable bag for proper packaging.',
  'Kindly park only in the designated driveway/parking lot of the advised address or permitted roadside parking spots. Do not obstruct neighbouring driveways or traffic.',
  'Please pick up your items and drive out of the location immediately to ease traffic and to create space for others to pick up.',
  'Do not litter the location with boxes.',
  'Please adhere strictly to the advised pick-up window, as we will not be available to attend to pickups afterwards. We will also not be responsible for any deterioration or damage to produce that is not picked up within the assigned time.',
];

function buildPickupInstructionsHtml(note) {
  const instructions = PICKUP_NOTICE_INSTRUCTIONS
    .map((instruction) => `<li style="margin:0 0 8px 0;">${escapeHtml(instruction)}</li>`)
    .join('');

  return `
    <div style="margin:0 0 28px 0;">
      <p style="margin:0 0 12px 0;"><strong>IMPORTANT PICK-UP INSTRUCTIONS</strong></p>
      <ol style="margin:0; padding-left:22px;">
        ${instructions}
      </ol>
      ${note ? `<p style="margin:16px 0 0 0;"><strong>Additional instruction:</strong> ${escapeHtml(note)}</p>` : ''}
    </div>
  `;
}

function buildPickupInstructionsText(note) {
  return compactOptionalNoticeLines([
    'IMPORTANT PICK-UP INSTRUCTIONS',
    '',
    ...PICKUP_NOTICE_INSTRUCTIONS.map((instruction, index) => `${index + 1}. ${instruction}`),
    note ? '' : null,
    note ? `Additional instruction: ${note}` : null,
  ]).join('\n');
}

async function sendWithResend({ to, subject, text, html }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.resendFrom,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      ...(html ? { html } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend email failed (${response.status}): ${body || 'Unknown error'}`);
  }

  return response.json().catch(() => ({}));
}

async function sendWithSmtp({ to, subject, text, html }) {
  await smtpTransporter.sendMail({
    from: env.smtpFrom,
    to,
    subject,
    text,
    ...(html ? { html } : {}),
  });
}

export async function sendMail({ to, subject, text, html }) {
  if (isResendConfigured) {
    try {
      await sendWithResend({ to, subject, text, html });
      return;
    } catch (error) {
      console.error('Resend delivery failed, falling back to next provider', {
        to,
        subject,
        error: error?.message,
      });
    }
  }

  if (smtpTransporter) {
    try {
      await sendWithSmtp({ to, subject, text, html });
      return;
    } catch (error) {
      console.error('SMTP delivery failed, using dry-run fallback', {
        to,
        subject,
        host: env.smtpHost,
        error: error?.message,
      });
    }
  }

  console.log('[email:dry-run]', { provider: 'dry-run', to, subject, text, html });
}

export async function sendOrderPaidEmail({
  email,
  firstName,
  salesItemName,
  quantity,
  totalPaidCad,
  displayOrderReference,
}) {
  await sendMail({
    to: email,
    subject: 'Order Confirmation',
    text: [
      `Hello ${firstName},`,
      '',
      'Your payment has been confirmed and order submitted successfully with below details:',
      '',
      `Order reference: ${displayOrderReference}`,
      `Items: ${salesItemName}`,
      `Quantity: ${quantity}`,
      `Total paid: ${formatMoney(totalPaidCad)}`,
      '',
      'We would provide further details once your order is ready for pick-up/delivery.',
      '',
      'Thank you for your patronage.',
      '',
      'Regards,',
      'EazziBulkBuy.',
    ].join('\n'),
  });
}

export async function sendOrderFulfillmentCompletedEmail({
  email,
  firstName,
  displayOrderReference,
  itemName,
  quantity,
}) {
  await sendMail({
    to: email,
    subject: 'Order Receipt/Delivery',
    text: [
      `Hello ${firstName},`,
      '',
      'Your order has been picked up successfully.',
      '',
      `Order reference: ${displayOrderReference}`,
      `Item(s): ${itemName}`,
      `Quantity: ${quantity}`,
      '',
      'Kindly confirm your order carefully before leaving the pickup location. Due to the nature of our fresh farm produce, all sales are final and items returned after pickup or delivery will not be accepted.',
      '',
      'Thank you for your understanding and continued patronage.',
      '',
      'Regards',
      'EazziBulkBuy',
    ].join('\n'),
  });
}

export async function sendOrderReadyNoticeEmail({
  email,
  firstName,
  displayOrderReference,
  itemsSummary,
  fulfillmentMethod,
  address,
  preferredPickupLocation,
  readyDate,
  timeWindow,
  contactName,
  contactPhone,
  note,
}) {
  const isDelivery = fulfillmentMethod === 'DELIVERY';
  const htmlLines = [
    `<p style="margin:0 0 28px 0;">Hello ${escapeHtml(firstName)},</p>`,
    `<p style="margin:0 0 28px 0;">${
      isDelivery
        ? 'Your paid order is now ready for delivery coordination.'
        : 'Your paid order is now ready for pickup.'
    }</p>`,
    `<p style="margin:0 0 28px 0;">Order reference: ${escapeHtml(displayOrderReference)}<br />Items: ${escapeHtml(itemsSummary)}</p>`,
    !isDelivery && preferredPickupLocation
      ? `<p style="margin:0 0 28px 0;">Preferred pickup location: ${escapeHtml(preferredPickupLocation)}</p>`
      : null,
    `<p style="margin:0 0 28px 0;">${escapeHtml(isDelivery ? 'Dispatch / meeting address' : 'Pickup address')}: ${escapeHtml(address)}<br />Date: ${escapeHtml(readyDate)}<br />Time: ${escapeHtml(timeWindow)}${
      contactName ? `<br />Contact name: ${escapeHtml(contactName)}` : ''
    }${contactPhone ? `<br />Contact phone: ${escapeHtml(contactPhone)}` : ''}</p>`,
    isDelivery ? (note ? `<p style="margin:0 0 28px 0;">Instructions: ${escapeHtml(note)}</p>` : null) : buildPickupInstructionsHtml(note),
    `<p style="margin:0 0 28px 0;">${
      isDelivery
        ? 'Please watch for further coordination from our team if needed.'
        : 'Please arrive within the stated time window to receive your order.'
    }</p>`,
    '<p style="margin:0;">Regards,<br />EazziBulkBuy.</p>',
  ]
    .filter(Boolean)
    .join('');

  await sendMail({
    to: email,
    subject: isDelivery ? 'Your order is ready for delivery' : 'Your order is ready for pickup',
    text: compactOptionalNoticeLines([
      `Hello ${firstName},`,
      '',
      '',
      isDelivery
        ? 'Your paid order is now ready for delivery coordination.'
        : 'Your paid order is now ready for pickup.',
      '',
      '',
      `Order reference: ${displayOrderReference}`,
      `Items: ${itemsSummary}`,
      '',
      !isDelivery && preferredPickupLocation ? `Preferred pickup location: ${preferredPickupLocation}` : null,
      !isDelivery && preferredPickupLocation ? '' : null,
      `${isDelivery ? 'Dispatch / meeting address' : 'Pickup address'}: ${address}`,
      `Date: ${readyDate}`,
      `Time: ${timeWindow}`,
      contactName ? `Contact name: ${contactName}` : null,
      contactPhone ? `Contact phone: ${contactPhone}` : null,
      '',
      isDelivery ? (note ? `Instructions: ${note}` : null) : buildPickupInstructionsText(note),
      '',
      isDelivery
        ? 'Please watch for further coordination from our team if needed.'
        : 'Please arrive within the stated time window to receive your order.',
      '',
      '',
      'Regards,',
      'EazziBulkBuy.',
    ]).join('\n'),
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif; color:#0f172a; font-size:16px; line-height:1.7;">
        ${htmlLines}
      </div>
    `,
  });
}

export async function sendOrderRefundEmail({
  email,
  firstName,
  displayOrderReference,
  itemsSummary,
  quantity,
  totalRefunded,
  reason,
}) {
  await sendMail({
    to: email,
    subject: 'Order Refund Update',
    text: [
      `Hello ${firstName},`,
      '',
      'Your refund has been processed with below details:',
      '',
      `Order reference: ${displayOrderReference}`,
      `Items: ${itemsSummary}`,
      `Quantity: ${quantity}`,
      `Total refunded: CAD ${(Number(totalRefunded || 0) / 100).toFixed(2)}`,
      '',
      `Reason: ${reason}`,
      '',
      'Thank you for your patronage.',
      '',
      'Regards,',
      'EazziBulkBuy.',
    ].join('\n'),
  });
}

export async function sendOrderCancellationEmail({
  email,
  firstName,
  reason,
}) {
  await sendMail({
    to: email,
    subject: 'Order Cancellation Update',
    text: [
      `Hello ${firstName},`,
      '',
      'Your order has been cancelled',
      '',
      `Reason: ${reason}`,
      '',
      'Thank you for your continued patronage.',
      '',
      'Regards',
      'EazziBulkBuy',
    ].join('\n'),
  });
}

export async function sendBuyerWelcomeEmail({ email, buyerName }) {
  await sendMail({
    to: email,
    subject: 'Welcome to EazziBulkBuy',
    text: [
      `Hello ${buyerName},`,
      '',
      'Welcome to EazziBulkBuy.',
      'Your buyer details have been added successfully and you can now place orders faster on your next visit.',
      '',
      'Thank you for joining EazziBulkBuy.',
    ].join('\n'),
  });
}

export async function sendUserInviteEmail({ email, fullName, role, inviteUrl, expiresAt }) {
  const roleLabel = role === 'PARTNER' ? 'Fulfilment Staff' : role;

  await sendMail({
    to: email,
    subject: `You're invited to EazziBulkBuy (${roleLabel})`,
    text: [
      `Hello ${fullName},`,
      '',
      `You have been invited as a ${roleLabel} on EazziBulkBuy.`,
      `Use this link to set your password: ${inviteUrl}`,
      `This invite expires on: ${expiresAt.toISOString()}`,
      '',
      'If you were not expecting this invite, ignore this email.',
    ].join('\n'),
  });
}

export async function sendAdminPasswordResetEmail({ email, fullName, resetUrl, expiresAt }) {
  await sendMail({
    to: email,
    subject: 'Reset your EazziBulkBuy admin password',
    text: [
      `Hello ${fullName},`,
      '',
      'We received a request to reset your EazziBulkBuy admin password.',
      `Use this link to set a new password: ${resetUrl}`,
      `This reset link expires on: ${expiresAt.toISOString()}`,
      '',
      'If you did not request this reset, you can ignore this email.',
    ].join('\n'),
  });
}
