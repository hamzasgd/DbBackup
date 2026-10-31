import { BaseEngine, ConnectionConfig } from './base.engine';
import { MySQLEngine, MariaDBEngine } from './mysql.engine';
import { PostgreSQLEngine } from './postgresql.engine';
import { MongoEngine, RedisEngine } from './nosql.engine';

export function engineFactory(config: ConnectionConfig): BaseEngine {
  switch (config.type) {
    case 'MYSQL':
      return new MySQLEngine(config);
    case 'MARIADB':
      return new MariaDBEngine(config);
    case 'POSTGRESQL':
      return new PostgreSQLEngine(config);
    case 'MONGODB':
      return new MongoEngine(config);
    case 'REDIS':
      return new RedisEngine(config);
    default:
      throw new Error(`Unsupported database type: ${config.type}`);
  }
}
