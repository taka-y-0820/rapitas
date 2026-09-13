CREATE TABLE "RequirementReviewClaim" (
    "id" SERIAL NOT NULL,
    "taskId" INTEGER NOT NULL,
    "snapshotDigest" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "claimToken" TEXT NOT NULL,
    "ownerInstanceId" TEXT NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "resultJson" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RequirementReviewClaim_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequirementReviewRetryRequest" (
    "id" SERIAL NOT NULL,
    "requestId" TEXT NOT NULL,
    "taskId" INTEGER NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequirementReviewRetryRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RequirementReviewClaim_taskId_snapshotDigest_key"
ON "RequirementReviewClaim"("taskId", "snapshotDigest");
CREATE INDEX "RequirementReviewClaim_taskId_status_idx" ON "RequirementReviewClaim"("taskId", "status");
CREATE UNIQUE INDEX "RequirementReviewRetryRequest_requestId_key" ON "RequirementReviewRetryRequest"("requestId");
CREATE INDEX "RequirementReviewRetryRequest_taskId_createdAt_idx" ON "RequirementReviewRetryRequest"("taskId", "createdAt");
ALTER TABLE "RequirementReviewClaim" ADD CONSTRAINT "RequirementReviewClaim_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementReviewRetryRequest" ADD CONSTRAINT "RequirementReviewRetryRequest_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
