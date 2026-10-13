-- AlterTable
ALTER TABLE `classes` ADD COLUMN `passMark` DOUBLE NULL,
    ADD COLUMN `promotesToClassId` INTEGER NULL;

-- CreateTable
CREATE TABLE `student_enrollments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `studentId` INTEGER NOT NULL,
    `academicSessionId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `classGroupId` INTEGER NULL,
    `campusId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `student_enrollments_schoolId_idx`(`schoolId`),
    INDEX `student_enrollments_classId_academicSessionId_idx`(`classId`, `academicSessionId`),
    UNIQUE INDEX `student_enrollments_studentId_academicSessionId_key`(`studentId`, `academicSessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


-- Backfill: one history row per existing student, for the session they are in
-- now. INSERT IGNORE plus the unique (studentId, academicSessionId) index makes
-- this safe to run again.
INSERT IGNORE INTO `student_enrollments`
    (`schoolId`, `studentId`, `academicSessionId`, `classId`, `classGroupId`, `campusId`, `createdAt`, `updatedAt`)
SELECT `schoolId`, `id`, `academicSessionId`, `classId`, `classGroupId`, `campusId`, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `students`;
