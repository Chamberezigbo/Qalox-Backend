-- Real backend support for the "Schedule Exam" wizard, which previously
-- persisted nothing (see exams.view.tsx's TODO). A timetabled sitting
-- ("First Term Examination 2025/2026") spanning many classes/subjects, kept
-- separate from `exams` (a per-class-subject grading line item generated
-- from CA templates) — see the ExamSchedule model comment in schema.prisma.
--
-- No FOREIGN KEY constraints, matching this schema's relationMode = "prisma":
-- referential actions (including the entries cascade-delete) are enforced by
-- the Prisma client, not the database.
CREATE TABLE `exam_schedules` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `schoolId` INTEGER NOT NULL,
  `campusId` INTEGER NOT NULL,
  `academicSessionId` INTEGER NOT NULL,
  `examType` VARCHAR(80) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `description` VARCHAR(300) NULL,
  `schedulingMethod` ENUM('same_schedule', 'default_with_overrides', 'auto', 'fully_custom') NOT NULL,
  `status` ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
  `createdByAdminId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `publishedAt` DATETIME(3) NULL,

  INDEX `exam_schedules_schoolId_idx`(`schoolId`),
  INDEX `exam_schedules_campusId_idx`(`campusId`),
  INDEX `exam_schedules_academicSessionId_idx`(`academicSessionId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `exam_schedule_entries` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `examScheduleId` INTEGER NOT NULL,
  `classId` INTEGER NOT NULL,
  `subjectId` INTEGER NOT NULL,
  `date` DATE NOT NULL,
  `startTime` VARCHAR(5) NOT NULL,
  `durationMinutes` INTEGER NOT NULL,
  `linkedExamId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `exam_schedule_entries_examScheduleId_classId_subjectId_key`(`examScheduleId`, `classId`, `subjectId`),
  INDEX `exam_schedule_entries_classId_idx`(`classId`),
  INDEX `exam_schedule_entries_subjectId_idx`(`subjectId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
