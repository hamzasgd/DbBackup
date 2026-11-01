<p align="center">
  <img src="client/public/favicon.svg" width="80" alt="DbBackup Logo" />
</p>

<h1 align="center">DbBackup</h1>

<p align="center">
  <strong>The agent-ready, self-hosted database backup platform.</strong><br/>
  Back up, restore and migrate MySQL, MariaDB and PostgreSQL — over SSH tunnels, encrypted at rest,<br/>
  monitored around the clock — and drive it all from your AI agent via built-in MCP.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Agent--ready-6E56CF?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=" />
  <img src="https://img.shields.io/badge/Passkeys-WebAuthn-3178C6" />
  <img src="https://img.shields.io/badge/Encryption-AES--256--GCM-2DD4BF" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" />
  <img src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" />
  <img src="https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma&logoColor=white" />
  <img src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white" />
</p>

---

## ⚠️ USE AT YOUR OWN RISK — NO WARRANTY, NO RESPONSIBILITY

> **This software is provided "AS IS" without warranty of any kind.** The authors are **NOT responsible — under any circumstances — for any data loss, data corruption, data leakage, failed backups, failed restores, broken databases, downtime, lost profits, or any other damage** arising from the use of this software. This includes situations involving the software's security features — see [TERMS_OF_SERVICE.md](TERMS_OF_SERVICE.md) (you accept these terms by using the software).
>
> **You are the operator.** DbBackup is self-hosted software that *you* deploy and manage. Before trusting it with production data:
> - **Never rely on it as your only backup** — keep an independent backup strategy.
> - **Verify backups and test restores** regularly (a backup you haven't restored is not a backup).
> - **Secure your own infrastructure** — server, encryption keys, and third-party accounts are your responsibility.
>
> The project takes security seriously (see [SECURITY.md](SECURITY.md)) — but security features **reduce** risk, they do **not** guarantee outcomes, and they create **no liability** for the authors. See the [LICENSE](LICENSE) for the full MIT disclaimer.
>
> 📄 Legal: [Terms of Service](TERMS_OF_SERVICE.md) · [Security Policy & vulnerability reporting](SECURITY.md) · [Incident response runbook](INCIDENT_RESPONSE.md) · [License](LICENSE)

---

## ✨ Features

### 🤖 AI Agents (MCP) — built in

- **Model Context Protocol server** at `/mcp` (Streamable HTTP, JSON-RPC 2.0) — connect Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Cline, Zed, Goose, ZCode, Kiro, Codex CLI, Gemini CLI or Trae
- **Scoped API keys** (`dbbk_mcp_…`, SHA-256-hashed at rest, shown once, instant revocation, optional expiry): **read ⊂ write ⊂ admin**, enforced per tool
- **Agent tools**: list connections, test connectivity, list/get backups, trigger backups, verify, heartbeat status, storage usage, activity log, delete (admin) — restore deliberately not exposed
- **Every call audited** (key, tool, outcome, duration, IP) with live usage tracking; ready-made per-agent config snippets with copy buttons in Settings → AI/MCP
- Rate-limited endpoint (120 req/min)

### Core

- **Multi-Engine Support** — MySQL, MariaDB, and PostgreSQL via native CLI tools (`mysqldump`, `mariadb-dump`, `pg_dump`, `pg_restore`)
- **Backup & Restore** — Multiple output formats: compressed SQL, plain SQL, custom (`.dump`), directory, and tar
- **Scheduled Backups** — Cron-based automation (hourly, daily, weekly, monthly, or custom cron expressions)
- **Cross-Engine Migration** — Migrate data between databases of different types (e.g., MySQL → PostgreSQL)
- **Data Export** — Export individual tables as JSON, CSV, or SQL
- **Retention Policies** — Age + "keep last N" rules per schedule, daily global sweep, and an on-demand **Purge Now** button
- **Safe Connection Deletion** — Delete a connection while keeping its backup history & files (or clean everything)

### Storage & Encryption

- **Local Disk** — Backups stored with owner-only (`0700`) permissions; never served publicly
- **Amazon S3 / S3-compatible** — AWS S3, DigitalOcean Spaces, MinIO, Backblaze B2, with a **bucket-privacy probe** on Test Connection (warns if the bucket is publicly accessible)
- **Google Drive** — OAuth refresh-token uploads into a `DbBackups` folder, quota-aware
- **🔐 Encrypted Backups at Rest** — Optional AES-256-GCM encryption (`.enc`) with a user passphrase. Plaintext is hashed, encrypted, **decrypted back and hash-verified before the plaintext is deleted** — a corrupt encrypted copy can never replace good data. Downloads/restores/verification decrypt transparently; passphrase rotation keeps old backups readable (history + current-passphrase confirmation)

### Monitoring & Alerts

- **DB Heartbeat** — Per-connection `SELECT 1` health checks every 5 minutes (SSH-tunnel aware) with uptime %, latency, 7-day history, and **down/recovery alerts**
- **Storage Threshold Alerts** — Email/Slack when local disk, Google Drive quota, or your S3 budget crosses a threshold (default 80%); live usage bars on the Storage page
- **Login Alerts** — Email/Slack on every sign-in and wrong-password attempt (device + IP)
- **Activity Logs** — Complete audit trail of every action: logins, connections, backups, restores, storage changes, passkeys, sessions — with IP and device
- **Real-Time Progress** — SSE for live backup/restore/migration progress
- **Backup Verification** — SHA-256 integrity checks with one-click verify

### Security & Access

- **Passkey (WebAuthn) Login** — Passwordless sign-in with Touch ID / Face ID / Windows Hello / security keys
- **Login Lockout** — 3 failed password attempts from one IP blocks that address for 15 minutes (tunable) with an email/Slack alert; a **cross-IP brute-force detector** catches VPN/proxy hopping (consolidated alert instead of a grief-able account lock) and per-attempt failure emails are throttled
- **Active Session Management** — See every logged-in device (browser, OS, IP, login time) and revoke individually or all at once
- **Password Change Lockdown** — Optional 2-hour sign-in cool-down after a password change (bank-style anti-takeover)
- **Credential Encryption** — All stored credentials and SSH keys encrypted with AES-256-GCM; versioned keys with rotation support
- **KMS Kill Switch** — Optional AWS KMS-wrapped master key: the encryption key **never touches the server disk**; revoking IAM/KMS makes stolen ciphertext permanently undecryptable
- **SSH Keys Out of the DB** — Reference a server-side key file instead of storing the PEM in the database
- **SSH Tunnels** — Connect to private databases through bastion hosts
- **JWT + refresh rotation**, **rate limiting**, **secret redaction in logs**, **Helmet/CORS**, **SSL/TLS enforcement**, **secure memory handling**

### Integrations

- **Email Notifications** — SMTP alerts on success, failure, retention, heartbeat, storage, and login events
- **Slack Notifications** — Webhook alerts for all of the above

### UI/UX

- **Responsive Dashboard** — Mobile-friendly layout with collapsible sidebar
- **Loading Skeletons** — Smooth loading states across all pages
- **Confirmation Dialogs** — Styled confirmation prompts for destructive actions

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, Vite 8, TypeScript, Tailwind CSS v4, React Router v7, Zustand, TanStack Query, React Hook Form, Zod, Lucide Icons |
| **Backend** | Node.js, Express.js 4, TypeScript, tsx (dev) |
| **Database** | PostgreSQL 16 via Prisma ORM 5 |
| **Queue** | BullMQ 6 + Redis 7 (via ioredis 6) |
| **Auth** | JWT (access + refresh tokens), bcryptjs, WebAuthn passkeys (@simplewebauthn) |
| **Encryption** | AES-256-GCM (Node.js `crypto`), Key Manager with rotation support, Cloud KMS providers (AWS, Azure, GCP, Vault) |
| **SSH** | ssh2 library |
| **Storage** | Local filesystem + AWS S3 SDK v3 + Google Drive (REST) |
| **Notifications** | Nodemailer (SMTP) + Slack webhooks |
| **Logging** | Winston + Morgan |

---

## 📁 Project Structure

```
DbBackup/
├── package.json                # npm workspaces root
├── docker-compose.yml          # PostgreSQL 16 + Redis 7
│
├── client/                     # React + Vite frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/         # Sidebar, DashboardLayout, ProtectedRoute
│   │   │   └── ui/             # Button, Card, Modal, Badge, Input, Select, Skeleton, ConfirmDialog, Toaster
│   │   ├── pages/
│   │   │   ├── auth/           # Login, Register
│   │   │   ├── dashboard/      # Dashboard overview
│   │   │   ├── connections/    # Manage database connections
│   │   │   ├── backups/        # Backup list, trigger, verify, download
│   │   │   ├── schedules/      # Scheduled backup management
│   │   │   ├── migrations/     # Cross-engine migration (modular components)
│   │   │   └── settings/       # Notifications, Storage, Retention, Audit
│   │   ├── services/           # API service layer (axios)
│   │   ├── hooks/              # useProgressSSE (SSE hook)
│   │   ├── store/              # Zustand stores (auth, toast)
│   │   └── lib/                # Axios client (with refresh queue), cn(), formatBytes, etc.
│   └── public/                 # Static assets (favicon, icons)
│
└── server/                     # Express.js backend
    ├── prisma/
    │   └── schema.prisma       # User, Connection, Backup, Schedule, Migration, AuditLog, CredentialAccessLog
    └── src/
        ├── controllers/        # Auth, Backup, Connection, Export, Migration, Notification, Restore, Schedule, SSE, Storage
        ├── services/
        │   ├── engines/        # MySQL, MariaDB, PostgreSQL engine adapters + ConnectionFactory
        │   ├── crypto/         # Key rotation, CryptoProvider interface, KMS providers (AWS, Azure, GCP, Vault)
        │   ├── migrations/     # Modular: executors, schema builder, type mapper
        │   ├── security/      # Credential audit, rate limiting, secure credentials, connection validator
        │   ├── sync/           # CDC trackers, conflict resolver, sync types
        │   ├── crypto.service.ts
        │   ├── ssh.service.ts
        │   ├── token.service.ts
        │   ├── notification.service.ts
        │   ├── storage.service.ts
        │   ├── retention.service.ts
        │   ├── sse.service.ts
        │   ├── export.service.ts
        │   ├── migration.service.ts
        │   └── verification.service.ts
        ├── routes/             # Express route definitions
        ├── middleware/         # Auth guard, error handler, rate limiters, 404
        ├── queue/              # BullMQ queues & workers
        │   ├── backup.queue.ts
        │   ├── migration.queue.ts
        │   ├── schedule.queue.ts
        │   └── sync/          # Modular sync queue (handlers, validation, sanitation, execution, utils)
        └── config/             # Prisma client, Redis, Winston logger
```

---

## 📋 Prerequisites

- **Node.js** ≥ 18
- **Docker** & **Docker Compose** (for PostgreSQL and Redis)
- **Database CLI tools** installed on the host:
  - MySQL / MariaDB: `mysqldump`, `mysql`, `mariadb-dump`, `mariadb`
  - PostgreSQL: `pg_dump`, `pg_restore`, `psql`
  - Cross-Engine Migrations: `pgloader` (required for MySQL to PostgreSQL migrations)

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/hamzasgd/DbBackup.git
cd DbBackup
```

### 2. Start infrastructure

```bash
docker compose up -d
```

This starts **PostgreSQL** on port `5433` and **Redis** on port `6379`.

> **Note:** Port `5433` is used to avoid conflicts with a local PostgreSQL on `5432`. Change it in `docker-compose.yml` if needed.

### 3. Install dependencies

```bash
npm run install:all
```

### 4. Configure environment

```bash
cp server/.env.example server/.env
```

Edit `server/.env` with your values:

```env
DATABASE_URL="postgresql://dbbackup:dbbackup_secret@localhost:5433/dbbackup?schema=public"
JWT_ACCESS_SECRET=<random-string>
JWT_REFRESH_SECRET=<different-random-string>
ENCRYPTION_KEY=<64-hex-char-string>
```

> **Generate secrets:**
> ```bash
> openssl rand -hex 32
> ```

### 5. Run database migrations

```bash
cd server
npx prisma migrate dev
npx prisma generate
cd ..
```

### 6. Start the application

```bash
npm run dev
```

This starts both the API server and the React frontend concurrently.

| Service | URL |
|---|---|
| **Frontend** | http://localhost:5173 |
| **API** | http://localhost:3001/api |
| **Prisma Studio** | `cd server && npx prisma studio` |

### 7. Create your account

Open http://localhost:5173 and register your first user.

---

## 🗄️ Supported Backup Formats

| Engine | Format | Extension | CLI Tool |
|---|---|---|---|
| MySQL / MariaDB | Compressed SQL | `.sql.gz` | `mysqldump` / `mariadb-dump` |
| MySQL / MariaDB | Plain SQL | `.sql` | `mysqldump` / `mariadb-dump` |
| PostgreSQL | Compressed SQL | `.sql.gz` | `pg_dump` + gzip |
| PostgreSQL | Plain SQL | `.sql` | `pg_dump` |
| PostgreSQL | Custom | `.dump` | `pg_dump -Fc` |
| PostgreSQL | Tar | `.tar` | `pg_dump -Ft` |
| PostgreSQL | Directory | folder | `pg_dump -Fd` (parallel) |

---

## ⚙️ Environment Variables

Key variables (full annotated list in [`server/.env.example`](server/.env.example)):

| Variable | Description | Default |
|---|---|---|
| `PORT` | API server port | `3001` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Token signing secrets | — |
| `ENCRYPTION_KEY` | Legacy encryption key (still decrypts existing rows) | — |
| `ENCRYPTION_KEY_PRIMARY` + `ENCRYPTION_KEY_V1...` | Versioned keys for rotation | — |
| `KMS_WRAPPED_MASTER_KEY` | **Kill-switch mode**: master key wrapped by AWS KMS, unwrapped in memory at boot — never on disk | — |
| `AWS_KMS_KEY_ID` / `AWS_REGION` | KMS settings for the above | — |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis (queues) | `localhost:6379` |
| `BACKUP_STORAGE_PATH` | Local backup dir — keep it **outside the web root**, `0700` (enforced by the app) | `./backups` |
| `HEARTBEAT_INTERVAL_MINUTES` | DB heartbeat check interval | `5` |
| `STORAGE_ALERT_THRESHOLD_PERCENT` | Storage usage alert threshold | `80` |
| `S3_STORAGE_BUDGET_GB` | S3 budget for threshold alerts (S3 has no quota) | — |
| `PASSWORD_CHANGE_LOCKDOWN_HOURS` | Sign-in lock after password change (`0` disables) | `2` |
| `PASSKEY_RP_ID` / `PASSKEY_EXTRA_ORIGINS` | WebAuthn relying-party config (auto-derived if unset) | — |
| `DEFAULT_RETENTION_DAYS` / `DEFAULT_RETENTION_COUNT` | Fallback retention for schedule-less connections | `30` / off |
| `RETENTION_SWEEP_CRON` | Daily global retention sweep | `30 3 * * *` |
| `CLIENT_URL` | Frontend URL (CORS) | `http://localhost:5173` |

> Storage backends (S3 / Google Drive), notification channels, and the **backup encryption passphrase** are configured in the app's Settings UI — not env vars — and are stored encrypted in the database.

---

## 🔐 Security & Data Safety — read this before production

1. **Backup encryption is passphrase-based.** If you lose the passphrase *and* the app database, encrypted backups are **unrecoverable by design**. Keep an offline copy of the passphrase.
2. **Never rely on DbBackup as your only backup.** Keep an independent copy of critical data and periodically test restores.
3. **KMS kill switch** protects *credentials*: if the KMS key/IAM is revoked, stored credentials cannot be decrypted anywhere — but backup files encrypted with your passphrase remain recoverable with the passphrase.
4. **Lock down the host**: backups directory must never be web-accessible (see the nginx notes in `.env.example`), and the backup encryption passphrase should differ from your login password.

Despite all of this, **security features reduce risk — they do not guarantee outcomes, and they create no liability for the authors.** See [TERMS_OF_SERVICE.md](TERMS_OF_SERVICE.md) and [SECURITY.md](SECURITY.md).

### Securing your environment file (.env)

An env file always holds *some* plaintext bootstrap secrets — that's unavoidable — but you can shrink the blast radius:

1. **Permissions & ownership** — only the app user may read it:
   ```bash
   chmod 600 /www/wwwroot/dbbackup.hamza.codes/DbBackup/server/.env
   chown <app-user>:<app-user> .../.env
   ```
   The app audits this at boot and warns in the logs when the file is group/world readable.
2. **Fewer secrets in the file** — `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` are **optional**: when unset they are derived from the master encryption key. Delete those two lines from `.env` (note: existing sessions re-login once after the switch).
3. **Master key off the disk** — set up the KMS kill switch (`KMS_WRAPPED_MASTER_KEY`, see `server/.env.example`): the credential-encryption master key lives only in AWS KMS and process memory. With JWT secrets derived from it, a stolen `.env` + stolen database no longer decrypt anything.
4. **What still must stay in `.env`**: the app's own `DATABASE_URL` (Postgres for DbBackup), Redis, port — treat the server itself as the perimeter for these; rotate them in [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) if in doubt.
5. **Never commit it** (already gitignored), never copy it into backups/notes, and avoid editing it over unencrypted channels.

---

## 📡 API Endpoints

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Create a new account |
| `POST` | `/api/auth/login` | Login and receive tokens |
| `POST` | `/api/auth/logout` | Revoke refresh token |
| `POST` | `/api/auth/refresh` | Refresh access token |
| `GET` | `/api/auth/me` | Get current user |
| `POST` | `/api/auth/change-password` | Change password (starts the sign-in cool-down) |
| `GET` | `/api/auth/sessions` | List active sessions (device, IP, login time) |
| `DELETE` | `/api/auth/sessions/:id` | Revoke one session |
| `DELETE` | `/api/auth/sessions` | Revoke all sessions (log out everywhere) |
| `GET` | `/api/auth/passkey/list` | List registered passkeys |
| `POST` | `/api/auth/passkey/register/options` + `/verify` | Register a passkey |
| `DELETE` | `/api/auth/passkey/:id` | Remove a passkey |
| `POST` | `/api/auth/passkey/login/options` + `/verify` | Passwordless passkey login |

### Connections

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/connections` | List all connections |
| `POST` | `/api/connections` | Create a new connection |
| `PUT` | `/api/connections/:id` | Update a connection |
| `DELETE` | `/api/connections/:id` | Delete a connection |
| `POST` | `/api/connections/:id/test` | Test connection |
| `GET` | `/api/connections/:id/info` | Get database schema info |

### Backups

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/backups` | List all backups |
| `POST` | `/api/backups` | Trigger a manual backup |
| `GET` | `/api/backups/:id/progress` | Backup progress (SSE) |
| `POST` | `/api/backups/:id/verify` | Verify backup integrity (works for S3-stored backups too) |
| `GET` | `/api/backups/:id/download` | Download backup file (streams from S3 if needed) |
| `DELETE` | `/api/backups/:id` | Delete a backup (removes the S3 object too) |

### Restores

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/restore` | Queue a restore job — returns `202` with a `jobId` |
| `GET` | `/api/restore/:jobId/progress` | Restore progress (SSE) |

### Schedules

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/schedules` | List all schedules |
| `POST` | `/api/schedules` | Create a schedule |
| `PUT` | `/api/schedules/:id` | Update a schedule |
| `DELETE` | `/api/schedules/:id` | Delete a schedule |

### Migrations

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/migrations` | List all migrations |
| `POST` | `/api/migrations` | Start a migration |
| `GET` | `/api/migrations/:id` | Get migration details |
| `GET` | `/api/migrations/:id/progress` | Get migration progress (SSE) |
| `POST` | `/api/migrations/:id/verify` | Verify migration results |
| `DELETE` | `/api/migrations/:id` | Delete a migration |

### Exports

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/connections/:id/export` | Export a table (JSON, CSV, or SQL) |

### Settings & Other

| Method | Endpoint | Description |
|---|---|---|
| `GET/PUT` | `/api/notifications` | Notification settings |
| `POST` | `/api/notifications/test` | Send test notification |
| `GET/PUT` | `/api/storage` | Storage settings (S3 / Google Drive / backup encryption passphrase) |
| `POST` | `/api/storage/test` | Test storage connection (+ S3 bucket privacy probe) |
| `GET` | `/api/storage/usage` | Local / Drive / S3 usage vs threshold |
| `GET` | `/api/audit` | Activity log (filter by action / resource / date) |
| `GET` | `/api/connections/:id/heartbeat` | Heartbeat status, uptime %, history |

---

## 🔄 Updating an existing deployment

```bash
git pull
npm run install:all          # new dependencies (e.g. @simplewebauthn, @aws-sdk/client-kms)
npm run build                # client + server
cd server && npx prisma migrate deploy   # apply pending migrations (required)
# restart the process (pm2 / panel) — queue workers register at boot
```

Backwards compatibility: existing connections, backups, and unencrypted backups keep working; legacy encryption keys still decrypt existing rows; unencrypted backups remain readable alongside encrypted ones.

> After deploying behind nginx, set `PASSKEY_RP_ID` (and ideally forward `Host` / `X-Forwarded-*` headers) — see [SECURITY.md](SECURITY.md) and `server/.env.example`.

---

## 🐳 Docker Services

| Service | Image | Host Port | Container Port |
|---|---|---|---|
| PostgreSQL | `postgres:16-alpine` | `5433` | `5432` |
| Redis | `redis:7-alpine` | `6379` | `6379` |

Both services include health checks and persistent Docker volumes.

---

## 📝 Scripts

### Root

| Command | Description |
|---|---|
| `npm run dev` | Start server + client concurrently |
| `npm run build` | Build server + client for production |
| `npm run install:all` | Install all workspace dependencies |

### Server (`cd server`)

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with tsx watch |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled server |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run prisma:migrate` | Run database migrations |
| `npm run prisma:studio` | Open Prisma Studio |

### Client (`cd client`)

| Command | Description |
|---|---|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
