import { pgAdmin, myAdmin } from './helpers';

/** Number of rows in the big tables: above the 5000-row export/fetch batch so paging is exercised. */
export const BIG = 12_000;

/**
 * Postgres fixture: enum type, serial + identity columns, FK, arrays, jsonb,
 * bytea, numeric, timestamptz, a mixed-case table and column, a second schema,
 * a view, a function and a trigger. Text contains quotes, backslashes,
 * newlines, tabs, commas and non-ASCII characters.
 */
export async function seedPostgres(database: string): Promise<void> {
  await pgAdmin(database, async (c) => {
    await c.query(`
      CREATE TYPE mood AS ENUM ('happy', 'sad', 'meh');
      CREATE TABLE customers (
        id serial PRIMARY KEY,
        name text NOT NULL,
        email text UNIQUE,
        mood mood,
        tags text[],
        profile jsonb,
        avatar bytea,
        balance numeric(12,2),
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z'
      );
      CREATE TABLE orders (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        customer_id int NOT NULL REFERENCES customers(id),
        note text,
        total double precision
      );
      CREATE INDEX orders_customer_idx ON orders (customer_id);
      CREATE TABLE "Weird Table" ("Mixed Col" text, "quote""d" int);
      CREATE SCHEMA reporting;
      CREATE TABLE reporting.daily (day date PRIMARY KEY, revenue numeric);
      CREATE VIEW big_spenders AS SELECT c.name, sum(o.total) AS spent FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name;
      CREATE FUNCTION touch_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := coalesce(NEW.note, 'auto'); RETURN NEW; END $$;
      CREATE TRIGGER orders_touch BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION touch_note();
    `);
    await c.query(`
      INSERT INTO customers (name, email, mood, tags, profile, avatar, balance, active)
      SELECT
        CASE i % 5
          WHEN 0 THEN 'O''Brien "quoted" #' || i
          WHEN 1 THEN E'line one\\nline two\\t#' || i
          WHEN 2 THEN 'back\\slash, comma #' || i
          WHEN 3 THEN 'Ünïcødé 名前 😀 #' || i
          ELSE 'plain #' || i END,
        CASE WHEN i % 7 = 0 THEN NULL ELSE 'user' || i || '@example.com' END,
        (ARRAY['happy','sad','meh']::mood[])[1 + i % 3],
        CASE WHEN i % 4 = 0 THEN NULL ELSE ARRAY['a,b', 'c"d', 'x' || i] END,
        jsonb_build_object('i', i, 'nested', jsonb_build_object('k', 'v"' || i), 'list', jsonb_build_array(1, 'two', null)),
        CASE WHEN i % 3 = 0 THEN NULL ELSE decode(md5(i::text), 'hex') END,
        (i * 1.25)::numeric(12,2),
        i % 2 = 0
      FROM generate_series(1, ${BIG}) AS i;
      INSERT INTO orders (customer_id, note, total)
      SELECT 1 + (i % ${BIG}), CASE WHEN i % 2 = 0 THEN NULL ELSE 'note ' || i END, i / 3.0 FROM generate_series(1, ${BIG}) AS i;
      INSERT INTO "Weird Table" VALUES ('x', 1), (NULL, NULL), ('it''s', -5);
      INSERT INTO reporting.daily SELECT DATE '2026-01-01' + i, i * 10 FROM generate_series(0, 30) AS i;
    `);
  });
}

/** MariaDB fixture: utf8mb4 text, BLOB, JSON, DECIMAL, DATETIME(6), FK, auto-increment, a trigger and a procedure. */
export async function seedMariaDB(database: string): Promise<void> {
  await myAdmin(async (c) => {
    await c.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await c.query(`USE \`${database}\``);
    await c.query(`
      CREATE TABLE customers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        email VARCHAR(200) UNIQUE,
        profile JSON,
        avatar BLOB,
        balance DECIMAL(12,2),
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT '2026-01-01 00:00:00.000000'
      ) ENGINE=InnoDB;
      CREATE TABLE orders (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        customer_id INT NOT NULL,
        note TEXT,
        total DOUBLE,
        CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
      ) ENGINE=InnoDB;
      CREATE PROCEDURE customer_count() SELECT COUNT(*) FROM customers;
    `);
    await c.query(`
      INSERT INTO customers (name, email, profile, avatar, balance, active)
      SELECT
        CASE seq % 5
          WHEN 0 THEN CONCAT('O''Brien "quoted" #', seq)
          WHEN 1 THEN CONCAT('line one\\nline two\\t#', seq)
          WHEN 2 THEN CONCAT('back\\\\slash, comma #', seq)
          WHEN 3 THEN CONCAT('Ünïcødé 名前 😀 #', seq)
          ELSE CONCAT('plain #', seq) END,
        IF(seq % 7 = 0, NULL, CONCAT('user', seq, '@example.com')),
        JSON_OBJECT('i', seq, 'nested', JSON_OBJECT('k', CONCAT('v"', seq))),
        IF(seq % 3 = 0, NULL, UNHEX(MD5(seq))),
        seq * 1.25,
        seq % 2
      FROM seq_1_to_${BIG};
      INSERT INTO orders (customer_id, note, total)
      SELECT 1 + (seq % ${BIG}), IF(seq % 2 = 0, NULL, CONCAT('note ', seq)), seq / 3 FROM seq_1_to_${BIG};
    `);
    // Created after the bulk insert: MariaDB rejects INSERT ... SELECT into a NOT NULL
    // column of a table with a BEFORE INSERT trigger ("cannot be null") in this form.
    await c.query("CREATE TRIGGER orders_touch BEFORE INSERT ON orders FOR EACH ROW SET NEW.note = COALESCE(NEW.note, 'auto')");
  });
}
