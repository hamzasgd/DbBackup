# Incident Response Runbook (for operators)

You *operate* a self-hosted DbBackup instance. This runbook covers the first hours after you suspect your instance (or its host) is compromised. The app ships with kill switches specifically for this — use them.

> Not reporting a bug in DbBackup itself? For code vulnerabilities, see the reporting guide in [SECURITY.md](SECURITY.md).

## 0. Stay calm, preserve evidence

Before tearing things down, grab what you'll want later (if safe to do so):

```bash
pm2 logs --lines 500 --nostream > /tmp/incident-pm2.log
tail -n 2000 /var/log/nginx/access.log > /tmp/incident-nginx.log
ps auxf > /tmp/incident-ps.txt
```

Also export the **Activity Logs** page (`/audit`) — logins with IP/device, `LOGIN_FAILED`, `SESSION_REVOKE`, `BACKUP_*`, `STORAGE_*` events are your timeline.

## 1. Contain — cut off access

**In the app (log in from a clean device):**

1. **Settings → Security → Active Sessions** → *Revoke all sessions* (logs out every device).
2. **Change your password** — this also starts the **2-hour sign-in lock-down**, so an attacker holding the *new* password still can't sign back in immediately.
3. **Settings → Security → Passkeys** → remove any passkey you don't recognize.
4. If your login itself is compromised and you can't get in: clear the lockout and take over from the server:
   ```bash
   psql "$DATABASE_URL" -c "UPDATE users SET \"loginLockedUntil\" = NULL, \"passwordHash\" = '<new bcrypt hash>' WHERE email = 'you@example.com';"
   ```

**On the host:**

5. Block the attacker's IP at the firewall (aaPanel / `ufw deny from <ip>`).
6. If the host itself is compromised: snapshot/suspend it and rebuild. Assume all env files, memory contents, and local files were readable while it ran.

## 2. Kill the credential kill-switch (if KMS mode is on)

If you configured `KMS_WRAPPED_MASTER_KEY`, stored credentials can be made permanently undecryptable everywhere — including for the attacker's exfiltrated copy:

1. AWS console → IAM → revoke/rotate the credential the app uses.
2. KMS → key policy → deny the app's principal (or disable the key).

After this, the attacker's DB dump is cryptographically dead. (Your own access dies too — that's the point; you re-create connections afterwards.)

## 3. Rotate everything the instance could see

| Secret | Action |
|---|---|
| DbBackup login password | Changed in step 1 |
| Backup encryption passphrase | Keep it — encrypted `.enc` backups stay safe; rotate later via Settings (old passphrase is retained in history) |
| Database credentials (all connections) | Rotate at the source (RDS/Postgres users) — the app stored them, assume leaked |
| SSH bastion keys | Rotate; move to fresh key files (`sshPrivateKeyPath`) |
| S3 / Google Drive tokens | Rotate AWS keys, revoke the Drive OAuth grant + refresh token, re-authorize |
| SMTP / Slack webhooks | Rotate |
| `JWT_*`, `ENCRYPTION_KEY*` secrets | Generate new; keep old `ENCRYPTION_KEY` as legacy so existing rows still decrypt (or fully re-key if you assume DB theft) |

## 4. Verify your backups are intact

- Activity Logs → look for unexpected `DELETE` / `RETENTION_*` / `PURGE` events.
- Backups page → spot-check recent backups: **Verify** a few, download one, confirm it decrypts.
- If you suspect backup tampering: encrypted backups are GCM-authenticated — a tampered `.enc` fails to decrypt, so successful verify/decrypt is strong evidence of integrity.
- Confirm off-provider copies (S3/Drive) still exist and match.

## 5. Recover

1. Rebuild the host from a clean image (if host compromise suspected).
2. Deploy fresh, `prisma migrate deploy`, restore the app DB (or start fresh).
3. Re-enter connection credentials (rotated ones), re-issue passkeys, re-enable alerts.
4. Re-check: heartbeat goes green, a test backup runs end-to-end, a restore drills successfully.

## 6. Post-incident

- Note timestamps + IOCs (IPs, user-agents from Activity Logs) for your records.
- If the root cause is a DbBackup code vulnerability, report it privately: see [SECURITY.md](SECURITY.md#-reporting-a-security-incident-or-vulnerability).
- Enable anything you skipped: KMS kill-switch mode, at-rest backup encryption, login alerts, heartbeat — they exist for exactly this day.
