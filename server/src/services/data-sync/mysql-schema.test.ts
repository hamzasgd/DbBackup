import { describe, it, expect } from 'vitest';
import { assertAdditive } from './mysql-schema';

describe('assertAdditive (no statement that can lose data reaches the target)', () => {
  it('allows creating tables and adding columns, indexes and foreign keys', () => {
    expect(() => assertAdditive('CREATE TABLE IF NOT EXISTS `t` (`id` int NOT NULL, PRIMARY KEY (`id`))')).not.toThrow();
    expect(() => assertAdditive("ALTER TABLE `t` ADD COLUMN `a` varchar(30) NOT NULL DEFAULT 'x, DROP y' AFTER `id`, ADD KEY `k` (`a`,`id`)")).not.toThrow();
    expect(() => assertAdditive('ALTER TABLE `t` ADD CONSTRAINT `f` FOREIGN KEY (`p`) REFERENCES `parent` (`id`) ON DELETE CASCADE')).not.toThrow();
  });

  it('refuses anything that drops, changes or renames', () => {
    for (const sql of [
      'ALTER TABLE `t` DROP COLUMN `a`',
      'ALTER TABLE `t` MODIFY COLUMN `a` int',
      'ALTER TABLE `t` ADD COLUMN `b` int, DROP COLUMN `a`',
      'ALTER TABLE `t` ADD KEY `k` (`a`), MODIFY `a` int',
      'ALTER TABLE `t` RENAME TO `u`',
      'DROP TABLE `t`',
      'TRUNCATE TABLE `t`',
      'CREATE TABLE `t` (`id` int)',
      'ALTER TABLE `t` CHANGE `a` `b` int',
    ]) expect(() => assertAdditive(sql), sql).toThrow(/not purely additive/);
  });
});
