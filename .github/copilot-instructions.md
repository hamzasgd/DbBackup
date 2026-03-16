# DbBackup — Copilot Instructions

## Project Overview
DbBackup is a SaaS web app for database backup and restore using native CLI tools (mysqldump, pg_dump, etc.)

## Stack
- **Frontend**: React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui, React Router v6
- **Backend**: Node.js, Express.js, TypeScript
- **Database**: PostgreSQL via Prisma ORM
- **Auth**: JWT (access + refresh tokens), bcrypt
- **Queue**: BullMQ + Redis
- **Backup Tools**: mysqldump, mariadb-dump, pg_dump (native CLI)
- **SSH Tunnels**: ssh2 library
- **Encryption**: Node.js crypto (AES-256-GCM)

## Structure
- `/client` — React frontend (Vite)
- `/server` — Express.js backend

## Supported Databases
- MySQL (mysqldump / mysql)
- MariaDB (mariadb-dump / mariadb)
- PostgreSQL (pg_dump / pg_restore)
