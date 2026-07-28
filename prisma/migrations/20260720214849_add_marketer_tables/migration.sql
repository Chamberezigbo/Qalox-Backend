-- CreateTable
CREATE TABLE `admins` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NULL,
    `campusId` INTEGER NULL,
    `name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `password` VARCHAR(255) NOT NULL,
    `steps` INTEGER NOT NULL DEFAULT 0,
    `role` ENUM('super_admin', 'school_admin', 'marketer') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `hasLoggedIn` BOOLEAN NOT NULL DEFAULT false,
    `tier` VARCHAR(50) NULL,
    `referralCode` VARCHAR(50) NULL,
    `avatar` VARCHAR(255) NULL,
    `phone` VARCHAR(20) NULL,
    `address` TEXT NULL,
    `city` VARCHAR(100) NULL,
    `state` VARCHAR(100) NULL,
    `bankName` VARCHAR(100) NULL,
    `bankAccountNumber` VARCHAR(50) NULL,
    `bankAccountName` VARCHAR(255) NULL,
    `isEmailVerified` BOOLEAN NOT NULL DEFAULT false,
    `isSuspended` BOOLEAN NOT NULL DEFAULT false,
    `suspendedAt` DATETIME(3) NULL,
    `commissionRate` DOUBLE NULL DEFAULT 0.0,
    `commissionStructure` VARCHAR(50) NULL,
    `walletBalance` DOUBLE NULL DEFAULT 0.0,
    `walletPending` DOUBLE NULL DEFAULT 0.0,
    `totalEarned` DOUBLE NULL DEFAULT 0.0,
    `totalWithdrawn` DOUBLE NULL DEFAULT 0.0,
    `transactionCount` INTEGER NOT NULL DEFAULT 0,
    `lastPayoutDate` DATETIME(3) NULL,

    UNIQUE INDEX `admins_email_key`(`email`),
    UNIQUE INDEX `admins_referralCode_key`(`referralCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `schools` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `prefix` VARCHAR(10) NOT NULL,
    `logoUrl` VARCHAR(255) NULL,
    `stampUrl` VARCHAR(255) NULL,
    `email` VARCHAR(255) NULL,
    `phoneNumber` VARCHAR(50) NULL,
    `address` TEXT NULL,
    `isSuspended` BOOLEAN NOT NULL DEFAULT false,
    `suspendedAt` DATETIME(3) NULL,
    `suspensionReason` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `schools_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tokens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(255) NOT NULL,
    `uniqueKey` VARCHAR(255) NOT NULL,
    `status` VARCHAR(50) NULL,
    `schoolName` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `tokens_email_key`(`email`),
    UNIQUE INDEX `tokens_uniqueKey_key`(`uniqueKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campuses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `address` TEXT NULL,
    `phoneNumber` VARCHAR(50) NULL,
    `email` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `campuses_schoolId_name_key`(`schoolId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `classes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `campusId` INTEGER NULL,
    `name` VARCHAR(191) NOT NULL,
    `customName` VARCHAR(191) NULL,
    `staffId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `classes_name_schoolId_campusId_key`(`name`, `schoolId`, `campusId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ClassGroup` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `classId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staffs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `campusId` INTEGER NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `gender` VARCHAR(191) NULL,
    `phoneNumber` VARCHAR(191) NULL,
    `address` VARCHAR(191) NULL,
    `duty` VARCHAR(191) NULL,
    `nextOfKin` VARCHAR(191) NULL,
    `dateEmployed` DATETIME(3) NULL,
    `payroll` DECIMAL(65, 30) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `registrationNumber` VARCHAR(50) NOT NULL,

    UNIQUE INDEX `staffs_email_key`(`email`),
    UNIQUE INDEX `staffs_registrationNumber_key`(`registrationNumber`),
    UNIQUE INDEX `staffs_schoolId_registrationNumber_key`(`schoolId`, `registrationNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `students` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `campusId` INTEGER NULL,
    `classId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `surname` VARCHAR(191) NOT NULL,
    `otherNames` VARCHAR(191) NOT NULL,
    `gender` VARCHAR(10) NULL,
    `dateOfBirth` VARCHAR(191) NULL,
    `guardianName` VARCHAR(191) NULL,
    `guardianNumber` VARCHAR(191) NULL,
    `lifestyle` VARCHAR(191) NULL,
    `academicSessionId` INTEGER NOT NULL,
    `email` VARCHAR(191) NULL,
    `classGroupId` INTEGER NULL,
    `registrationNumber` VARCHAR(50) NOT NULL,
    `passportUrl` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `students_registrationNumber_key`(`registrationNumber`),
    UNIQUE INDEX `students_schoolId_registrationNumber_key`(`schoolId`, `registrationNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subjects` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `campusId` INTEGER NULL,
    `name` VARCHAR(255) NOT NULL,
    `code` VARCHAR(50) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `teacher_assignments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `staffId` INTEGER NOT NULL,
    `classId` INTEGER NULL,
    `subjectId` INTEGER NULL,
    `campusId` INTEGER NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TeacherAssignment_unique`(`staffId`, `classId`, `subjectId`, `campusId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ca_templates` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `classId` INTEGER NULL,
    `name` VARCHAR(191) NOT NULL,
    `maxScore` INTEGER NOT NULL,
    `isExam` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `ca_templates_schoolId_classId_name_key`(`schoolId`, `classId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `class_subjects` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NOT NULL,

    UNIQUE INDEX `class_subjects_classId_subjectId_key`(`classId`, `subjectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `continuous_assessments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NULL,
    `name` VARCHAR(50) NOT NULL,
    `maxScore` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdByAdminId` INTEGER NULL,

    UNIQUE INDEX `continuous_assessments_classId_subjectId_name_key`(`classId`, `subjectId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ca_results` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `studentId` INTEGER NULL,
    `caId` INTEGER NOT NULL,
    `academicSessionId` INTEGER NOT NULL,
    `termId` INTEGER NULL,
    `score` DECIMAL(65, 30) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ca_results_studentId_caId_academicSessionId_key`(`studentId`, `caId`, `academicSessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exams` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NULL,
    `name` VARCHAR(50) NOT NULL,
    `weightage` DECIMAL(65, 30) NULL,
    `maxScore` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdByAdminId` INTEGER NULL,
    `scheduledDate` DATETIME(3) NULL,

    UNIQUE INDEX `exams_classId_subjectId_name_key`(`classId`, `subjectId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exam_results` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `studentId` INTEGER NULL,
    `examId` INTEGER NOT NULL,
    `academicSessionId` INTEGER NOT NULL,
    `termId` INTEGER NULL,
    `score` DECIMAL(65, 30) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `exam_results_studentId_examId_academicSessionId_key`(`studentId`, `examId`, `academicSessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `grading_schemes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `usePosition` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `campusId` INTEGER NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `grading_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schemeId` INTEGER NOT NULL,
    `minScore` INTEGER NOT NULL,
    `maxScore` INTEGER NOT NULL,
    `grade` VARCHAR(191) NOT NULL,
    `remark` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GradingSchemeClass` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schemeId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,

    UNIQUE INDEX `GradingSchemeClass_classId_key`(`classId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `remark_schemes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `remark_schemes_schoolId_key`(`schoolId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `remark_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schemeId` INTEGER NOT NULL,
    `minScore` INTEGER NOT NULL,
    `maxScore` INTEGER NOT NULL,
    `remark` TEXT NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `academic_sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `academic_sessions_schoolId_name_key`(`schoolId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `published_results` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NOT NULL,
    `academicSessionId` INTEGER NOT NULL,
    `termId` INTEGER NULL,
    `publishedByAdminId` INTEGER NOT NULL,
    `publishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `published_results_classId_subjectId_academicSessionId_key`(`classId`, `subjectId`, `academicSessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `published_result_rows` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `publishedResultId` INTEGER NOT NULL,
    `studentId` INTEGER NOT NULL,
    `caTotal` DOUBLE NOT NULL,
    `examTotal` DOUBLE NOT NULL,
    `total` DOUBLE NOT NULL,
    `grade` VARCHAR(191) NULL,
    `remark` VARCHAR(191) NULL,
    `position` INTEGER NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `result_submissions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `classId` INTEGER NOT NULL,
    `subjectId` INTEGER NOT NULL,
    `academicSessionId` INTEGER NOT NULL,
    `termId` INTEGER NULL,
    `staffId` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `result_submissions_classId_subjectId_academicSessionId_staff_key`(`classId`, `subjectId`, `academicSessionId`, `staffId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `academic_terms` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `sessionId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `resumptionDate` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `academic_terms_schoolId_sessionId_name_key`(`schoolId`, `sessionId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `school_tokens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `schoolName` VARCHAR(255) NOT NULL,
    `schoolEmail` VARCHAR(255) NOT NULL,
    `pupil` VARCHAR(255) NULL,
    `class` VARCHAR(100) NULL,
    `subject` VARCHAR(100) NULL,
    `status` VARCHAR(50) NOT NULL DEFAULT 'active',
    `issuedDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiryDate` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `school_tokens_code_key`(`code`),
    INDEX `school_tokens_status_idx`(`status`),
    INDEX `school_tokens_schoolName_idx`(`schoolName`),
    INDEX `school_tokens_expiryDate_idx`(`expiryDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commissions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `marketerId` INTEGER NOT NULL,
    `amount` DOUBLE NOT NULL DEFAULT 0.0,
    `rate` DOUBLE NOT NULL DEFAULT 0.0,
    `status` VARCHAR(50) NOT NULL DEFAULT 'pending',
    `month` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `source` VARCHAR(100) NOT NULL,
    `description` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `commissions_marketerId_idx`(`marketerId`),
    INDEX `commissions_year_month_idx`(`year`, `month`),
    INDEX `commissions_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `marketerId` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `message` TEXT NOT NULL,
    `type` VARCHAR(50) NOT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `link` VARCHAR(255) NULL,
    `relatedId` INTEGER NULL,
    `relatedType` VARCHAR(50) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `notifications_marketerId_idx`(`marketerId`),
    INDEX `notifications_isRead_idx`(`isRead`),
    INDEX `notifications_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
