-- CreateTable
CREATE TABLE `error_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fingerprint` VARCHAR(40) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `message` TEXT NOT NULL,
    `stack` TEXT NULL,
    `source` VARCHAR(24) NOT NULL,
    `statusCode` INTEGER NULL,
    `method` VARCHAR(10) NULL,
    `route` VARCHAR(255) NULL,
    `requestId` VARCHAR(64) NULL,
    `schoolId` INTEGER NULL,
    `userType` VARCHAR(20) NULL,
    `userId` INTEGER NULL,
    `userAgent` VARCHAR(255) NULL,
    `extra` JSON NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `error_logs_fingerprint_occurredAt_idx`(`fingerprint`, `occurredAt`),
    INDEX `error_logs_occurredAt_idx`(`occurredAt`),
    INDEX `error_logs_requestId_idx`(`requestId`),
    INDEX `error_logs_schoolId_idx`(`schoolId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
