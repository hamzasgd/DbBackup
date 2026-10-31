-- WhatsApp Business API notifications
ALTER TABLE "notification_settings" ADD COLUMN "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notification_settings" ADD COLUMN "whatsappPhoneNumberId" TEXT;
ALTER TABLE "notification_settings" ADD COLUMN "whatsappAccessToken" TEXT;
ALTER TABLE "notification_settings" ADD COLUMN "whatsappRecipient" TEXT;
