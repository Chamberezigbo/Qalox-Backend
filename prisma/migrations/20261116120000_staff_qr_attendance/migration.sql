-- CreateTable
CREATE TABLE `staff_attendance_settings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `qrMode` VARCHAR(10) NOT NULL DEFAULT 'live',
    `qrSecret` TEXT NOT NULL,
    `qrVersion` INTEGER NOT NULL DEFAULT 1,
    `rotatedAt` DATETIME(3) NULL,
    `rotatedById` INTEGER NULL,
    `workStart` VARCHAR(5) NOT NULL DEFAULT '07:30',
    `graceMinutes` INTEGER NOT NULL DEFAULT 15,
    `workEnd` VARCHAR(5) NOT NULL DEFAULT '15:00',
    `workDays` VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5',
    `timezone` VARCHAR(60) NOT NULL DEFAULT 'Africa/Lagos',
    `minStayMinutes` INTEGER NOT NULL DEFAULT 30,
    `radiusMeters` INTEGER NOT NULL DEFAULT 150,
    `requireLocation` BOOLEAN NOT NULL DEFAULT true,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,

    UNIQUE INDEX `staff_attendance_settings_schoolId_key`(`schoolId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_attendance_sites` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `campusId` INTEGER NOT NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `radiusMeters` INTEGER NULL,

    UNIQUE INDEX `staff_attendance_sites_schoolId_campusId_key`(`schoolId`, `campusId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_attendance_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `staffId` INTEGER NOT NULL,
    `campusId` INTEGER NULL,
    `day` VARCHAR(10) NOT NULL,
    `signInAt` DATETIME(3) NULL,
    `signOutAt` DATETIME(3) NULL,
    `signInMethod` VARCHAR(10) NULL,
    `signOutMethod` VARCHAR(10) NULL,
    `status` VARCHAR(15) NOT NULL DEFAULT 'verified',
    `lateMinutes` INTEGER NOT NULL DEFAULT 0,
    `flags` VARCHAR(255) NULL,
    `meta` JSON NULL,
    `reviewedById` INTEGER NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewNote` VARCHAR(255) NULL,
    `manualReason` VARCHAR(255) NULL,
    `enteredById` INTEGER NULL,

    INDEX `staff_attendance_records_schoolId_day_idx`(`schoolId`, `day`),
    INDEX `staff_attendance_records_schoolId_status_idx`(`schoolId`, `status`),
    UNIQUE INDEX `staff_attendance_records_staffId_day_key`(`staffId`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_attendance_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `staffId` INTEGER NULL,
    `actorType` VARCHAR(10) NOT NULL,
    `actorId` INTEGER NULL,
    `type` VARCHAR(25) NOT NULL,
    `detail` JSON NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `staff_attendance_events_schoolId_occurredAt_idx`(`schoolId`, `occurredAt`),
    INDEX `staff_attendance_events_staffId_idx`(`staffId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_devices` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `staffId` INTEGER NOT NULL,
    `deviceHash` VARCHAR(64) NOT NULL,
    `label` VARCHAR(120) NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'trusted',
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `staff_devices_schoolId_status_idx`(`schoolId`, `status`),
    UNIQUE INDEX `staff_devices_staffId_deviceHash_key`(`staffId`, `deviceHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gate_screens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `campusId` INTEGER NULL,
    `name` VARCHAR(100) NOT NULL,
    `keyHash` VARCHAR(64) NOT NULL,
    `pairCode` VARCHAR(6) NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'pending',
    `pairedById` INTEGER NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `gate_screens_schoolId_idx`(`schoolId`),
    UNIQUE INDEX `gate_screens_keyHash_key`(`keyHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

