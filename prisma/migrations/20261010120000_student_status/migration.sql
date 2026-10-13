-- AlterTable
ALTER TABLE `students` ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    ADD COLUMN `withdrawnAt` DATETIME(3) NULL,
    ADD COLUMN `withdrawnReason` VARCHAR(255) NULL;

