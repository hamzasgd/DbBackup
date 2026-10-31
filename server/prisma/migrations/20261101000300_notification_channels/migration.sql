-- Additional notification channels: ntfy, Telegram, Discord
ALTER TABLE "notification_settings" ADD COLUMN "ntfyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notification_settings" ADD COLUMN "ntfyServerUrl" TEXT;
ALTER TABLE "notification_settings" ADD COLUMN "ntfyTopic" TEXT;
ALTER TABLE "notification_settings" ADD COLUMN "telegramEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notification_settings" ADD COLUMN "telegramBotToken" TEXT;
ALTER TABLE "notification_settings" ADD COLUMN "telegramChatId" TEXT;
ALTER TABLE "notification_settings" ADD COLUMN "discordEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notification_settings" ADD COLUMN "discordWebhookUrl" TEXT;
