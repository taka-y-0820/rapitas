CREATE TABLE IF NOT EXISTS "RequirementReviewClaim" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "taskId" INTEGER NOT NULL,
  "snapshotDigest" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "claimToken" TEXT NOT NULL,
  "ownerInstanceId" TEXT NOT NULL,
  "heartbeatAt" DATETIME NOT NULL,
  "resultJson" TEXT,
  "reason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RequirementReviewClaim_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RequirementReviewClaim_taskId_snapshotDigest_key"
  ON "RequirementReviewClaim"("taskId", "snapshotDigest");
CREATE INDEX IF NOT EXISTS "RequirementReviewClaim_taskId_status_idx"
  ON "RequirementReviewClaim"("taskId", "status");

CREATE TABLE IF NOT EXISTS "RequirementReviewRetryRequest" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "requestId" TEXT NOT NULL,
  "taskId" INTEGER NOT NULL,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RequirementReviewRetryRequest_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RequirementReviewRetryRequest_requestId_key"
  ON "RequirementReviewRetryRequest"("requestId");
CREATE INDEX IF NOT EXISTS "RequirementReviewRetryRequest_taskId_createdAt_idx"
  ON "RequirementReviewRetryRequest"("taskId", "createdAt");
