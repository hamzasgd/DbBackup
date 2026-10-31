import { Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';
import { encrypt, decrypt } from '../services/crypto.service';
import { testNotification } from '../services/notification.service';
import { logAudit } from '../services/audit.service';

export async function getNotificationSettings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const settings = await prisma.notificationSettings.findUnique({
      where: { userId: req.user!.userId },
    });

    // Mask sensitive fields before returning
    if (settings) {
      res.json({
        success: true, data: {
          ...settings,
          smtpPass: settings.smtpPass ? '••••••••' : null,
          slackWebhookUrl: settings.slackWebhookUrl ? '••••••••' : null,
        },
      });
    } else {
      res.json({ success: true, data: null });
    }
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

    // Only encrypt if a real value (not the masked placeholder) is provided
    const encryptedSmtpPass = smtpPass && smtpPass !== '••••••••' ? encrypt(smtpPass) : undefined;
    const encryptedSlackUrl = slackWebhookUrl && slackWebhookUrl !== '••••••••' ? encrypt(slackWebhookUrl) : undefined;

    // Build update object — only include fields that were provided
    const data: Record<string, unknown> = {};
    if (emailEnabled !== undefined) data.emailEnabled = emailEnabled;
    if (emailAddress !== undefined) data.emailAddress = emailAddress;
    if (smtpHost !== undefined) data.smtpHost = smtpHost;
    if (smtpPort !== undefined) data.smtpPort = Number(smtpPort);
    if (smtpUser !== undefined) data.smtpUser = smtpUser;
    if (encryptedSmtpPass) data.smtpPass = encryptedSmtpPass;
    if (smtpSecure !== undefined) data.smtpSecure = smtpSecure;
    if (slackEnabled !== undefined) data.slackEnabled = slackEnabled;
    if (encryptedSlackUrl) data.slackWebhookUrl = encryptedSlackUrl;
    if (notifyOnSuccess !== undefined) data.notifyOnSuccess = notifyOnSuccess;
    if (notifyOnFailure !== undefined) data.notifyOnFailure = notifyOnFailure;
    if (notifyOnRetention !== undefined) data.notifyOnRetention = notifyOnRetention;
    if (notifyOnLogin !== undefined) data.notifyOnLogin = notifyOnLogin;
    if (notifyOnStorage !== undefined) data.notifyOnStorage = notifyOnStorage;
    if (discordEnabled !== undefined) data.discordEnabled = discordEnabled;
    if (whatsappEnabled !== undefined) data.whatsappEnabled = whatsappEnabled;
    if (whatsappPhoneNumberId !== undefined) data.whatsappPhoneNumberId = whatsappPhoneNumberId || null;
    if (whatsappRecipient !== undefined) data.whatsappRecipient = whatsappRecipient || null;
    if (telegramBotToken && telegramBotToken !== '••••••••') data.telegramBotToken = encrypt(telegramBotToken);
    if (whatsappAccessToken && whatsappAccessToken !== '••••••••') data.whatsappAccessToken = encrypt(whatsappAccessToken);
    if (discordWebhookUrl !== undefined) data.discordWebhookUrl = discordWebhookUrl || null;
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

    res.json({ success: true, data: { ...settings, smtpPass: settings.smtpPass ? '••••••••' : null, slackWebhookUrl: settings.slackWebhookUrl ? '••••••••' : null } });
  } catch (err) { next(err); }
}

export async function testNotificationEndpoint(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { channel } = req.body as { channel: 'email' | 'slack' };
    const result = await testNotification(req.user!.userId, channel);
    res.json({ success: result.success, message: result.error ?? 'Test notification sent' });
  } catch (err) { next(err); }
}
