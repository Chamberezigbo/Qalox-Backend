-- Real backend for the "Assignment Board" feature, which previously only
-- lived in a teacher's own browser (a Redux slice persisted to localStorage,
-- never synced anywhere) — a teacher's assignment was invisible to every
-- student. See the Assignment model comment in schema.prisma.
--
-- No FOREIGN KEY constraints, matching this schema's relationMode = "prisma":
-- referential actions are enforced by the Prisma client, not the database.
CREATE TABLE `assignments` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `schoolId` INTEGER NOT NULL,
  `classId` INTEGER NOT NULL,
  `subjectId` INTEGER NOT NULL,
  `staffId` INTEGER NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT NULL,
  `dueDate` DATE NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `assignments_schoolId_idx`(`schoolId`),
  INDEX `assignments_classId_idx`(`classId`),
  INDEX `assignments_staffId_idx`(`staffId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
