# Implementation Plan: Database Synchronization UI

## Overview

This implementation plan breaks down the Database Synchronization UI feature into incremental, actionable coding tasks. Each task builds on previous work and references specific requirements. The implementation follows existing React + TypeScript patterns from the codebase and integrates with the backend synchronization API.

## Tasks

- [x] 1. Set up sync service layer and TypeScript interfaces
  - Create `client/src/services/sync.service.ts` with API client functions for all 18 endpoints
  - Define TypeScript interfaces: SyncConfiguration, SyncState, SyncHistoryEntry, SyncConflict, SchemaComparison, SyncProgressEvent, SyncConfigFormData
  - Follow the pattern from `connections.service.ts` using the existing `api` instance
  - Export all interfaces and the `syncApi` object
  - _Requirements: 1, 2, 5, 7, 8, 9, 10_

- [ ] 2. Create reusable sync UI components
  - [x] 2.1 Create SyncStatusBadge component
    - Create `client/src/components/sync/SyncStatusBadge.tsx`
    - Implement status-to-color mapping (Active=green, Paused=yellow, Failed=red, Stopped=gray, Running/Pending=blue)
    - Use existing Badge component with Tailwind classes
    - _Requirements: 12_
  
  - [x] 2.2 Create ProgressIndicator component
    - Create `client/src/components/sync/ProgressIndicator.tsx`
    - Integrate useProgressSSE hook for real-time updates
    - Display progress bar, current table, tables completed/total, rows synced, elapsed time
    - Implement mini mode for card display
    - _Requirements: 7_
  
  - [ ]* 2.3 Write unit tests for SyncStatusBadge
    - Test all status values render correct colors and labels
    - _Requirements: 12_

- [ ] 3. Implement SyncConfigurationsPage (list view)
  - [x] 3.1 Create SyncConfigurationsPage component
    - Create `client/src/pages/sync/SyncConfigurationsPage.tsx`
    - Implement React Query hook to fetch all configurations with polling logic
    - Display grid layout (1 column mobile, 2 tablet, 3 desktop)
    - Show configuration cards with name, source/target, direction, status badge, last sync time
    - Add action buttons: View Details, Edit, Delete
    - _Requirements: 1, 16_
  
  - [x] 3.2 Add loading and empty states
    - Display CardSkeleton components while loading
    - Show empty state with illustration and "Create your first sync configuration" message
    - _Requirements: 18, 19_
  
  - [x] 3.3 Implement delete confirmation dialog
    - Use existing ConfirmDialog component
    - Wire up delete mutation with React Query
    - Show success/error toasts
    - _Requirements: 4, 17_

- [x] 4. Checkpoint - Verify list page renders
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Create SyncConfigForm component
  - [x] 5.1 Create form component with validation schema
    - Create `client/src/components/sync/SyncConfigForm.tsx`
    - Define Zod validation schema with all field rules
    - Use React Hook Form with zodResolver
    - Implement form in Modal component
    - _Requirements: 2, 13_
  
  - [x] 5.2 Implement form fields and connection selectors
    - Add all form fields: name, source/target connections, direction, mode, cron, conflict strategy, table filters, batch size
    - Fetch connections list for dropdowns
    - Exclude source from target options
    - Show cron field conditionally when mode is SCHEDULED
    - _Requirements: 2, 11_
  
  - [x] 5.3 Wire up create and update mutations
    - Implement create mutation with React Query
    - Implement update mutation with React Query
    - Handle success/error cases with toasts
    - Invalidate configurations query on success
    - _Requirements: 2, 3, 17_
  
  - [ ]* 5.4 Write form validation tests
    - **Property 9: Form Validation Completeness**
    - **Validates: Requirements 2, 13**

- [x] 6. Integrate form with list page
  - Add "New Sync Configuration" button to SyncConfigurationsPage header
  - Add Edit button handler on configuration cards
  - Open SyncConfigForm modal with appropriate mode (create/edit)
  - _Requirements: 1, 2, 3_

- [x] 7. Checkpoint - Verify CRUD operations work
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement SyncDetailPage structure
  - [x] 8.1 Create SyncDetailPage component with routing
    - Create `client/src/pages/sync/SyncDetailPage.tsx`
    - Set up React Router route `/sync/:id`
    - Fetch configuration and state data with React Query
    - Implement polling for state when status is RUNNING
    - _Requirements: 5, 16_
  
  - [x] 8.2 Build detail page header and statistics section
    - Display configuration name, source/target, direction, mode, conflict strategy
    - Show SyncStatusBadge prominently
    - Display statistics cards: total rows synced, consecutive failures, avg duration, last/next sync times
    - Add back button to configurations list
    - _Requirements: 5_
  
  - [x] 8.3 Add tab navigation structure
    - Implement tab navigation for Overview, History, Conflicts, Settings
    - Create tab content containers
    - _Requirements: 5_

- [ ] 9. Create LifecycleControls component
  - [x] 9.1 Implement lifecycle control buttons
    - Create `client/src/components/sync/LifecycleControls.tsx`
    - Show appropriate buttons based on current status
    - Implement mutations for activate, pause, resume, stop, trigger, fullSync
    - _Requirements: 6_
  
  - [x] 9.2 Add activation modal with initial sync option
    - Create modal asking whether to perform initial full sync
    - Wire up activate mutation with performInitialSync parameter
    - _Requirements: 6_
  
  - [x] 9.3 Add stop confirmation dialog
    - Use ConfirmDialog to warn about state removal
    - Wire up stop mutation
    - _Requirements: 6_
  
  - [ ]* 9.4 Write lifecycle state transition tests
    - **Property 4: Lifecycle State Transitions**
    - **Validates: Requirement 6**

- [x] 10. Integrate LifecycleControls into detail page
  - Add LifecycleControls component to SyncDetailPage
  - Pass configId and status props
  - Handle success/error toasts
  - Invalidate queries after operations
  - _Requirements: 6, 17_

- [ ] 11. Create SyncHistoryTable component
  - [x] 11.1 Implement history table
    - Create `client/src/components/sync/SyncHistoryTable.tsx`
    - Fetch history data with React Query
    - Display columns: start time, end time, duration, status, rows synced, conflicts detected
    - Show error messages in expandable rows or tooltips
    - _Requirements: 8_
  
  - [x] 11.2 Add pagination and empty state
    - Implement "Load More" button or pagination
    - Default to showing last 10 entries
    - Show empty state when no history exists
    - Display loading skeleton while fetching
    - _Requirements: 8, 18, 19_
  
  - [ ]* 11.3 Write history ordering tests
    - **Property 6: History Ordering**
    - **Validates: Requirement 8**

- [x] 12. Integrate history table into detail page
  - Add SyncHistoryTable to History tab
  - Refresh history after sync completion
  - _Requirements: 5, 8_

- [x] 13. Checkpoint - Verify detail page and lifecycle controls
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Create ConflictResolutionModal component
  - [x] 14.1 Build conflict list view
    - Create `client/src/components/sync/ConflictResolutionModal.tsx`
    - Fetch conflicts with React Query
    - Display table with table name, primary key values, conflict timestamp
    - Add "View Details" button for each conflict
    - _Requirements: 9_
  
  - [x] 14.2 Implement conflict detail modal
    - Show source and target data side-by-side
    - Display modification timestamps
    - Add "Use Source" and "Use Target" resolution buttons
    - Implement JSON diff view for complex data
    - _Requirements: 9_
  
  - [x] 14.3 Wire up conflict resolution mutation
    - Implement resolveConflict mutation
    - Remove resolved conflict from list
    - Show success toast
    - Invalidate conflicts and history queries
    - _Requirements: 9, 17_
  
  - [ ]* 14.4 Write conflict resolution tests
    - **Property 7: Conflict Resolution Idempotency**
    - **Validates: Requirement 9**

- [x] 15. Integrate conflicts into detail page
  - Add ConflictResolutionModal to Conflicts tab
  - Display unresolved conflict count in tab label
  - Show empty state when no conflicts exist
  - _Requirements: 5, 9, 19_

- [ ] 16. Create SchemaComparisonModal component
  - [x] 16.1 Build schema comparison view
    - Create `client/src/components/sync/SchemaComparisonModal.tsx`
    - Fetch schema comparison data with React Query
    - Display overall compatibility status badge
    - List missing tables, column mismatches, type mismatches
    - _Requirements: 10_
  
  - [x] 16.2 Implement create missing tables functionality
    - Add "Create Missing Tables" button when missing tables exist
    - Wire up createMissingTables mutation
    - Refresh comparison data after creation
    - Show success toast
    - _Requirements: 10, 17_
  
  - [ ]* 16.3 Write schema compatibility tests
    - **Property 8: Schema Compatibility**
    - **Validates: Requirement 10**

- [x] 17. Integrate schema comparison into detail page
  - Add "Compare Schemas" button to Settings tab
  - Open SchemaComparisonModal on click
  - Show alert banner on detail page when schema drift detected
  - _Requirements: 5, 10, 12_

- [ ] 18. Add routing and navigation
  - [x] 18.1 Update App.tsx with sync routes
    - Add `/sync` route for SyncConfigurationsPage
    - Add `/sync/:id` route for SyncDetailPage
    - Add lazy loading for code splitting
    - _Requirements: 15_
  
  - [x] 18.2 Add sync link to navigation menu
    - Add "Sync" link to sidebar navigation
    - Use RefreshCw icon from lucide-react
    - Display active route indicator
    - _Requirements: 15_

- [x] 19. Implement responsive design adjustments
  - Apply responsive grid classes to SyncConfigurationsPage (1/2/3 columns)
  - Stack form fields vertically on mobile in SyncConfigForm
  - Make SyncHistoryTable horizontally scrollable on mobile
  - Stack source/target comparison vertically on mobile in ConflictResolutionModal
  - Wrap LifecycleControls buttons on mobile
  - _Requirements: 14_

- [x] 20. Add accessibility features
  - Add aria-label attributes to icon-only buttons
  - Add aria-describedby for form validation errors
  - Ensure all interactive elements are keyboard accessible
  - Add visible focus indicators
  - Implement focus trap in modals
  - Add aria-live regions for progress updates
  - _Requirements: 20_

- [x] 21. Implement real-time progress on list page
  - Add mini ProgressIndicator to configuration cards when status is RUNNING
  - Show compact progress bar and current table name
  - _Requirements: 7_

- [x] 22. Add alert banners for warnings
  - Display warning icon on configuration cards with unresolved conflicts
  - Display error icon on cards with consecutive failures
  - Show alert banner on detail page when schema drift detected
  - Show alert banner when conflicts require manual resolution
  - _Requirements: 12_

- [-] 23. Final checkpoint - End-to-end testing
  - Test complete flow: create config → activate → monitor progress → view history → resolve conflicts
  - Verify all toasts display correctly
  - Verify all loading states work
  - Verify all empty states display
  - Verify responsive design on mobile/tablet/desktop
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Follow existing patterns from ConnectionsPage.tsx and connections.service.ts
- All required dependencies already exist in the project
- SSE integration uses existing useProgressSSE hook
- Forms use React Hook Form + Zod pattern
- API calls use existing api instance with auto-refresh
