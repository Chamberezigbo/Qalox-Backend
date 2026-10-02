-- AlterTable
ALTER TABLE `billing_plans` ADD COLUMN `aiCreditsPerTerm` INTEGER NULL;

-- AlterTable
ALTER TABLE `schools` ADD COLUMN `aiCreditsOverride` INTEGER NULL,
    ADD COLUMN `aiCreditsUsedThisTerm` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `scheme_of_work` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NOT NULL,
    `academicTermId` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `sourceType` VARCHAR(16) NOT NULL DEFAULT 'pdf',
    `extractionMethod` VARCHAR(20) NOT NULL DEFAULT 'pdf_parse',
    `creditsCharged` INTEGER NOT NULL DEFAULT 0,
    `extractedText` LONGTEXT NULL,
    `extractedTextStatus` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `extractionError` TEXT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `uploadedByAdminId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `scheme_of_work_schoolId_classId_subjectId_academicTermId_idx`(`schoolId`, `classId`, `subjectId`, `academicTermId`),
    INDEX `scheme_of_work_schoolId_idx`(`schoolId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scheme_of_work_files` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schemeOfWorkId` INTEGER NOT NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `fileUrl` VARCHAR(500) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `fileSize` INTEGER NOT NULL,
    `mimeType` VARCHAR(128) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scheme_of_work_files_schemeOfWorkId_idx`(`schemeOfWorkId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_generation_jobs` (
    `id` VARCHAR(64) NOT NULL,
    `schoolId` INTEGER NOT NULL,
    `staffId` INTEGER NOT NULL,
    `jobType` VARCHAR(24) NOT NULL,
    `schemeOfWorkId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NOT NULL,
    `academicTermId` INTEGER NOT NULL,
    `inputParamsJson` LONGTEXT NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'queued',
    `stage` VARCHAR(64) NOT NULL DEFAULT 'Queued',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` TEXT NULL,
    `model` VARCHAR(64) NOT NULL DEFAULT 'gemini-2.0-flash',
    `estimatedInputTokens` INTEGER NULL,
    `estimatedOutputTokens` INTEGER NULL,
    `actualInputTokens` INTEGER NULL,
    `actualOutputTokens` INTEGER NULL,
    `creditsReserved` INTEGER NOT NULL,
    `creditsCharged` INTEGER NULL,
    `resultLessonNoteId` INTEGER NULL,
    `resultTestId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,

    INDEX `ai_generation_jobs_schoolId_idx`(`schoolId`),
    INDEX `ai_generation_jobs_staffId_idx`(`staffId`),
    INDEX `ai_generation_jobs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lesson_notes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NOT NULL,
    `academicTermId` INTEGER NOT NULL,
    `staffId` INTEGER NOT NULL,
    `schemeOfWorkId` INTEGER NULL,
    `generationJobId` VARCHAR(64) NULL,
    `title` VARCHAR(255) NOT NULL,
    `topic` VARCHAR(255) NULL,
    `objectivesJson` TEXT NULL,
    `content` LONGTEXT NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'draft',
    `source` VARCHAR(24) NOT NULL DEFAULT 'ai_generated',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `lesson_notes_schoolId_classId_subjectId_idx`(`schoolId`, `classId`, `subjectId`),
    INDEX `lesson_notes_staffId_idx`(`staffId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cbt_tests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NOT NULL,
    `academicTermId` INTEGER NOT NULL,
    `createdByStaffId` INTEGER NOT NULL,
    `schemeOfWorkId` INTEGER NULL,
    `generationJobId` VARCHAR(64) NULL,
    `title` VARCHAR(255) NOT NULL,
    `instructions` TEXT NULL,
    `durationMinutes` INTEGER NOT NULL DEFAULT 30,
    `maxAttempts` INTEGER NOT NULL DEFAULT 1,
    `shuffleQuestions` BOOLEAN NOT NULL DEFAULT true,
    `showResultsImmediately` BOOLEAN NOT NULL DEFAULT true,
    `opensAt` DATETIME(3) NULL,
    `closesAt` DATETIME(3) NULL,
    `status` ENUM('draft', 'published', 'closed') NOT NULL DEFAULT 'draft',
    `publishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `cbt_tests_schoolId_classId_subjectId_idx`(`schoolId`, `classId`, `subjectId`),
    INDEX `cbt_tests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cbt_questions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `testId` INTEGER NOT NULL,
    `type` VARCHAR(24) NOT NULL DEFAULT 'multiple_choice',
    `text` TEXT NOT NULL,
    `marks` INTEGER NOT NULL DEFAULT 1,
    `order` INTEGER NOT NULL,
    `explanation` TEXT NULL,

    INDEX `cbt_questions_testId_idx`(`testId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cbt_question_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `questionId` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `isCorrect` BOOLEAN NOT NULL DEFAULT false,
    `order` INTEGER NOT NULL,

    INDEX `cbt_question_options_questionId_idx`(`questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cbt_attempts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `testId` INTEGER NOT NULL,
    `studentId` INTEGER NOT NULL,
    `attemptNumber` INTEGER NOT NULL DEFAULT 1,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadlineAt` DATETIME(3) NOT NULL,
    `submittedAt` DATETIME(3) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'in_progress',
    `score` DECIMAL(65, 30) NULL,
    `totalPossible` DECIMAL(65, 30) NULL,

    INDEX `cbt_attempts_testId_idx`(`testId`),
    INDEX `cbt_attempts_studentId_idx`(`studentId`),
    UNIQUE INDEX `cbt_attempts_testId_studentId_attemptNumber_key`(`testId`, `studentId`, `attemptNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cbt_answers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `attemptId` INTEGER NOT NULL,
    `questionId` INTEGER NOT NULL,
    `selectedOptionId` INTEGER NULL,
    `isCorrect` BOOLEAN NULL,
    `marksAwarded` DECIMAL(65, 30) NULL,
    `answeredAt` DATETIME(3) NOT NULL,

    INDEX `cbt_answers_attemptId_idx`(`attemptId`),
    UNIQUE INDEX `cbt_answers_attemptId_questionId_key`(`attemptId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

