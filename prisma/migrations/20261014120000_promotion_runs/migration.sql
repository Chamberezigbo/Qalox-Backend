-- CreateTable
CREATE TABLE `promotion_policies` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `basis` VARCHAR(16) NOT NULL DEFAULT 'all_terms',
    `trialMargin` DOUBLE NULL DEFAULT 5,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `promotion_policies_schoolId_key`(`schoolId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `classId` INTEGER NOT NULL,
    `fromSessionId` INTEGER NOT NULL,
    `toSessionId` INTEGER NOT NULL,
    `createdByAdminId` INTEGER NULL,
    `studentCount` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `undoneAt` DATETIME(3) NULL,

    INDEX `promotion_runs_schoolId_idx`(`schoolId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_run_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `studentId` INTEGER NOT NULL,
    `outcome` VARCHAR(16) NOT NULL,
    `average` DOUBLE NULL,
    `overrideReason` VARCHAR(255) NULL,
    `fromClassId` INTEGER NOT NULL,
    `fromGroupId` INTEGER NULL,
    `fromCampusId` INTEGER NULL,
    `fromSessionId` INTEGER NOT NULL,
    `fromStatus` VARCHAR(16) NOT NULL DEFAULT 'active',
    `toClassId` INTEGER NULL,
    `toGroupId` INTEGER NULL,
    `toCampusId` INTEGER NULL,
    `createdFeeIdsJson` TEXT NULL,

    INDEX `promotion_run_items_runId_idx`(`runId`),
    INDEX `promotion_run_items_studentId_idx`(`studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

