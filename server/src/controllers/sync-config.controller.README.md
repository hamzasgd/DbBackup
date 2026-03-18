# Sync Configuration Controller

## Overview

This controller implements the REST API endpoints for managing database synchronization configurations. It provides CRUD operations for sync configurations with proper authentication, authorization, and validation.

## Endpoints

### POST /api/sync/configurations
Creates a new sync configuration.

**Request Body:**
```json
{
  "name": "My Sync Config",
  "sourceConnectionId": "uuid",
  "targetConnectionId": "uuid",
  "direction": "UNIDIRECTIONAL" | "BIDIRECTIONAL",
  "mode": "MANUAL" | "REALTIME" | "SCHEDULED",
  "conflictStrategy": "LAST_WRITE_WINS" | "SOURCE_WINS" | "TARGET_WINS" | "MANUAL_RESOLUTION",
  "includeTables": ["table1", "table2"],
  "excludeTables": ["table3"],
  "cronExpression": "0 0 * * *",
  "batchSize": 500,
  "parallelTables": 1
}
```

**Validation:**
- `name`, `sourceConnectionId`, `targetConnectionId` are required
- `direction` must be a valid SyncDirection enum value
- `mode` must be a valid SyncMode enum value
- `conflictStrategy` must be a valid ConflictStrategy enum value
- `cronExpression` is required when mode is SCHEDULED
- `batchSize` must be between 1 and 10000
- `parallelTables` must be between 1 and 10
- User must own both source and target connections
- Connections must be accessible

**Response:** 201 Created
```json
{
  "success": true,
  "data": { /* sync configuration object */ },
  "message": "Sync configuration created successfully"
}
```

### GET /api/sync/configurations
Lists all sync configurations for the authenticated user.

**Response:** 200 OK
```json
{
  "success": true,
  "data": [ /* array of sync configuration objects */ ]
}
```

### GET /api/sync/configurations/:id
Retrieves a single sync configuration by ID.

**Authorization:** User must own the configuration (verified via connection ownership)

**Response:** 200 OK
```json
{
  "success": true,
  "data": { /* sync configuration object */ }
}
```

**Error Responses:**
- 404 Not Found: Configuration doesn't exist
- 403 Forbidden: User doesn't own the configuration

### PATCH /api/sync/configurations/:id
Updates an existing sync configuration.

**Authorization:** User must own the configuration

**Restrictions:** Cannot update active configurations (must pause/stop first)

**Request Body:** (all fields optional)
```json
{
  "name": "Updated Name",
  "direction": "BIDIRECTIONAL",
  "mode": "SCHEDULED",
  "conflictStrategy": "SOURCE_WINS",
  "includeTables": ["table1"],
  "excludeTables": [],
  "cronExpression": "0 */6 * * *",
  "batchSize": 1000,
  "parallelTables": 2
}
```

**Response:** 200 OK
```json
{
  "success": true,
  "data": { /* updated sync configuration object */ },
  "message": "Sync configuration updated successfully"
}
```

**Error Responses:**
- 404 Not Found: Configuration doesn't exist
- 403 Forbidden: User doesn't own the configuration
- 400 Bad Request: Attempting to update active configuration or invalid values

### DELETE /api/sync/configurations/:id
Deletes a sync configuration and all associated data (cascade delete).

**Authorization:** User must own the configuration

**Restrictions:** Cannot delete active configurations (must stop first)

**Response:** 200 OK
```json
{
  "success": true,
  "message": "Sync configuration deleted successfully"
}
```

**Error Responses:**
- 404 Not Found: Configuration doesn't exist
- 403 Forbidden: User doesn't own the configuration
- 400 Bad Request: Attempting to delete active configuration

## Security Features

1. **Authentication:** All endpoints require valid JWT token via `authenticate` middleware
2. **Authorization:** User ownership verified for all operations
3. **Connection Validation:** Verifies user owns both source and target connections
4. **Connection Accessibility:** Tests that connections are reachable before creating config
5. **Input Validation:** Comprehensive validation of all input parameters
6. **Enum Validation:** Ensures enum values are valid before processing

## Error Handling

All errors are passed to the Express error handling middleware via `next(err)`. The controller uses `AppError` for operational errors with appropriate status codes:

- 400: Bad Request (validation errors, invalid input)
- 403: Forbidden (authorization failures)
- 404: Not Found (resource doesn't exist)
- 500: Internal Server Error (unexpected errors)

## Integration

The controller integrates with:
- **SyncEngineService:** Core business logic for sync configuration management
- **Authentication Middleware:** JWT token validation
- **Error Handler Middleware:** Centralized error processing
- **Prisma:** Database operations via SyncEngineService

## Requirements Satisfied

This implementation satisfies the following requirements from the spec:
- **1.1:** Create sync configuration with all required fields
- **1.2:** Validate connection existence and accessibility
- **1.3:** Store table filters (includeTables, excludeTables)
- **1.4:** Store sync schedule configuration
- **1.5:** Store configuration in database with unique ID
- **1.6:** Allow updates only for inactive configurations
- **1.7:** Allow deletion with cascade to related records
- **1.8:** List all configurations for a user

## Testing

The controller can be tested using:
1. Integration tests with real database
2. API tests using supertest
3. Manual testing with curl or Postman

Example curl command:
```bash
curl -X POST http://localhost:3000/api/sync/configurations \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Sync",
    "sourceConnectionId": "source-uuid",
    "targetConnectionId": "target-uuid"
  }'
```
