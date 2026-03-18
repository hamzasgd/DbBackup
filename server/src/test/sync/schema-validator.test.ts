import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SchemaValidatorService } from '../../services/sync/schema-validator.service';
import { ConnectionConfig } from '../../services/engines/base.engine';

describe('SchemaValidatorService', () => {
  const service = new SchemaValidatorService();

  describe('Type Compatibility', () => {
    it('should recognize exact type matches as compatible', () => {
      const result = (service as any).checkTypeCompatibility('int', 'int');
      expect(result.compatible).toBe(true);
    });

    it('should recognize compatible integer types', () => {
      const result = (service as any).checkTypeCompatibility('int', 'integer');
      expect(result.compatible).toBe(true);
    });

    it('should recognize compatible string types', () => {
      const result = (service as any).checkTypeCompatibility('varchar(255)', 'text');
      expect(result.compatible).toBe(true);
    });

    it('should recognize compatible decimal types', () => {
      const result = (service as any).checkTypeCompatibility('decimal(10,2)', 'numeric');
      expect(result.compatible).toBe(true);
    });

    it('should recognize compatible datetime types', () => {
      const result = (service as any).checkTypeCompatibility('datetime', 'timestamp');
      expect(result.compatible).toBe(true);
    });

    it('should recognize incompatible types', () => {
      const result = (service as any).checkTypeCompatibility('int', 'varchar');
      expect(result.compatible).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  describe('Type Normalization', () => {
    it('should normalize types by removing size specifications', () => {
      const normalized = (service as any).normalizeType('varchar(255)');
      expect(normalized).toBe('varchar');
    });

    it('should normalize types by removing unsigned', () => {
      const normalized = (service as any).normalizeType('int unsigned');
      expect(normalized).toBe('int');
    });

    it('should normalize types to lowercase', () => {
      const normalized = (service as any).normalizeType('VARCHAR(100)');
      expect(normalized).toBe('varchar');
    });
  });

  describe('Type Conversion', () => {
    it('should convert MySQL int to PostgreSQL INTEGER', () => {
      const converted = (service as any).convertTypeForTarget('int', 'MYSQL', 'POSTGRESQL');
      expect(converted).toBe('INTEGER');
    });

    it('should convert MySQL datetime to PostgreSQL TIMESTAMP', () => {
      const converted = (service as any).convertTypeForTarget('datetime', 'MYSQL', 'POSTGRESQL');
      expect(converted).toBe('TIMESTAMP');
    });

    it('should convert MySQL text to PostgreSQL TEXT', () => {
      const converted = (service as any).convertTypeForTarget('text', 'MYSQL', 'POSTGRESQL');
      expect(converted).toBe('TEXT');
    });

    it('should convert PostgreSQL integer to MySQL INT', () => {
      const converted = (service as any).convertTypeForTarget('integer', 'POSTGRESQL', 'MYSQL');
      expect(converted).toBe('INT');
    });

    it('should convert PostgreSQL timestamp to MySQL DATETIME', () => {
      const converted = (service as any).convertTypeForTarget('timestamp', 'POSTGRESQL', 'MYSQL');
      expect(converted).toBe('DATETIME');
    });

    it('should not convert types for same database type', () => {
      const converted = (service as any).convertTypeForTarget('int', 'MYSQL', 'MYSQL');
      expect(converted).toBe('int');
    });
  });

  describe('Schema Validation', () => {
    it('should validate compatible schemas', async () => {
      const comparison = {
        compatible: true,
        missingTables: [],
        columnMismatches: [],
        typeMismatches: [],
      };

      const result = await service.validateSchemaCompatibility(comparison);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should report missing tables as errors', async () => {
      const comparison = {
        compatible: false,
        missingTables: ['users', 'orders'],
        columnMismatches: [],
        typeMismatches: [],
      };

      const result = await service.validateSchemaCompatibility(comparison);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Missing tables');
      expect(result.errors[0]).toContain('users');
      expect(result.errors[0]).toContain('orders');
    });

    it('should report missing columns as errors', async () => {
      const comparison = {
        compatible: false,
        missingTables: [],
        columnMismatches: [
          {
            tableName: 'users',
            columnName: 'email',
            sourceType: 'varchar(255)',
            targetType: 'MISSING',
            sourceNullable: false,
            targetNullable: false,
            issue: 'Column missing in target',
          },
        ],
        typeMismatches: [],
      };

      const result = await service.validateSchemaCompatibility(comparison);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('users');
      expect(result.errors[0]).toContain('email');
      expect(result.errors[0]).toContain('missing in target');
    });

    it('should report extra columns as warnings', async () => {
      const comparison = {
        compatible: false,
        missingTables: [],
        columnMismatches: [
          {
            tableName: 'users',
            columnName: 'extra_field',
            sourceType: 'MISSING',
            targetType: 'varchar(100)',
            sourceNullable: false,
            targetNullable: true,
            issue: 'Extra column in target',
          },
        ],
        typeMismatches: [],
      };

      const result = await service.validateSchemaCompatibility(comparison);
      expect(result.valid).toBe(true); // Extra columns are warnings, not errors
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Extra column');
    });

    it('should report nullable mismatches as warnings', async () => {
      const comparison = {
        compatible: false,
        missingTables: [],
        columnMismatches: [
          {
            tableName: 'users',
            columnName: 'name',
            sourceType: 'varchar(255)',
            targetType: 'varchar(255)',
            sourceNullable: false,
            targetNullable: true,
            issue: 'Nullable constraint mismatch',
          },
        ],
        typeMismatches: [],
      };

      const result = await service.validateSchemaCompatibility(comparison);
      expect(result.valid).toBe(true); // Nullable mismatches are warnings
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('nullable mismatch');
    });

    it('should report type mismatches as errors', async () => {
      const comparison = {
        compatible: false,
        missingTables: [],
        columnMismatches: [],
        typeMismatches: [
          {
            tableName: 'users',
            columnName: 'age',
            sourceType: 'int',
            targetType: 'varchar(50)',
            compatible: false,
            reason: 'Type mismatch',
          },
        ],
      };

      const result = await service.validateSchemaCompatibility(comparison);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('type incompatible');
    });
  });

  describe('Column Definition Generation', () => {
    it('should generate column definition with NOT NULL', () => {
      const column = {
        name: 'id',
        type: 'int',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: true,
      };

      const def = (service as any).generateColumnDefinition(column, 'MYSQL', 'MYSQL');
      expect(def).toContain('id');
      expect(def).toContain('int');
      expect(def).toContain('NOT NULL');
    });

    it('should generate column definition with default value', () => {
      const column = {
        name: 'status',
        type: 'varchar(50)',
        nullable: false,
        defaultValue: "'active'",
        isPrimaryKey: false,
      };

      const def = (service as any).generateColumnDefinition(column, 'MYSQL', 'MYSQL');
      expect(def).toContain('status');
      expect(def).toContain('varchar(50)');
      expect(def).toContain('DEFAULT');
      expect(def).toContain("'active'");
    });

    it('should handle AUTO_INCREMENT for MySQL', () => {
      const column = {
        name: 'id',
        type: 'int',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        extra: 'auto_increment',
      };

      const def = (service as any).generateColumnDefinition(column, 'MYSQL', 'MYSQL');
      expect(def).toContain('AUTO_INCREMENT');
    });

    it('should convert AUTO_INCREMENT to SERIAL for PostgreSQL', () => {
      const column = {
        name: 'id',
        type: 'int',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        extra: 'auto_increment',
      };

      const def = (service as any).generateColumnDefinition(column, 'MYSQL', 'POSTGRESQL');
      expect(def).toContain('SERIAL');
      expect(def).not.toContain('AUTO_INCREMENT');
    });
  });
});
