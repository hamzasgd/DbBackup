-- Login alerts (email/Slack) — on by default
ALTER TABLE "notification_settings" ADD COLUMN "notifyOnLogin" BOOLEAN NOT NULL DEFAULT true;
