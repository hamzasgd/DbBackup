-- Pinned SSH host key fingerprint for tunnelled connections (trust on first use)
ALTER TABLE "connections" ADD COLUMN "sshHostKey" TEXT;
