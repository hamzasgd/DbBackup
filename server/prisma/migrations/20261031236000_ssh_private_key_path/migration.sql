-- Optional server-side SSH key file reference (keys stay out of the database)
ALTER TABLE "connections" ADD COLUMN "sshPrivateKeyPath" TEXT;
