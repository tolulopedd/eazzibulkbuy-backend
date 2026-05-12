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

function formatPaymentMethod(paymentMethod) {
  if (!paymentMethod) {
    return 'Unknown';
  }

  return paymentMethod
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export async function sendOrderPlacedEmail({
  email,
  buyerName,
  salesItemName,
  quantity,
  orderReference,
  paymentMethod,
  totalAmountCad,
  instructions,
}) {
  await sendMail({
    to: email,
    subject: `Order Received – ${salesItemName}`,
    text: [
      `Hello ${buyerName},`,
      '',
      'Your order has been created successfully.',
      `Order reference: ${orderReference}`,
      `Items: ${salesItemName}`,
      `Quantity: ${quantity}`,
      `Total amount: ${formatMoney(totalAmountCad)}`,
      `Payment method: ${formatPaymentMethod(paymentMethod)}`,
      instructions ? `Payment instructions: ${instructions}` : '',
      '',
      'Thank you for ordering with EazziBulkBuy.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

export async function sendOrderPaidEmail({
  email,
  buyerName,
  salesItemName,
  quantity,
  totalPaidCad,
  orderReference,
  pickupInstructions,
}) {
  const pickupLine = pickupInstructions
    ? `Pickup instructions: ${pickupInstructions}`
    : 'Pickup instructions: Not available yet. Our team will follow up.';

  await sendMail({
    to: email,
    subject: `Order Confirmed – ${salesItemName}`,
    text: [
      `Hello ${buyerName},`,
      '',
      'Your payment has been confirmed and your order is now approved.',
      '',
      `Order reference: ${orderReference}`,
      `Items: ${salesItemName}`,
      `Quantity: ${quantity}`,
      `Total paid: ${formatMoney(totalPaidCad)}`,
      pickupLine,
      '',
      'Thank you for ordering with EazziBulkBuy.',
    ].join('\n'),
  });
}

export async function sendManualTransferSubmittedEmail({
  email,
  buyerName,
  salesItemName,
  quantity,
  totalAmountCad,
  orderReference,
}) {
  await sendMail({
    to: email,
    subject: `Order Submitted – ${salesItemName}`,
    text: [
      `Hello ${buyerName},`,
      '',
      'Order submitted successfully.',
      'Your Interac transfer proof has been received and your order is now awaiting payment review.',
      '',
      `Order reference: ${orderReference}`,
      `Items: ${salesItemName}`,
      `Quantity: ${quantity}`,
      `Total paid: ${formatMoney(totalAmountCad)}`,
      '',
      'Our team will review the transfer and update the order once payment is confirmed.',
      '',
      'Thank you for ordering with EazziBulkBuy.',
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
