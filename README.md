<p align="center">
  <img src="client/public/favicon.svg" width="80" alt="DbBackup Logo" />
</p>

<h1 align="center">DbBackup</h1>

<p align="center">
  A self-hosted web application for database backup, restore, and migration — powered by native CLI tools.
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

## ✨ Features

### Core

- **Multi-Engine Support** — MySQL, MariaDB, and PostgreSQL via native CLI tools (`mysqldump`, `mariadb-dump`, `pg_dump`, `pg_restore`)
- **Backup & Restore** — Multiple output formats: compressed SQL, plain SQL, custom (`.dump`), directory, and tar
- **Scheduled Backups** — Cron-based automation (hourly, daily, weekly, monthly, or custom cron expressions)
- **Cross-Engine Migration** — Migrate data between databases of different types (e.g., MySQL → PostgreSQL)
- **Data Export** — Export individual tables as JSON, CSV, or SQL

### Reliability & Monitoring

- **Real-Time Progress** — Server-Sent Events (SSE) for live backup and migration progress
- **Backup Verification** — SHA-256 integrity checks with one-click verify
- **Retention Policies** — Automatic cleanup of old backups based on configurable age rules
- **Audit Log** — Full activity trail for all user and system operations

### Security

- **JWT Authentication** — Access + refresh token rotation with race-condition-safe refresh
- **Encryption at Rest** — AES-256-GCM encryption for all stored credentials and SSH keys
- **SSH Tunnels** — Connect to remote databases through SSH bastion hosts
- **Rate Limiting** — Brute-force protection on auth endpoints
- **Helmet & CORS** — Standard Express security hardening

### Integrations

- **S3-Compatible Storage** — Upload backups to AWS S3, DigitalOcean Spaces, MinIO, Backblaze B2, etc.
- **Email Notifications** — SMTP alerts on backup success, failure, and retention events
- **Slack Notifications** — Webhook-based alerts to Slack channels

### UI/UX

- **Responsive Dashboard** — Mobile-friendly layout with collapsible sidebar
- **Loading Skeletons** — Smooth loading states across all pages
- **Confirmation Dialogs** — Styled confirmation prompts for destructive actions
- **Dark-Ready Components** — Built with shadcn/ui primitives

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, Vite 8, TypeScript, Tailwind CSS v4, React Router v7, Zustand, TanStack Query, React Hook Form, Zod, Lucide Icons |
| **Backend** | Node.js, Express.js 4, TypeScript, tsx (dev) |
| **Database** | PostgreSQL 16 via Prisma ORM 5 |
| **Queue** | BullMQ 5 + Redis 7 (via ioredis) |
| **Auth** | JWT (access + refresh tokens), bcryptjs |
| **Encryption** | AES-256-GCM (Node.js `crypto`) |
| **SSH** | ssh2 library |
| **Storage** | Local filesystem + AWS S3 SDK v3 |
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
│   │   │   ├── migrations/     # Cross-engine migration
│   │   │   └── settings/       # Notifications, Storage, Retention, Audit
│   │   ├── services/           # API service layer (axios)
│   │   ├── hooks/              # useProgressSSE (SSE hook)
│   │   ├── store/              # Zustand stores (auth, toast)
│   │   └── lib/                # Axios client (with refresh queue), cn(), formatBytes, etc.
│   └── public/                 # Static assets (favicon, icons)
│
└── server/                     # Express.js backend
    ├── prisma/
    │   └── schema.prisma       # User, Connection, Backup, Schedule, Migration, AuditLog, etc.
    └── src/
        ├── controllers/        # Auth, Backup, Connection, Export, Migration, Notification, Restore, Schedule, SSE, Storage
        ├── services/
        │   ├── engines/        # MySQL, MariaDB, PostgreSQL engine adapters
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
        ├── middleware/         # Auth guard, error handler, 404
        ├── queue/              # BullMQ queues & workers (backup, migration, schedule)
        └── config/             # Prisma client, Redis, Winston logger
```

---

## 📋 Prerequisites

- **Node.js** ≥ 18
- **Docker** & **Docker Compose** (for PostgreSQL and Redis)
- **Database CLI tools** installed on the host:
  - MySQL / MariaDB: `mysqldump`, `mysql`, `mariadb-dump`, `mariadb`
  - PostgreSQL: `pg_dump`, `pg_restore`, `psql`

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

| Variable | Description | Default |
|---|---|---|
| `PORT` | API server port | `5000` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `JWT_ACCESS_SECRET` | Secret for signing access tokens | — |
| `JWT_REFRESH_SECRET` | Secret for signing refresh tokens | — |
| `JWT_ACCESS_EXPIRES_IN` | Access token TTL | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL | `7d` |
| `ENCRYPTION_KEY` | AES-256 encryption key (64 hex characters) | — |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password | — |
| `BACKUP_STORAGE_PATH` | Local backup directory | `./backups` |
| `STORAGE_TYPE` | Storage backend (`local` or `s3`) | `local` |
| `CLIENT_URL` | Frontend URL (for CORS) | `http://localhost:5173` |
| `S3_BUCKET` | S3 bucket name | — |
| `S3_REGION` | S3 region | — |
| `S3_ACCESS_KEY` | S3 access key ID | — |
| `S3_SECRET_KEY` | S3 secret access key | — |
| `S3_ENDPOINT` | Custom S3 endpoint (for MinIO, DO Spaces, etc.) | — |

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
| `POST` | `/api/auth/change-password` | Change password |

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
| `POST` | `/api/backups/trigger` | Trigger a manual backup |
| `POST` | `/api/backups/:id/verify` | Verify backup integrity |
| `GET` | `/api/backups/:id/download` | Download backup file |
| `DELETE` | `/api/backups/:id` | Delete a backup |

### Restores

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/restore` | Restore a backup to a connection |

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

### Exports

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/connections/:id/export` | Export a table (JSON, CSV, or SQL) |

### Settings & Other

| Method | Endpoint | Description |
|---|---|---|
| `GET/PUT` | `/api/notifications/settings` | Notification settings |
| `POST` | `/api/notifications/test` | Send test notification |
| `GET/PUT` | `/api/storage/settings` | Storage settings |
| `GET` | `/api/audit` | View audit log |

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
