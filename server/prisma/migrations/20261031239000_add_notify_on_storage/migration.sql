-- Storage threshold alerts (email/Slack) — on by default
ALTER TABLE "notification_settings" ADD COLUMN "notifyOnStorage" BOOLEAN NOT NULL DEFAULT true;
