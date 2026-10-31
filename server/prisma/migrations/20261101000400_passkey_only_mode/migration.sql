-- Passkey-only mode: optionally disable password sign-in entirely
ALTER TABLE "users" ADD COLUMN "passwordLoginDisabled" BOOLEAN NOT NULL DEFAULT false;
