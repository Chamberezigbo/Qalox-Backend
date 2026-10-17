-- AlterTable
ALTER TABLE `admins` ADD COLUMN `allCampuses` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `admin_campus_access` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `adminId` INTEGER NOT NULL,
    `campusId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `admin_campus_access_campusId_idx`(`campusId`),
    UNIQUE INDEX `admin_campus_access_adminId_campusId_key`(`adminId`, `campusId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

