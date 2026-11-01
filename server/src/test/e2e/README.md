# End-to-end tests

These tests run the real engines against real databases with the real CLI
tools: every backup format is restored into a fresh database and compared row
by row with the source. They also cover TLS verification, SSH tunnels with
host-key pinning, migrations, table export, refresh tokens and `/health`.

```bash
cd server
npm run test:e2e
```

Each suite is **skipped** unless its variable is set, so you can run only what
you have. Every test creates its own uniquely named databases and drops them
afterwards; still, point these at **disposable test servers only**.

| Variable | Example | Used by |
|---|---|---|
| `E2E_POSTGRES_URL` | `postgresql://postgres:pw@localhost:5432/postgres` | PostgreSQL backup/restore, migration, export, TLS, SSH |
| `E2E_MARIADB_URL` | `mysql://root:pw@localhost:3306` | MariaDB/MySQL backup/restore, migration, export, TLS |
| `E2E_MONGODB_URL` | `mongodb://user:pw@127.0.0.1:27017` | MongoDB (server with `--auth`; the user is created through the localhost exception if missing) |
| `E2E_REDIS_URL` | `redis://:pw@127.0.0.1:6380` | Redis RDB backup (the database is **flushed**) |
| `E2E_TLS_CA_FILE`, `E2E_TLS_WRONG_CA_FILE` | `certs/ca.crt`, `certs/other-ca.crt` | TLS suite. The Postgres and MariaDB servers must use a certificate from `E2E_TLS_CA_FILE` with **only `DNS:localhost`** in its SAN (no IP), so connecting by `127.0.0.1`/`127.0.0.2` must fail name verification. |
| `E2E_APP_DATABASE_URL` | `postgresql://postgres:pw@127.0.0.1:5432/dbbackup_e2e_app` | SSH, app suites (migrations are applied automatically) |
| `REDIS_HOST`, `REDIS_PORT` | `127.0.0.1`, `6379` | app suite (queues) |
| `ENCRYPTION_KEY` | 64 hex characters | app and SSH suites |

Required on `PATH`: `psql`, `pg_dump`, `pg_restore`, `mysql`, `mysqldump`,
`mariadb-dump`, `mongodump`, `mongorestore`, `redis-cli`.

The tests were last run against PostgreSQL 17.5, MariaDB 11.4 (whose client
also provides `mysql`/`mysqldump`), MongoDB 8.0 with Database Tools 100.10,
and Redis 7.2.
