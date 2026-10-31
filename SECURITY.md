# Security Policy

DbBackup takes security seriously and ships with a broad set of protections — but **security features are not a security guarantee, and the project carries no warranty or liability of any kind** (see [LICENSE](LICENSE) and [TERMS_OF_SERVICE.md](TERMS_OF_SERVICE.md)).

## Built-in protections

- AES-256-GCM encryption of all stored credentials, with versioned keys, rotation support, and optional **AWS KMS-wrapped master key** (kill-switch custody)
- Optional **at-rest encryption of backup files** (AES-256-GCM, passphrase-based, round-trip verified before the plaintext is deleted)
- SSH tunnel support for private databases, with server-side key-file mode (keys never stored in the app database)
- Passkey (WebAuthn) login, login failure lockout, 2-hour post-password-change cool-down
- Session management (view/revoke active sessions, device + IP tracking)
- Full audit logging of every sensitive action
- Email/Slack alerts: logins, failed logins, DB heartbeat down/recovery, storage thresholds
- Backup folder locked to owner-only permissions; downloads only via authenticated, ownership-checked endpoints
- No public URLs to backups (S3 / Google Drive)

## No guarantee

The authors are **not responsible for any breach, data loss, or damage** resulting from use of this software, even in connection with its security features. You are the operator of your own instance and remain responsible for your infrastructure, credentials, and data.

---

## 🔒 Reporting a security incident or vulnerability

**Please do not report security issues through public GitHub issues, discussions, or pull requests.**

### Preferred: GitHub Private Vulnerability Reporting

1. Go to the repository on GitHub: **https://github.com/hamzasgd/DbBackup**
2. Click the **Security** tab
3. Select **Report a vulnerability** (Private vulnerability reporting)
4. Fill in the template (see *What to include* below)

This reaches the maintainer privately and allows coordinated disclosure, credit, and a CVE if warranted.

### Alternative: email

Send reports to the maintainer's GitHub-listed contact email with the subject prefix **`[SECURITY] DbBackup`**. If you found this via a deployment you don't own, please also notify that instance's operator — DbBackup is self-hosted software; each instance has its own operator.

### What to include

- **Type of issue** (e.g., authentication bypass, SQL injection, path traversal, stored-XSS, secret exposure, SSRF, privilege escalation)
- **Affected component and version/commit** (`server`, `client`, a specific endpoint or file)
- **Step-by-step reproduction** — exact requests, payloads, or screenshots
- **Impact assessment** — what an attacker gains (data exposure? code execution? account takeover?)
- Any **proposed mitigation** (optional but welcome)
- Whether the issue is **publicly known / being actively exploited**, and any public references

### Scope

In scope: any vulnerability in this repository's code, dependencies shipped by it, default configuration, or the deployment flow documented in the README.

Out of scope (but still feel free to report misconfigurations you notice in deployments — to that deployment's operator):

- Vulnerabilities in your own deployment environment (host, nginx, database, third-party accounts)
- Attacks requiring full root access to a machine the operator controls (an attacker with root on the host can already read process memory — this is a known limit of any self-hosted design, documented in the README)
- Spam, social engineering, physical attacks, brute-forcing credentials you own
- Automated scanner output without a demonstrated, reproducible impact

### Safe harbor

Good-faith research — acting in the public interest, making reasonable efforts to avoid privacy violations, degradation of services, and data destruction — will not lead to legal action against you. We ask that you give us a reasonable window to remediate before any public disclosure (90 days is customary; we'll aim for faster).

### What to expect

- **Acknowledgement** within 7 days
- **Assessment & severity rating** (CVSS) within 14 days
- **Fix or mitigation** targeted within 30 days for high-severity issues (may vary for complex issues — we'll keep you updated)
- Coordinated public disclosure after a fix ships, with credit to the reporter unless you prefer anonymity

### Operators running an instance

If you *operate* a DbBackup instance and suspect a compromise of **your** deployment, follow the runbook: [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md).
