-- CreateTable
CREATE TABLE "tasks" (
    "id" CHAR(24) NOT NULL,
    "tenantId" VARCHAR(128) NOT NULL,
    "ownerId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128),
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000) NOT NULL DEFAULT '',
    "urgent" BOOLEAN NOT NULL,
    "important" BOOLEAN NOT NULL,
    "lifecycleState" VARCHAR(16) NOT NULL DEFAULT 'active',
    "priorLifecycleState" VARCHAR(16),
    "schedule" JSONB,
    "delegation" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createOperationId" VARCHAR(200),
    "createOperationDigest" CHAR(64),
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tasks_title_length" CHECK (char_length("title") BETWEEN 1 AND 200),
    CONSTRAINT "tasks_revision_nonnegative" CHECK ("revision" >= 0),
    CONSTRAINT "tasks_lifecycle_state" CHECK ("lifecycleState" IN ('active', 'completed', 'archived', 'trashed')),
    CONSTRAINT "tasks_prior_lifecycle_state" CHECK ("priorLifecycleState" IS NULL OR "priorLifecycleState" IN ('active', 'completed', 'archived')),
    CONSTRAINT "tasks_operation_digest" CHECK ("createOperationDigest" IS NULL OR "createOperationDigest" ~ '^[a-f0-9]{64}$')
);

-- CreateIndex
CREATE INDEX "tasks_tenantId_ownerId_lifecycleState_createdAt_id_idx" ON "tasks"("tenantId", "ownerId", "lifecycleState", "createdAt", "id");

-- CreateIndex
CREATE INDEX "tasks_tenantId_ownerId_id_revision_idx" ON "tasks"("tenantId", "ownerId", "id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_tenantId_ownerId_createOperationId_key" ON "tasks"("tenantId", "ownerId", "createOperationId");
