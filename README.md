# DbBackup — SaaS Database Backup & Restore

A self-hosted SaaS tool for managing, scheduling, and restoring database backups across MySQL, MariaDB, and PostgreSQL — with SSH tunnel support, AES-256-GCM encrypted credentials, and a BullMQ job queue.

---

## Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19 + Vite, TypeScript, Tailwind CSS v4, Zustand, React Query, React Router v6 |
| **Backend** | Node.js, Express.js, TypeScript, tsx |
| **App DB** | PostgreSQL via Prisma ORM |
| **Queue** | BullMQ + Redis |
| **Auth** | JWT (15m access + 7d refresh tokens), bcryptjs |
| **Encryption** | AES-256-GCM with PBKDF2 key derivation |
| **SSH Tunnels** | ssh2 library |
| **Backup Engines** | mysqldump / mariadb-dump / pg_dump (native CLI tools) |

---

## Prerequisites

- **Node.js** ≥ 18
- **Docker + Docker Compose** (for PostgreSQL + Redis)
- **Native DB tools** on the server running backups:
  - MySQL/MariaDB: `mysqldump`, `mysql`, `mariadb-dump`
  - PostgreSQL: `pg_dump`, `pg_restore`, `psql`

---

## Quick Start

### 1. Clone & install dependencies

```bash
git clone <repo-url>
cd DbBackup
npm install               # root (installs concurrently)
cd server && npm install
cd ../client && npm install
```

### 2. Start infrastructure (PostgreSQL + Redis)

```bash
docker compose up -d postgres redis
```

> **Note for macOS users:** If port 5432 is taken by a local Postgres, the Docker container is mapped to **port 5433** automatically. The DATABASE_URL in `.env` already uses `5433`.

### 3. Configure environment

```bash
cd server
cp .env.example .env
```

Edit `server/.env`:

```env
DATABASE_URL="postgresql://dbbackup:dbbackup_secret@localhost:5433/dbbackup?schema=public"
JWT_ACCESS_SECRET=<generate with: openssl rand -hex 32>
JWT_REFRESH_SECRET=<generate with: openssl rand -hex 32>
ENCRYPTION_KEY=<64 hex chars: openssl rand -hex 32>
```

### 4. Run database migrations

```bash
cd server
npx prisma migrate dev --name init
```

### 5. Start dev servers

```bash
# From the root — starts both server (port 3001) and client (port 5173) together
npm run dev

# Or individually:
cd server && npm run dev   # API on http://localhost:3001
cd client && npm run dev   # UI  on http://localhost:5173
```

Open **http://localhost:5173** — you'll be redirected to `/login` on first visit.

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Express server port | `3001` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `JWT_ACCESS_SECRET` | Secret for signing access tokens | — |
| `JWT_REFRESH_SECRET` | Secret for signing refresh tokens | — |
| `JWT_ACCESS_EXPIRES_IN` | Access token TTL | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL | `7d` |
| `ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM | — |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password (optional) | — |
| `BACKUP_STORAGE_PATH` | Local path for backup files | `./backups` |

---

## Project Structure

```
DbBackup/
├── docker-compose.yml        # PostgreSQL + Redis
├── package.json              # Root workspace (concurrently)
├── client/                   # React + Vite frontend
│   └── src/
│       ├── pages/            # LoginPage, Dashboard, Connections, Backups, Schedules, Settings
│       ├── components/       # UI components (Button, Modal, etc.) + layout
│       ├── services/         # API service layer (axios)
│       ├── store/            # Zustand stores (auth, toast)
│       └── lib/              # api.ts (axios instance + auto-refresh), utils.ts
└── server/                   # Express API
    ├── prisma/
    │   └── schema.prisma     # User, Connection, Backup, Schedule, AuditLog models
    └── src/
        ├── controllers/      # auth, connection, backup, restore, schedule
        ├── routes/           # Express routers
        ├── services/
        │   ├── crypto.service.ts   # AES-256-GCM encryption
        │   ├── ssh.service.ts      # SSH tunnel via ssh2
        │   ├── token.service.ts    # JWT helpers
        │   └── engines/            # MySQL, MariaDB, PostgreSQL backup engines
        ├── queue/            # BullMQ backup + schedule workers
        ├── middleware/       # auth, error handler, 404
        └── config/           # Prisma, Redis, Winston logger
```

---

## Features

- 🔐 **Auth** — Register, login, logout, JWT refresh, change password
- 🔗 **Connections** — Add MySQL, MariaDB, PostgreSQL connections with optional SSH tunnel; credentials encrypted at rest
- 💾 **Backups** — Trigger manual backups, view history, download backup files, delete backups
- ⏰ **Schedules** — Cron-based automatic backups (hourly, daily, weekly, monthly, custom)
- 🔄 **Restore** — Restore a backup to any compatible connection
- 📋 **Audit Log** — Track all user and system actions
- 🛡️ **Security** — AES-256-GCM with PBKDF2, all DB credentials and SSH keys encrypted before storage

---

## API Routes

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login, get tokens |
| POST | `/api/auth/logout` | Revoke refresh token |
| POST | `/api/auth/refresh` | Refresh access token |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/change-password` | Change password |
| GET | `/api/connections` | List connections |
| POST | `/api/connections` | Create connection |
| PUT | `/api/connections/:id` | Update connection |
| DELETE | `/api/connections/:id` | Delete connection |
| POST | `/api/connections/:id/test` | Test connection |
| GET | `/api/backups` | List backups |
| POST | `/api/backups` | Trigger backup |
| DELETE | `/api/backups/:id` | Delete backup |
| GET | `/api/backups/:id/download` | Download backup file |
| POST | `/api/restore` | Restore a backup |
| GET | `/api/schedules` | List schedules |
| POST | `/api/schedules` | Create schedule |
| PUT | `/api/schedules/:id` | Update schedule |
| DELETE | `/api/schedules/:id` | Delete schedule |
| GET | `/api/audit` | View audit log |

---

## Docker Compose Port Mapping

| Service | Host Port | Notes |
|---|---|---|
| PostgreSQL | 5433 | Mapped to 5433 to avoid conflict with local Postgres on 5432 |
| Redis | 6379 | Standard port |

To use the default 5432, change `5433:5432` → `5432:5432` in `docker-compose.yml` and update `DATABASE_URL`.
