import { engineFactory } from '../engines/engine.factory';
import { ConnectionConfig, DbInfo, TableInfo, ColumnInfo } from '../engines/base.engine';
import { prisma } from '../../config/database';
import { decrypt, decryptIfPresent } from '../crypto.service';

export interface ColumnMismatch {
  tableName: string;
  columnName: string;
  sourceType: string;
  targetType: string;
  sourceNullable: boolean;
  targetNullable: boolean;
  issue: string;
}

export interface TypeMismatch {
  tableName: string;
  columnName: string;
  sourceType: string;
  targetType: string;
  compatible: boolean;
  reason?: string;
}

export interface SchemaComparison {
  compatible: boolean;
  missingTables: string[];
  columnMismatches: ColumnMismatch[];
  typeMismatches: TypeMismatch[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class SchemaValidatorService {
  /**
   * Compare schemas between source and target databases
   */
  async compareSchemas(
    sourceConfig: ConnectionConfig,
    targetConfig: ConnectionConfig,
    tables: string[]
  ): Promise<SchemaComparison> {
    const sourceEngine = engineFactory(sourceConfig);
    const targetEngine = engineFactory(targetConfig);

    // Get database info from both databases
    const sourceDbInfo = await sourceEngine.getDbInfo();
    const targetDbInfo = await targetEngine.getDbInfo();

    const missingTables: string[] = [];
    const columnMismatches: ColumnMismatch[] = [];
    const typeMismatches: TypeMismatch[] = [];

    // Determine which tables to check
    const tablesToCheck = tables.length > 0 
      ? tables 
      : sourceDbInfo.tables.map(t => t.name);

    // Check each table
    for (const tableName of tablesToCheck) {
      const sourceTable = sourceDbInfo.tables.find(t => t.name === tableName);
      const targetTable = targetDbInfo.tables.find(t => t.name === tableName);

      // Check if table exists in both databases
      if (!sourceTable) {
        continue; // Skip if table doesn't exist in source
      }

      if (!targetTable) {
        missingTables.push(tableName);
        continue;
      }

      // Compare columns
      this.compareTableColumns(
        sourceTable,
        targetTable,
        columnMismatches,
        typeMismatches
      );
    }

    const compatible = 
      missingTables.length === 0 &&
      columnMismatches.length === 0 &&
      typeMismatches.length === 0;

    return {
      compatible,
      missingTables,
      columnMismatches,
      typeMismatches,
    };
  }

  /**
   * Compare columns between source and target tables
   */
  private compareTableColumns(
    sourceTable: TableInfo,
    targetTable: TableInfo,
    columnMismatches: ColumnMismatch[],
    typeMismatches: TypeMismatch[]
  ): void {
    const tableName = sourceTable.name;

    // Check each source column
    for (const sourceCol of sourceTable.columns) {
      const targetCol = targetTable.columns.find(c => c.name === sourceCol.name);

      if (!targetCol) {
        columnMismatches.push({
          tableName,
          columnName: sourceCol.name,
          sourceType: sourceCol.type,
          targetType: 'MISSING',
          sourceNullable: sourceCol.nullable,
          targetNullable: false,
          issue: 'Column missing in target',
        });
        continue;
      }

      // Check nullable mismatch
      if (sourceCol.nullable !== targetCol.nullable) {
        columnMismatches.push({
          tableName,
          columnName: sourceCol.name,
          sourceType: sourceCol.type,
          targetType: targetCol.type,
          sourceNullable: sourceCol.nullable,
          targetNullable: targetCol.nullable,
          issue: 'Nullable constraint mismatch',
        });
      }

      // Check type compatibility
      const typeCompatibility = this.checkTypeCompatibility(
        sourceCol.type,
        targetCol.type
      );

      if (!typeCompatibility.compatible) {
        typeMismatches.push({
          tableName,
          columnName: sourceCol.name,
          sourceType: sourceCol.type,
          targetType: targetCol.type,
          compatible: false,
          reason: typeCompatibility.reason,
        });
      }
    }

    // Check for extra columns in target (not critical but worth noting)
    for (const targetCol of targetTable.columns) {
      const sourceCol = sourceTable.columns.find(c => c.name === targetCol.name);
      if (!sourceCol) {
        columnMismatches.push({
          tableName,
          columnName: targetCol.name,
          sourceType: 'MISSING',
          targetType: targetCol.type,
          sourceNullable: false,
          targetNullable: targetCol.nullable,
          issue: 'Extra column in target',
        });
      }
    }
  }

  /**
   * Check if two data types are compatible for synchronization
   */
  private checkTypeCompatibility(
    sourceType: string,
    targetType: string
  ): { compatible: boolean; reason?: string } {
    // Normalize types for comparison
    const normalizedSource = this.normalizeType(sourceType);
    const normalizedTarget = this.normalizeType(targetType);

    // Exact match
    if (normalizedSource === normalizedTarget) {
      return { compatible: true };
    }

    // Check compatible type mappings
    const compatibleMappings: Record<string, string[]> = {
      // Integer types
      'int': ['integer', 'int4', 'bigint', 'int8', 'smallint', 'int2', 'tinyint'],
      'integer': ['int', 'int4', 'bigint', 'int8', 'smallint', 'int2'],
      'bigint': ['int8', 'int', 'integer', 'int4'],
      'smallint': ['int2', 'int', 'integer', 'tinyint'],
      'tinyint': ['smallint', 'int2', 'int'],
      
      // String types
      'varchar': ['character varying', 'text', 'char', 'character'],
      'text': ['varchar', 'character varying', 'longtext', 'mediumtext'],
      'char': ['character', 'varchar', 'character varying'],
      
      // Decimal types
      'decimal': ['numeric', 'double', 'float', 'real'],
      'numeric': ['decimal', 'double', 'float'],
      'float': ['real', 'double', 'numeric', 'decimal'],
      'double': ['double precision', 'float', 'real'],
      
      // Date/Time types
      'datetime': ['timestamp', 'timestamp without time zone'],
      'timestamp': ['datetime', 'timestamp without time zone', 'timestamp with time zone'],
      'date': ['date'],
      'time': ['time', 'time without time zone'],
      
      // Boolean types
      'boolean': ['bool', 'tinyint(1)', 'bit(1)'],
      'bool': ['boolean', 'tinyint(1)', 'bit(1)'],
      
      // Binary types
      'blob': ['bytea', 'binary', 'varbinary'],
      'bytea': ['blob', 'binary', 'varbinary'],
    };

    // Check if types are in compatible mapping
    const compatibleTypes = compatibleMappings[normalizedSource];
    if (compatibleTypes && compatibleTypes.includes(normalizedTarget)) {
      return { compatible: true };
    }

    // Check reverse mapping
    const reverseCompatibleTypes = compatibleMappings[normalizedTarget];
    if (reverseCompatibleTypes && reverseCompatibleTypes.includes(normalizedSource)) {
      return { compatible: true };
    }

    return {
      compatible: false,
      reason: `Type mismatch: ${sourceType} is not compatible with ${targetType}`,
    };
  }

  /**
   * Normalize database type for comparison
   */
  private normalizeType(type: string): string {
    // Remove size specifications and convert to lowercase
    return type
      .toLowerCase()
      .replace(/\(.*?\)/g, '') // Remove parentheses and content
      .replace(/\s+unsigned/g, '') // Remove unsigned
      .replace(/\s+zerofill/g, '') // Remove zerofill
      .trim();
  }

  /**
   * Validate schema compatibility and return validation result
   */
  async validateSchemaCompatibility(
    comparison: SchemaComparison
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for missing tables
    if (comparison.missingTables.length > 0) {
      errors.push(
        `Missing tables in target: ${comparison.missingTables.join(', ')}`
      );
    }

    // Check for column mismatches
    for (const mismatch of comparison.columnMismatches) {
      if (mismatch.issue === 'Column missing in target') {
        errors.push(
          `Table ${mismatch.tableName}: Column ${mismatch.columnName} missing in target`
        );
      } else if (mismatch.issue === 'Extra column in target') {
        warnings.push(
          `Table ${mismatch.tableName}: Extra column ${mismatch.columnName} in target`
        );
      } else if (mismatch.issue === 'Nullable constraint mismatch') {
        warnings.push(
          `Table ${mismatch.tableName}: Column ${mismatch.columnName} nullable mismatch (source: ${mismatch.sourceNullable}, target: ${mismatch.targetNullable})`
        );
      }
    }

    // Check for type mismatches
    for (const mismatch of comparison.typeMismatches) {
      errors.push(
        `Table ${mismatch.tableName}: Column ${mismatch.columnName} type incompatible (source: ${mismatch.sourceType}, target: ${mismatch.targetType})`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Create missing tables in target database using source schema
   */
  async createMissingTables(
    sourceConfig: ConnectionConfig,
    targetConfig: ConnectionConfig,
    tables: string[]
  ): Promise<void> {
    const sourceEngine = engineFactory(sourceConfig);
    const targetEngine = engineFactory(targetConfig);

    // Get source database info
    const sourceDbInfo = await sourceEngine.getDbInfo();

    // Filter to only the requested tables
    const tablesToCreate = sourceDbInfo.tables.filter(t => 
      tables.includes(t.name)
    );

    if (tablesToCreate.length === 0) {
      throw new Error('No tables found to create');
    }

    // Generate CREATE TABLE statements for each table
    for (const table of tablesToCreate) {
      const createTableSQL = this.generateCreateTableSQL(
        table,
        sourceConfig.type,
        targetConfig.type
      );

      // Execute the CREATE TABLE statement on target
      await this.executeSQL(targetConfig, createTableSQL);
    }
  }

  /**
   * Generate CREATE TABLE SQL statement
   */
  private generateCreateTableSQL(
    table: TableInfo,
    sourceType: string,
    targetType: string
  ): string {
    const columns = table.columns.map(col => {
      const columnDef = this.generateColumnDefinition(col, sourceType, targetType);
      return `  ${columnDef}`;
    }).join(',\n');

    // Get primary key columns
    const pkColumns = table.columns
      .filter(col => col.isPrimaryKey)
      .map(col => col.name);

    let sql = `CREATE TABLE IF NOT EXISTS ${table.name} (\n${columns}`;

    if (pkColumns.length > 0) {
      sql += `,\n  PRIMARY KEY (${pkColumns.join(', ')})`;
    }

    sql += '\n);';

    return sql;
  }

  /**
   * Generate column definition for CREATE TABLE
   */
  private generateColumnDefinition(
    column: ColumnInfo,
    sourceType: string,
    targetType: string
  ): string {
    // Convert type if needed
    const convertedType = this.convertTypeForTarget(
      column.type,
      sourceType,
      targetType
    );

    let def = `${column.name} ${convertedType}`;

    // Add NOT NULL constraint
    if (!column.nullable) {
      def += ' NOT NULL';
    }

    // Add default value if present
    if (column.defaultValue !== null) {
      def += ` DEFAULT ${column.defaultValue}`;
    }

    // Add extra attributes (like AUTO_INCREMENT)
    if (column.extra) {
      if (column.extra.includes('auto_increment') && targetType === 'POSTGRESQL') {
        // PostgreSQL uses SERIAL instead of AUTO_INCREMENT
        def = def.replace(convertedType, 'SERIAL');
      } else if (column.extra.includes('auto_increment')) {
        def += ' AUTO_INCREMENT';
      }
    }

    return def;
  }

  /**
   * Convert data type from source to target database
   */
  private convertTypeForTarget(
    sourceType: string,
    sourceDbType: string,
    targetDbType: string
  ): string {
    // If same database type, no conversion needed
    if (sourceDbType === targetDbType) {
      return sourceType;
    }

    const normalizedType = this.normalizeType(sourceType);

    // MySQL/MariaDB to PostgreSQL conversions
    if ((sourceDbType === 'MYSQL' || sourceDbType === 'MARIADB') && targetDbType === 'POSTGRESQL') {
      const conversionMap: Record<string, string> = {
        'int': 'INTEGER',
        'tinyint': 'SMALLINT',
        'smallint': 'SMALLINT',
        'mediumint': 'INTEGER',
        'bigint': 'BIGINT',
        'float': 'REAL',
        'double': 'DOUBLE PRECISION',
        'decimal': 'NUMERIC',
        'varchar': 'VARCHAR',
        'char': 'CHAR',
        'text': 'TEXT',
        'mediumtext': 'TEXT',
        'longtext': 'TEXT',
        'blob': 'BYTEA',
        'mediumblob': 'BYTEA',
        'longblob': 'BYTEA',
        'datetime': 'TIMESTAMP',
        'timestamp': 'TIMESTAMP',
        'date': 'DATE',
        'time': 'TIME',
        'boolean': 'BOOLEAN',
        'bool': 'BOOLEAN',
      };

      return conversionMap[normalizedType] || sourceType;
    }

    // PostgreSQL to MySQL/MariaDB conversions
    if (sourceDbType === 'POSTGRESQL' && (targetDbType === 'MYSQL' || targetDbType === 'MARIADB')) {
      const conversionMap: Record<string, string> = {
        'integer': 'INT',
        'int4': 'INT',
        'int2': 'SMALLINT',
        'int8': 'BIGINT',
        'smallint': 'SMALLINT',
        'bigint': 'BIGINT',
        'real': 'FLOAT',
        'double precision': 'DOUBLE',
        'numeric': 'DECIMAL',
        'character varying': 'VARCHAR',
        'character': 'CHAR',
        'text': 'TEXT',
        'bytea': 'BLOB',
        'timestamp': 'DATETIME',
        'timestamp without time zone': 'DATETIME',
        'timestamp with time zone': 'DATETIME',
        'date': 'DATE',
        'time': 'TIME',
        'time without time zone': 'TIME',
        'boolean': 'BOOLEAN',
        'bool': 'BOOLEAN',
      };

      return conversionMap[normalizedType] || sourceType;
    }

    // Default: return original type
    return sourceType;
  }

  /**
   * Execute SQL statement on target database
   */
  private async executeSQL(
    config: ConnectionConfig,
    sql: string
  ): Promise<void> {
    if (config.type === 'POSTGRESQL') {
      const { Pool } = await import('pg');
      const pool = new Pool({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password ?? undefined,
        database: config.database,
        ssl: config.sslEnabled ? { rejectUnauthorized: false } : undefined,
      });

      try {
        await pool.query(sql);
      } finally {
        await pool.end();
      }
    } else if (config.type === 'MYSQL' || config.type === 'MARIADB') {
      const mysql2 = await import('mysql2/promise');
      const conn = await mysql2.createConnection({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password ?? undefined,
        database: config.database,
        ssl: config.sslEnabled ? { rejectUnauthorized: false } : undefined,
      });

      try {
        await conn.query(sql);
      } finally {
        await conn.end();
      }
    } else {
      throw new Error(`Unsupported database type: ${config.type}`);
    }
  }

  /**
   * Get schema comparison for a sync configuration
   */
  async getSchemaComparison(configId: string): Promise<SchemaComparison> {
    // Fetch sync configuration with connections
    const syncConfig = await prisma.syncConfiguration.findUnique({
      where: { id: configId },
      include: {
        sourceConnection: true,
        targetConnection: true,
      },
    });

    if (!syncConfig) {
      throw new Error(`Sync configuration not found: ${configId}`);
    }

    // Convert Prisma connection to ConnectionConfig
    const sourceConfig = this.prismaConnectionToConfig(syncConfig.sourceConnection);
    const targetConfig = this.prismaConnectionToConfig(syncConfig.targetConnection);

    // Determine tables to compare
    const tables = syncConfig.includeTables.length > 0 
      ? syncConfig.includeTables 
      : [];

    // Compare schemas
    return this.compareSchemas(sourceConfig, targetConfig, tables);
  }

  /**
   * Convert Prisma connection model to ConnectionConfig
   */
  private prismaConnectionToConfig(connection: any): ConnectionConfig {
    return {
      type: connection.type,
      host: decrypt(connection.host),
      port: connection.port,
      username: decrypt(connection.username),
      password: decrypt(connection.password),
      database: decrypt(connection.database),
      sslEnabled: connection.sslEnabled,
      sslCa: decryptIfPresent(connection.sslCa) ?? undefined,
      sslCert: decryptIfPresent(connection.sslCert) ?? undefined,
      sslKey: decryptIfPresent(connection.sslKey) ?? undefined,
      connectionTimeout: connection.connectionTimeout ?? 30000,
      sshEnabled: connection.sshEnabled,
      sshHost: decryptIfPresent(connection.sshHost) ?? undefined,
      sshPort: connection.sshPort ?? undefined,
      sshUsername: decryptIfPresent(connection.sshUsername) ?? undefined,
      sshPrivateKey: decryptIfPresent(connection.sshPrivateKey) ?? undefined,
      sshPassphrase: decryptIfPresent(connection.sshPassphrase) ?? undefined,
    };
  }
}
