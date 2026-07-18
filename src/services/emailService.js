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

async function sendWithResend({ to, subject, text }) {
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
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend email failed (${response.status}): ${body || 'Unknown error'}`);
  }

  return response.json().catch(() => ({}));
}

async function sendWithSmtp({ to, subject, text }) {
  await smtpTransporter.sendMail({
    from: env.smtpFrom,
    to,
    subject,
    text,
  });
}

export async function sendMail({ to, subject, text }) {
  if (isResendConfigured) {
    try {
      await sendWithResend({ to, subject, text });
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
      await sendWithSmtp({ to, subject, text });
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

  console.log('[email:dry-run]', { provider: 'dry-run', to, subject, text });
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
  fulfillmentMethod,
}) {
  const isDelivery = fulfillmentMethod === 'DELIVERY';
  const actionLabel = isDelivery ? 'delivered' : 'picked up';

  await sendMail({
    to: email,
    subject: isDelivery ? 'Order Delivery Confirmed' : 'Order Pickup Confirmed',
    text: [
      `Hello ${firstName},`,
      '',
      `Your order item has been ${actionLabel} successfully.`,
      '',
      `Order reference: ${displayOrderReference}`,
      `Item: ${itemName}`,
      `Quantity: ${quantity}`,
      '',
      isDelivery
        ? 'This confirms that your order has been delivered.'
        : 'This confirms that your order has been picked up.',
      '',
      'Thank you for choosing EazziBulkBuy.',
      '',
      'Regards,',
      'EazziBulkBuy.',
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
  await sendMail({
    to: email,
    subject: `You're invited to EazziBulkBuy (${role})`,
    text: [
      `Hello ${fullName},`,
      '',
      `You have been invited as a ${role} on EazziBulkBuy.`,
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
