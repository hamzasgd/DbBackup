/**
 * Type definitions for sync operations
 * Provides type safety for CDC tracking, change data, and conflict resolution
 */

/** Primary key as column name -> value mapping */
export type PrimaryKeyValues = Record<string, string | number | boolean | null>;

/** Row data as column name -> value mapping */
export type RowData = Record<string, unknown>;

/** JSON-serializable value */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Change operation types */
export type ChangeOperationType = 'INSERT' | 'UPDATE' | 'DELETE';

/** Database origin for changes */
export type ChangeOrigin = 'source' | 'target';

/**
 * Change log entry representing a single database change
 */
export interface ChangeLogEntry {
  id: string;
  syncConfigId: string;
  tableName: string;
  operation: ChangeOperationType;
  primaryKeyValues: PrimaryKeyValues;
  changeData: RowData | null;
  timestamp: Date;
  checkpoint: string;
  origin: ChangeOrigin;
  synchronized: boolean;
  synchronizedAt: Date | null;
}

/** Alias for ChangeLogEntry for backward compatibility */
export type ChangeLog = ChangeLogEntry;

/**
 * Conflict data when source and target have different values for the same row
 */
export interface ConflictData {
  tableName: string;
  primaryKeyValues: PrimaryKeyValues;
  sourceData: RowData;
  targetData: RowData;
  sourceTimestamp: Date;
  targetTimestamp: Date;
}

/**
 * Result of a conflict resolution
 */
export interface ResolutionResult {
  resolution: 'source' | 'target' | 'manual';
  resolvedData: RowData | null;
}

/**
 * Validation result for a change operation
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}
