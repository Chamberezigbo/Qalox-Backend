-- AlterTable
ALTER TABLE `school_payments` ADD COLUMN `creditPackId` INTEGER NULL,
    ADD COLUMN `creditsGranted` INTEGER NULL,
    ADD COLUMN `purpose` VARCHAR(20) NOT NULL DEFAULT 'subscription';

-- AlterTable
ALTER TABLE `schools` ADD COLUMN `aiCreditsPurchased` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `ai_credit_packs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `credits` INTEGER NOT NULL,
    `price` DOUBLE NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

