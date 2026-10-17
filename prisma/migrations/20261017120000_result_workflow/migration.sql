-- DropIndex
DROP INDEX `result_submissions_classId_subjectId_academicSessionId_termI_key` ON `result_submissions`;

-- AlterTable
ALTER TABLE `ClassGroup` ADD COLUMN `staffId` INTEGER NULL;

-- AlterTable
ALTER TABLE `result_submissions` ADD COLUMN `autoAccepted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `classGroupId` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `returnComment` VARCHAR(1000) NULL,
    ADD COLUMN `reviewedAt` DATETIME(3) NULL,
    ADD COLUMN `reviewedByStaffId` INTEGER NULL,
    MODIFY `status` ENUM('PENDING', 'REJECTED', 'SUBMITTED', 'ACCEPTED', 'RETURNED') NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE `class_compilations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `academicSessionId` INTEGER NOT NULL,
    `termId` INTEGER NOT NULL,
    `classGroupId` INTEGER NOT NULL DEFAULT 0,
    `submittedByStaffId` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'SUBMITTED',
    `round` INTEGER NOT NULL DEFAULT 1,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewedByAdminId` INTEGER NULL,
    `reviewedAt` DATETIME(3) NULL,
    `returnComment` VARCHAR(1000) NULL,
    `missingJson` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `class_compilations_schoolId_status_idx`(`schoolId`, `status`),
    UNIQUE INDEX `class_compilations_classId_academicSessionId_termId_classGro_key`(`classId`, `academicSessionId`, `termId`, `classGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `student_term_remarks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `studentId` INTEGER NOT NULL,
    `academicSessionId` INTEGER NOT NULL,
    `termId` INTEGER NOT NULL,
    `classTeacherRemark` VARCHAR(500) NULL,
    `classTeacherStaffId` INTEGER NULL,
    `principalRemark` VARCHAR(500) NULL,
    `principalAdminId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `student_term_remarks_schoolId_termId_idx`(`schoolId`, `termId`),
    UNIQUE INDEX `student_term_remarks_studentId_academicSessionId_termId_key`(`studentId`, `academicSessionId`, `termId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `result_workflow_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `classGroupId` INTEGER NOT NULL DEFAULT 0,
    `subjectId` INTEGER NULL,
    `academicSessionId` INTEGER NOT NULL,
    `termId` INTEGER NULL,
    `submissionId` INTEGER NULL,
    `compilationId` INTEGER NULL,
    `action` VARCHAR(32) NOT NULL,
    `actorType` VARCHAR(10) NOT NULL,
    `actorId` INTEGER NOT NULL,
    `comment` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `result_workflow_events_schoolId_classId_academicSessionId_te_idx`(`schoolId`, `classId`, `academicSessionId`, `termId`),
    INDEX `result_workflow_events_compilationId_idx`(`compilationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `result_submissions_classId_subjectId_academicSessionId_termI_key` ON `result_submissions`(`classId`, `subjectId`, `academicSessionId`, `termId`, `staffId`, `classGroupId`);

