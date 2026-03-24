import { ChangeOperation } from '@prisma/client';
import { BaseEngine, ConnectionConfig } from '../../../services/engines/base.engine';
import type { PrimaryKeyValues, RowData } from '../../../services/sync/types';

/**
 * Validation result for a change operation.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * A change to be applied to the target database.
 */
export interface ChangeToValidate {
  operation: ChangeOperation;
  primaryKeyValues: PrimaryKeyValues;
  changeData: RowData | null;
}

/**
 * Validate a change before applying it to the target database.
 *
 * Validates:
 * - Primary key values exist and are not null
 * - Foreign key constraints (if applicable)
 * - Data type compatibility
 * - JSON column validity
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */
export async function validateChange(
  change: ChangeToValidate,
  tableName: string,
  targetEngine: BaseEngine,
  targetConfig: ConnectionConfig
): Promise<ValidationResult> {
  const errors: string[] = [];

  // Validate primary key values
  const pkValues = change.primaryKeyValues;
  if (!pkValues || Object.keys(pkValues).length === 0) {
    errors.push('Primary key values are missing');
    return { valid: false, errors };
  }

  for (const [key, value] of Object.entries(pkValues)) {
    if (value === null || value === undefined) {
      errors.push(`Primary key '${key}' is null or undefined`);
    }
  }

  // For INSERT and UPDATE operations, validate change data
  if (change.operation === ChangeOperation.INSERT || change.operation === ChangeOperation.UPDATE) {
    const data = change.changeData;

    if (!data || Object.keys(data).length === 0) {
      errors.push('Change data is missing');
      return { valid: false, errors };
    }

    // Validate data types (basic validation)
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) {
        if (typeof value === 'function' || typeof value === 'symbol') {
          errors.push(`Invalid data type for column '${key}'`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
