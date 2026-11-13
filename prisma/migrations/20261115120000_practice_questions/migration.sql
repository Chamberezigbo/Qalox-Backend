-- CreateTable
CREATE TABLE `practice_questions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `exam` VARCHAR(20) NOT NULL,
    `subject` VARCHAR(80) NOT NULL,
    `topic` VARCHAR(120) NULL,
    `year` INTEGER NULL,
    `source` VARCHAR(16) NOT NULL DEFAULT 'ai_practice',
    `text` TEXT NOT NULL,
    `explanation` TEXT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'needs_review',
    `reportCount` INTEGER NOT NULL DEFAULT 0,
    `contentHash` VARCHAR(40) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `practice_questions_exam_subject_status_idx`(`exam`, `subject`, `status`),
    INDEX `practice_questions_exam_subject_year_idx`(`exam`, `subject`, `year`),
    UNIQUE INDEX `practice_questions_exam_subject_contentHash_key`(`exam`, `subject`, `contentHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `practice_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `questionId` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `isCorrect` BOOLEAN NOT NULL DEFAULT false,
    `order` INTEGER NOT NULL,

    INDEX `practice_options_questionId_idx`(`questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `practice_reports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `questionId` INTEGER NOT NULL,
    `studentId` INTEGER NOT NULL,
    `reason` VARCHAR(200) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `practice_reports_questionId_studentId_key`(`questionId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `practice_sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `studentId` INTEGER NOT NULL,
    `schoolId` INTEGER NOT NULL,
    `exam` VARCHAR(20) NOT NULL,
    `subject` VARCHAR(80) NOT NULL,
    `mode` VARCHAR(10) NOT NULL,
    `topic` VARCHAR(120) NULL,
    `year` INTEGER NULL,
    `questionIds` JSON NOT NULL,
    `durationMinutes` INTEGER NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadlineAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'in_progress',
    `score` INTEGER NULL,
    `total` INTEGER NOT NULL,

    INDEX `practice_sessions_studentId_startedAt_idx`(`studentId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `practice_answers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `sessionId` INTEGER NOT NULL,
    `questionId` INTEGER NOT NULL,
    `selectedOptionId` INTEGER NULL,
    `isCorrect` BOOLEAN NULL,
    `answeredAt` DATETIME(3) NOT NULL,

    INDEX `practice_answers_questionId_idx`(`questionId`),
    UNIQUE INDEX `practice_answers_sessionId_questionId_key`(`sessionId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
