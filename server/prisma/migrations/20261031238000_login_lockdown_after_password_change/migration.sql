-- Security cool-down: block logins for a window after a password change
ALTER TABLE "users" ADD COLUMN "loginLockedUntil" TIMESTAMP(3);
