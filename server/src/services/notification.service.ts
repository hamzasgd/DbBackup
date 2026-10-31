import nodemailer from 'nodemailer';
import axios from 'axios';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { decrypt, decryptIfPresent, encrypt } from './crypto.service';

export type NotificationEventType =
  | 'BACKUP_COMPLETED'
  | 'BACKUP_FAILED'
  | 'MIGRATION_COMPLETED'
  | 'MIGRATION_FAILED'
  | 'VERIFICATION_FAILED'
  | 'RETENTION_CLEANUP'
  | 'RESTORE_COMPLETED'
  | 'RESTORE_FAILED'
  | 'SYNC_COMPLETED'
  | 'SYNC_FAILED'
  | 'HEARTBEAT_DOWN'
  | 'HEARTBEAT_RECOVERED'
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'PASSKEY_LOGIN'
  | 'STORAGE_THRESHOLD'
  | 'ENCRYPTION_FAILED'
  | 'LOGIN_IP_LOCKOUT'
  | 'LOGIN_BRUTE_FORCE_SUSPECT'
  | 'BACKUP_STALE'
  | 'DRILL_FAILED';

export interface NotificationPayload {
  event: NotificationEventType;
  title: string;
  message: string;
  details?: Record<string, string | number | boolean>;
}

// HTML escape helper to prevent XSS in email notifications
function escapeHtml(str: string | number | boolean): string {
  const s = String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Cache transporters by SMTP config fingerprint to avoid creating new connections per email
const transporterCache = new Map<string, { transporter: nodemailer.Transporter; createdAt: number }>();
const TRANSPORTER_TTL = 10 * 60 * 1000; // 10 minutes

function getTransporter(settings: {
  smtpHost: string;
  smtpPort: number;
  smtpUser?: string | null;
  smtpPass?: string | null;
  smtpSecure: boolean;
}): nodemailer.Transporter {
  const key = `${settings.smtpHost}:${settings.smtpPort}:${settings.smtpUser ?? ''}`;
  const cached = transporterCache.get(key);
  if (cached && Date.now() - cached.createdAt < TRANSPORTER_TTL) {
    return cached.transporter;
  }

  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    pool: true,
    maxConnections: 3,
    auth: settings.smtpUser
      ? {
          user: settings.smtpUser,
          pass: settings.smtpPass ? decrypt(settings.smtpPass) : '',
        }
      : undefined,
  });

  transporterCache.set(key, { transporter, createdAt: Date.now() });
  return transporter;
}

async function sendEmail(
  settings: {
    emailAddress: string;
    smtpHost: string;
    smtpPort: number;
    smtpUser?: string | null;
    smtpPass?: string | null;
    smtpSecure: boolean;
  },
  payload: NotificationPayload,
): Promise<void> {
  const transporter = getTransporter(settings);

  // Escape all user-controlled content before HTML interpolation
  const safeTitle = escapeHtml(payload.title);
  const safeMessage = escapeHtml(payload.message);
  const detailRows = settings && payload.details
    ? Object.entries(payload.details)
        .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px">${escapeHtml(k)}</td><td style="padding:4px 0;font-size:13px">${escapeHtml(v)}</td></tr>`)
        .join('')
    : '';

  const isFailure = payload.event.includes('FAILED');

  await transporter.sendMail({
    from: `"DbBackup" <${settings.smtpUser || 'noreply@dbbackup.local'}>`,
    to: settings.emailAddress,
    subject: `[DbBackup] ${safeTitle}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <div style="background:${isFailure ? '#dc2626' : '#2563eb'};padding:16px 24px;border-radius:8px 8px 0 0">
          <h2 style="color:#fff;margin:0;font-size:18px">${safeTitle}</h2>
        </div>
        <div style="background:#f9fafb;padding:20px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
          <p style="margin:0 0 16px;color:#374151">${safeMessage}</p>
          ${detailRows ? `<table style="border-collapse:collapse">${detailRows}</table>` : ''}
          <p style="margin:16px 0 0;font-size:12px;color:#9ca3af">DbBackup · ${new Date().toUTCString()}</p>
        </div>
      </div>
    `,
  });
}

async function sendSlack(webhookUrl: string, payload: NotificationPayload): Promise<void> {
  const isFailure = payload.event.includes('FAILED');
  const color = isFailure ? '#dc2626' : '#16a34a';
  const fields = payload.details
    ? Object.entries(payload.details).map(([k, v]) => ({ title: k, value: String(v), short: true }))
    : [];

  await axios.post(decrypt(webhookUrl), {
    attachments: [
      {
        color,
        title: payload.title,
        text: payload.message,
        fields,
        footer: 'DbBackup',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  });
}

async function sendNtfy(settings: { serverUrl?: string | null; topic: string }, payload: NotificationPayload): Promise<void> {
  const server = settings.serverUrl || 'https://ntfy.sh';
  await fetch(`${server}/${settings.topic}`, {
    method: 'POST',
    headers: { Title: payload.title, Priority: payload.event.includes('FAILED') || payload.event.includes('DOWN') ? 'urgent' : 'default', Tags: 'floppy_disk' },
    body: `${payload.message}${payload.details ? '\n' + Object.entries(payload.details).map(([k, v]) => `${k}: ${v}`).join('\n') : ''}`,
  });
}

async function sendTelegram(settings: { botToken: string; chatId: string }, payload: NotificationPayload): Promise<void> {
  const text = `*${payload.title}*\n${payload.message}${payload.details ? '\n\n' + Object.entries(payload.details).map(([k, v]) => `${k}: ${v}`).join('\n') : ''}`;
  await fetch(`https://api.telegram.org/bot${settings.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: settings.chatId, text, parse_mode: 'Markdown' }),
  });
}

async function sendDiscord(webhookUrl: string, payload: NotificationPayload): Promise<void> {
  // Discord webhooks have the same shape as Slack's
  await sendSlack(webhookUrl, payload);
}

async function sendWhatsApp(settings: { phoneNumberId: string; accessToken: string; recipient: string }, payload: NotificationPayload): Promise<void> {
  const text = `${payload.title}\n\n${payload.message}${payload.details ? '\n\n' + Object.entries(payload.details).map(([k, v]) => `${k}: ${v}`).join('\n') : ''}`;

  await fetch(`https://graph.facebook.com/v21.0/${settings.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${settings.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: settings.recipient,
      type: 'text',
      text: { body: text.slice(0, 4096) }, // WhatsApp text limit
    }),
  });
}

export async function notify(userId: string, payload: NotificationPayload): Promise<void> {
  try {
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    if (!settings) return;

    const isFailure = payload.event.includes('FAILED') || payload.event === 'HEARTBEAT_DOWN' || payload.event === 'LOGIN_IP_LOCKOUT'
    || payload.event === 'LOGIN_BRUTE_FORCE_SUSPECT'
    || payload.event === 'BACKUP_STALE'
    || payload.event === 'DRILL_FAILED';
    const isSuccess = payload.event.includes('COMPLETED') || payload.event === 'HEARTBEAT_RECOVERED';
    const isRetention = payload.event === 'RETENTION_CLEANUP';
    const isLogin = payload.event === 'LOGIN' || payload.event === 'PASSKEY_LOGIN';
    const isStorage = payload.event === 'STORAGE_THRESHOLD';

    const shouldSend =
      (isFailure && settings.notifyOnFailure) ||
      (isSuccess && settings.notifyOnSuccess) ||
      (isRetention && settings.notifyOnRetention) ||
      (isLogin && settings.notifyOnLogin);

    if (!shouldSend) return;

    const tasks: Promise<void>[] = [];

    if (settings.emailEnabled && settings.emailAddress && settings.smtpHost) {
      tasks.push(
        sendEmail(
          {
            emailAddress: settings.emailAddress,
            smtpHost: settings.smtpHost,
            smtpPort: settings.smtpPort ?? 587,
            smtpUser: settings.smtpUser,
            smtpPass: settings.smtpPass,
            smtpSecure: settings.smtpSecure,
          },
          payload,
        ).catch((err) => { logger.error('Email notification failed:', err); }),
      );
    }

    if (settings.slackEnabled && settings.slackWebhookUrl) {
      tasks.push(
        sendSlack(settings.slackWebhookUrl, payload).catch((err) => {
          logger.error('Slack notification failed:', err);
        }),
      );
    }

    if (settings.ntfyEnabled && settings.ntfyTopic) {
      tasks.push(
        sendNtfy({ serverUrl: settings.ntfyServerUrl, topic: settings.ntfyTopic }, payload)
          .catch((err) => { logger.error('ntfy notification failed:', err); }),
      );
    }

    if (settings.telegramEnabled && settings.telegramBotToken && settings.telegramChatId) {
      tasks.push(
        sendTelegram({ botToken: settings.telegramBotToken, chatId: settings.telegramChatId }, payload)
          .catch((err) => { logger.error('Telegram notification failed:', err); }),
      );
    }

    if (settings.discordEnabled && settings.discordWebhookUrl) {
      tasks.push(
        sendDiscord(settings.discordWebhookUrl, payload)
          .catch((err) => { logger.error('Discord notification failed:', err); }),
      );
    }

    if (settings.whatsappEnabled && settings.whatsappPhoneNumberId && settings.whatsappAccessToken && settings.whatsappRecipient) {
      tasks.push(
        sendWhatsApp(
          { phoneNumberId: settings.whatsappPhoneNumberId, accessToken: settings.whatsappAccessToken, recipient: settings.whatsappRecipient },
          payload,
        ).catch((err) => { logger.error('WhatsApp notification failed:', err); }),
      );
    }

    await Promise.all(tasks);
  } catch (err) {
    logger.error('notify() error:', err);
  }
}

/** Send a test notification to verify settings are working */
export async function testNotification(
  userId: string,
  channel: 'email' | 'slack',
): Promise<{ success: boolean; error?: string }> {
  try {
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    if (!settings) return { success: false, error: 'No notification settings found' };

    const payload: NotificationPayload = {
      event: 'BACKUP_COMPLETED',
      title: '🧪 Test Notification',
      message: 'This is a test notification from DbBackup. Your notification channel is working correctly.',
      details: { Timestamp: new Date().toISOString(), Channel: channel },
    };

    if (channel === 'email') {
      if (!settings.emailAddress || !settings.smtpHost) {
        return { success: false, error: 'Email settings incomplete' };
      }
      await sendEmail(
        {
          emailAddress: settings.emailAddress,
          smtpHost: settings.smtpHost,
          smtpPort: settings.smtpPort ?? 587,
          smtpUser: settings.smtpUser,
          smtpPass: settings.smtpPass,
          smtpSecure: settings.smtpSecure,
        },
        payload,
      );
    } else {
      if (!settings.slackWebhookUrl) {
        return { success: false, error: 'Slack webhook URL not set' };
      }
      await sendSlack(settings.slackWebhookUrl, payload);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Used only to avoid importing decrypt in the controller for plain strings */
export function encryptField(value: string): string {
  return encrypt(value);
}

export { decryptIfPresent };
