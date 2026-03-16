import { BaseEngine, ConnectionConfig } from './base.engine';
import { MySQLEngine, MariaDBEngine } from './mysql.engine';
import { PostgreSQLEngine } from './postgresql.engine';

export function engineFactory(config: ConnectionConfig): BaseEngine {
  switch (config.type) {
    case 'MYSQL':
      return new MySQLEngine(config);
    case 'MARIADB':
      return new MariaDBEngine(config);
    case 'POSTGRESQL':
      return new PostgreSQLEngine(config);
    default:
      throw new Error(`Unsupported database type: ${config.type}`);
  }
}
