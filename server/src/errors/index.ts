/**
 * Error Class Hierarchy for DbBackup Application
 * Provides structured, operational errors with proper typing and error codes
 */

// Base application error
export class AppError extends Error {
    public readonly statusCode: number;
    public readonly isOperational: boolean;
    public readonly code: string;

    constructor(message: string, statusCode: number = 500, code: string = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        this.code = code;
        // Error.captureStackTrace is V8-specific; add defensive check for non-V8 environments
        if (typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

// Not found error - 404
export class NotFoundError extends AppError {
    constructor(resource: string) {
        super(`${resource} not found`, 404, 'NOT_FOUND');
    }
}

// Validation error - 400
export class ValidationError extends AppError {
    constructor(message: string) {
        super(message, 400, 'VALIDATION_ERROR');
    }
}

// Prisma/Database error with classification
export class PrismaError extends AppError {
    public readonly prismaCode?: string;

    constructor(error: unknown) {
        const { message, statusCode, code, prismaCode } = PrismaError.classify(error);
        super(message, statusCode, code);
        this.prismaCode = prismaCode;
    }

    private static classify(error: unknown): {
        message: string;
        statusCode: number;
        code: string;
        prismaCode?: string;
    } {
        // Handle Prisma errors
        if (error && typeof error === 'object' && 'code' in error) {
            const prismaError = error as { code: string; message?: string };

            switch (prismaError.code) {
                // Unique constraint violation
                case 'P2002':
                    return {
                        message: 'Resource already exists',
                        statusCode: 409,
                        code: 'DUPLICATE',
                        prismaCode: 'P2002',
                    };
                // Record not found
                case 'P2025':
                    return {
                        message: 'Record not found',
                        statusCode: 404,
                        code: 'NOT_FOUND',
                        prismaCode: 'P2025',
                    };
                // Foreign key constraint violation
                case 'P2003':
                    return {
                        message: 'Foreign key constraint violation',
                        statusCode: 400,
                        code: 'CONSTRAINT_VIOLATION',
                        prismaCode: 'P2003',
                    };
                // Required relation not found
                case 'P2018':
                    return {
                        message: 'Required relation not found',
                        statusCode: 404,
                        code: 'RELATION_NOT_FOUND',
                        prismaCode: 'P2018',
                    };
                // Default error for known Prisma codes
                default:
                    return {
                        message: prismaError.message || 'Database operation failed',
                        statusCode: 500,
                        code: 'DATABASE_ERROR',
                        prismaCode: prismaError.code,
                    };
            }
        }

        // Handle standard Error objects
        if (error instanceof Error) {
            // Unique constraint detection via message (fallback)
            if (error.message.includes('Unique constraint')) {
                return {
                    message: 'Resource already exists',
                    statusCode: 409,
                    code: 'DUPLICATE',
                };
            }
            // Not found detection via message (fallback)
            if (error.message.includes('Record to update not found')) {
                return {
                    message: 'Record not found',
                    statusCode: 404,
                    code: 'NOT_FOUND',
                };
            }
        }

        // Default error
        return {
            message: 'Database error',
            statusCode: 500,
            code: 'DATABASE_ERROR',
        };
    }
}

// Unauthorized error - 401
export class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, 401, 'UNAUTHORIZED');
    }
}

// Conflict error - 409
export class ConflictError extends AppError {
    constructor(message: string) {
        super(message, 409, 'CONFLICT');
    }
}

// Sync conflict error - 409
export class SyncConflictError extends AppError {
    public readonly tableName?: string;
    public readonly primaryKeyValues?: Record<string, unknown>;

    constructor(message: string, tableName?: string, primaryKeyValues?: Record<string, unknown>) {
        super(message, 409, 'SYNC_CONFLICT');
        this.tableName = tableName;
        this.primaryKeyValues = primaryKeyValues;
    }
}
