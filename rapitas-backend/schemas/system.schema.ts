/**
 * System Settings Validation Schemas
 *
 * Defines Elysia validation schemas for system settings API endpoints.
 */
import { t } from 'elysia';

export const systemSchemas = {
  userSettings: t.Object({
    developerModeDefault: t.Optional(t.Boolean()),
    aiTaskAnalysisDefault: t.Optional(t.Boolean()),
    autoResumeInterruptedTasks: t.Optional(t.Boolean()),
    autoExecuteAfterCreate: t.Optional(t.Boolean()),
    autoGenerateTitle: t.Optional(t.Boolean()),
    autoGenerateTitleDelay: t.Optional(t.Number()),
    autoCreateAfterTitleGeneration: t.Optional(t.Boolean()),
    autoApprovePlan: t.Optional(t.Boolean()),
    autoComplexityAnalysis: t.Optional(t.Boolean()),
    autoCreateFromBacklogLimit: t.Optional(t.Number()),
    restartOnAutoRunDry: t.Optional(t.Boolean()),
    verifyRepairLimit: t.Optional(t.Number()),
    // Execution dashboard stall threshold (task 870): minutes, default 5;
    // clamped 1..120 in settings-extra-fields.ts.
    executionStallThresholdMinutes: t.Optional(t.Number()),
    // Idle-stop timer (task 784): minutes, 0 = off; clamped in settings-extra-fields.ts.
    idleStopMinutes: t.Optional(t.Number()),
    // Nightly self-refill window start: '' (off) or local "HH:MM"; format
    // validated in settings-extra-fields.ts (invalid values are rejected there).
    selfRefillWindowStart: t.Optional(t.String()),
    autoRestartOnMergedCode: t.Optional(t.Boolean()),
    retroReviewEnabled: t.Optional(t.Boolean()),
    mergeBarrierEnabled: t.Optional(t.Boolean()),
    autoCommitDefault: t.Optional(t.Boolean()),
    autoCreatePRDefault: t.Optional(t.Boolean()),
    autoMergePRDefault: t.Optional(t.Boolean()),
    mergeCommitThresholdDefault: t.Optional(t.Number()),
    defaultAiProvider: t.Optional(t.String()),
    defaultCategoryId: t.Optional(t.Number()),
    activeMode: t.Optional(t.String()),
    // NOTE: format:'uri' only checks shape; the loopback/private-host SSRF
    // check happens in the handler (validateOllamaUrl) since TypeBox has no
    // hostname-range validator.
    ollamaUrl: t.Optional(t.String({ format: 'uri', maxLength: 2048 })),
    ollamaDefaultModel: t.Optional(t.String({ maxLength: 200 })),
    titleGenerationProvider: t.Optional(t.Union([t.String(), t.Null()])),
    skipAgentPermissionPrompts: t.Optional(t.Boolean()),
    workflowDisabledGlobally: t.Optional(t.Boolean()),
  }),

  aiProviderConfig: t.Object({
    apiKey: t.String({ minLength: 1 }),
    provider: t.Optional(t.String()),
  }),

  modelConfig: t.Object({
    model: t.String({ minLength: 1 }),
    provider: t.Optional(t.String()),
  }),

  urlMetadata: t.Object({
    url: t.String({ format: 'uri' }),
  }),

  directoryPath: t.Object({
    path: t.String({ minLength: 1 }),
  }),

  createDirectory: t.Object({
    path: t.String({ minLength: 1 }),
    name: t.String({ minLength: 1 }),
  }),

  createFile: t.Object({
    name: t.String({ minLength: 1 }),
  }),

  deletePath: t.Object({
    path: t.String({ minLength: 1 }),
  }),

  screenshotConfig: t.Object({
    workingDirectory: t.String({ minLength: 1 }),
  }),

  notificationQuery: t.Object({
    unreadOnly: t.Optional(t.String({ pattern: '^(true|false)$' })),
    limit: t.Optional(t.String({ pattern: '^[0-9]+$' })),
  }),

  debugLog: t.Object({
    content: t.String({ minLength: 1 }),
    type: t.Optional(t.String()),
    options: t.Optional(t.Record(t.String(), t.Any())),
  }),

  debugLogUrl: t.Object({
    url: t.String({ format: 'uri' }),
    type: t.Optional(t.String()),
    options: t.Optional(t.Record(t.String(), t.Any())),
  }),
};

export const systemQuerySchemas = {
  directoryList: t.Object({
    path: t.String({ minLength: 1 }),
  }),

  notifications: t.Object({
    unreadOnly: t.Optional(t.String({ pattern: '^(true|false)$' })),
    limit: t.Optional(t.String({ pattern: '^[0-9]+$' })),
  }),
};
