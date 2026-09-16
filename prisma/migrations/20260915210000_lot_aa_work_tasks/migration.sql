-- Lot AA: the DR 10 Tasks section — projects, tasks, assignees, reviewers, dependencies, comments, time logs, issues.
ALTER TYPE "PartyType" ADD VALUE 'TASK';
ALTER TYPE "PartyType" ADD VALUE 'ISSUE';
ALTER TYPE "PartyType" ADD VALUE 'PROJECT';
ALTER TYPE "NotificationType" ADD VALUE 'WORK';
CREATE TYPE "WorkProjectKind" AS ENUM ('DEPARTMENT', 'REGION');
CREATE TYPE "WorkTaskStatus" AS ENUM ('DRAFT', 'TODO', 'IN_PROGRESS', 'PENDING_REVIEW', 'VERIFIED', 'BLOCKED', 'ARCHIVED');
CREATE TYPE "WorkPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "WorkIssueStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX');
CREATE TYPE "WorkIssueSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

CREATE TABLE "WorkProject" (
  "id" TEXT NOT NULL, "displayId" TEXT, "name" TEXT NOT NULL, "description" TEXT, "kind" "WorkProjectKind" NOT NULL,
  "departmentId" TEXT, "cityId" TEXT, "ownerUserId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "startsAt" TIMESTAMP(3), "endsAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkProject_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkProject_displayId_key" ON "WorkProject"("displayId");
CREATE INDEX "WorkProject_kind_status_idx" ON "WorkProject"("kind", "status");
CREATE INDEX "WorkProject_cityId_idx" ON "WorkProject"("cityId");
CREATE INDEX "WorkProject_departmentId_idx" ON "WorkProject"("departmentId");

CREATE TABLE "WorkTask" (
  "id" TEXT NOT NULL, "displayId" TEXT, "projectId" TEXT, "parentTaskId" TEXT, "title" TEXT NOT NULL, "description" TEXT,
  "status" "WorkTaskStatus" NOT NULL DEFAULT 'TODO', "priority" "WorkPriority" NOT NULL DEFAULT 'MEDIUM', "progress" INTEGER NOT NULL DEFAULT 0,
  "startDate" TIMESTAMP(3), "deadline" TIMESTAMP(3), "actualStartDate" TIMESTAMP(3), "revisedEndDate" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "effortEstimateH" DECIMAL(8,2), "linkedKind" TEXT, "linkedId" TEXT, "recurrence" JSONB, "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdById" TEXT NOT NULL, "assignedById" TEXT, "blockedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkTask_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkTask_displayId_key" ON "WorkTask"("displayId");
CREATE INDEX "WorkTask_projectId_status_idx" ON "WorkTask"("projectId", "status");
CREATE INDEX "WorkTask_status_deadline_idx" ON "WorkTask"("status", "deadline");
CREATE INDEX "WorkTask_parentTaskId_idx" ON "WorkTask"("parentTaskId");
CREATE INDEX "WorkTask_linkedKind_linkedId_idx" ON "WorkTask"("linkedKind", "linkedId");
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "WorkProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkTask" ADD CONSTRAINT "WorkTask_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "WorkTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WorkTaskAssignee" ("taskId" TEXT NOT NULL, "userId" TEXT NOT NULL, "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "WorkTaskAssignee_pkey" PRIMARY KEY ("taskId", "userId"));
CREATE INDEX "WorkTaskAssignee_userId_idx" ON "WorkTaskAssignee"("userId");
ALTER TABLE "WorkTaskAssignee" ADD CONSTRAINT "WorkTaskAssignee_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkTaskReviewer" ("taskId" TEXT NOT NULL, "userId" TEXT NOT NULL, "approver" BOOLEAN NOT NULL DEFAULT false, "approvedAt" TIMESTAMP(3), "rejectedAt" TIMESTAMP(3), "note" TEXT, CONSTRAINT "WorkTaskReviewer_pkey" PRIMARY KEY ("taskId", "userId"));
CREATE INDEX "WorkTaskReviewer_userId_idx" ON "WorkTaskReviewer"("userId");
ALTER TABLE "WorkTaskReviewer" ADD CONSTRAINT "WorkTaskReviewer_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkTaskDependency" ("taskId" TEXT NOT NULL, "prerequisiteId" TEXT NOT NULL, CONSTRAINT "WorkTaskDependency_pkey" PRIMARY KEY ("taskId", "prerequisiteId"));
CREATE INDEX "WorkTaskDependency_prerequisiteId_idx" ON "WorkTaskDependency"("prerequisiteId");
ALTER TABLE "WorkTaskDependency" ADD CONSTRAINT "WorkTaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkTaskDependency" ADD CONSTRAINT "WorkTaskDependency_prerequisiteId_fkey" FOREIGN KEY ("prerequisiteId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkTaskComment" ("id" TEXT NOT NULL, "taskId" TEXT NOT NULL, "authorId" TEXT NOT NULL, "body" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "WorkTaskComment_pkey" PRIMARY KEY ("id"));
CREATE INDEX "WorkTaskComment_taskId_createdAt_idx" ON "WorkTaskComment"("taskId", "createdAt");
ALTER TABLE "WorkTaskComment" ADD CONSTRAINT "WorkTaskComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkTimeLog" ("id" TEXT NOT NULL, "taskId" TEXT NOT NULL, "userId" TEXT NOT NULL, "forDate" TIMESTAMP(3) NOT NULL, "hours" DECIMAL(6,2) NOT NULL, "billable" BOOLEAN NOT NULL DEFAULT false, "note" TEXT, "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "WorkTimeLog_pkey" PRIMARY KEY ("id"));
CREATE INDEX "WorkTimeLog_taskId_forDate_idx" ON "WorkTimeLog"("taskId", "forDate");
CREATE INDEX "WorkTimeLog_userId_forDate_idx" ON "WorkTimeLog"("userId", "forDate");
ALTER TABLE "WorkTimeLog" ADD CONSTRAINT "WorkTimeLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkIssue" (
  "id" TEXT NOT NULL, "displayId" TEXT, "projectId" TEXT, "taskId" TEXT, "title" TEXT NOT NULL, "description" TEXT,
  "severity" "WorkIssueSeverity" NOT NULL DEFAULT 'MEDIUM', "status" "WorkIssueStatus" NOT NULL DEFAULT 'OPEN',
  "raisedById" TEXT NOT NULL, "assigneeId" TEXT, "resolution" TEXT, "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkIssue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkIssue_displayId_key" ON "WorkIssue"("displayId");
CREATE INDEX "WorkIssue_status_severity_idx" ON "WorkIssue"("status", "severity");
CREATE INDEX "WorkIssue_taskId_idx" ON "WorkIssue"("taskId");
CREATE INDEX "WorkIssue_assigneeId_status_idx" ON "WorkIssue"("assigneeId", "status");
ALTER TABLE "WorkIssue" ADD CONSTRAINT "WorkIssue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "WorkProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkIssue" ADD CONSTRAINT "WorkIssue_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "WorkTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
