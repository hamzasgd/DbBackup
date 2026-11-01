import { Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';
import { encrypt } from '../services/crypto.service';
import { testNotification } from '../services/notification.service';
import { logAudit } from '../services/audit.service';

const MASK = '••••••••';

// Channel credentials that must never be sent back to the browser in readable form.
// (Webhook URLs are themselves the credential — anyone with the URL can post.)
const SECRET_FIELDS = ['smtpPass', 'slackWebhookUrl', 'discordWebhookUrl', 'telegramBotToken', 'whatsappAccessToken'] as const;

/** Replace every present secret field with a fixed mask before returning to the client. */
function maskSecrets<T extends Record<string, unknown>>(settings: T): T {
  const out = { ...settings } as Record<string, unknown>;
  for (const f of SECRET_FIELDS) {
    if (out[f]) out[f] = MASK;
  }
  return out as T;
}

export async function getNotificationSettings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const settings = await prisma.notificationSettings.findUnique({
      where: { userId: req.user!.userId },
    });
    res.json({ success: true, data: settings ? maskSecrets(settings) : null });
  } catch (err) { next(err); }
}

export async function upsertNotificationSettings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      emailEnabled, emailAddress, smtpHost, smtpPort, smtpUser, smtpPass,
      smtpSecure, slackEnabled, slackWebhookUrl,
      notifyOnSuccess, notifyOnFailure, notifyOnRetention, notifyOnLogin, notifyOnStorage,
      ntfyEnabled, ntfyServerUrl, ntfyTopic,
      telegramEnabled, telegramBotToken, telegramChatId,
      discordEnabled, discordWebhookUrl,
      whatsappEnabled, whatsappPhoneNumberId, whatsappAccessToken, whatsappRecipient,
    } = req.body;

    const data: Record<string, unknown> = {};

    // Encrypted secrets: write only a real new value; MASK means "keep existing", "" means clear.
    const setSecret = (key: string, value: unknown) => {
      if (value === undefined || value === MASK) return;       // not provided / unchanged
      if (value === '' || value === null) { data[key] = null; return; } // explicit clear
      data[key] = encrypt(String(value));
    };
    setSecret('smtpPass', smtpPass);
    setSecret('slackWebhookUrl', slackWebhookUrl);
    setSecret('discordWebhookUrl', discordWebhookUrl); // now encrypted (was plaintext)
    setSecret('telegramBotToken', telegramBotToken);
    setSecret('whatsappAccessToken', whatsappAccessToken);

    // Non-secret scalars
    if (emailEnabled !== undefined) data.emailEnabled = emailEnabled;
    if (emailAddress !== undefined) data.emailAddress = emailAddress;
    if (smtpHost !== undefined) data.smtpHost = smtpHost;
    if (smtpPort !== undefined) data.smtpPort = Number(smtpPort);
    if (smtpUser !== undefined) data.smtpUser = smtpUser;
    if (smtpSecure !== undefined) data.smtpSecure = smtpSecure;
    if (slackEnabled !== undefined) data.slackEnabled = slackEnabled;
    if (notifyOnSuccess !== undefined) data.notifyOnSuccess = notifyOnSuccess;
    if (notifyOnFailure !== undefined) data.notifyOnFailure = notifyOnFailure;
    if (notifyOnRetention !== undefined) data.notifyOnRetention = notifyOnRetention;
    if (notifyOnLogin !== undefined) data.notifyOnLogin = notifyOnLogin;
    if (notifyOnStorage !== undefined) data.notifyOnStorage = notifyOnStorage;
    if (discordEnabled !== undefined) data.discordEnabled = discordEnabled;
    if (whatsappEnabled !== undefined) data.whatsappEnabled = whatsappEnabled;
    if (whatsappPhoneNumberId !== undefined) data.whatsappPhoneNumberId = whatsappPhoneNumberId || null;
    if (whatsappRecipient !== undefined) data.whatsappRecipient = whatsappRecipient || null;
    if (telegramChatId !== undefined) data.telegramChatId = telegramChatId;
    if (telegramEnabled !== undefined) data.telegramEnabled = telegramEnabled;
    if (ntfyTopic !== undefined) data.ntfyTopic = ntfyTopic;
    if (ntfyServerUrl !== undefined) data.ntfyServerUrl = ntfyServerUrl;
    if (ntfyEnabled !== undefined) data.ntfyEnabled = ntfyEnabled;

    const settings = await prisma.notificationSettings.upsert({
      where: { userId: req.user!.userId },
      create: { userId: req.user!.userId, ...data },
      update: data,
    });

    await logAudit(req.user!.userId, 'UPDATE', 'notification_settings', { emailEnabled, slackEnabled }, req.ip);

    res.json({ success: true, data: maskSecrets(settings) });
  } catch (err) { next(err); }
}

export async function testNotificationEndpoint(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { channel } = req.body as { channel: 'email' | 'slack' };
    const result = await testNotification(req.user!.userId, channel);
    res.json({ success: result.success, message: result.error ?? 'Test notification sent' });
  } catch (err) { next(err); }
}
