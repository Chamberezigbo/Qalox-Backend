-- AlterTable
ALTER TABLE `payments` ADD COLUMN `channel` VARCHAR(20) NOT NULL DEFAULT 'bank_transfer',
    ADD COLUMN `chargedAmount` DOUBLE NULL,
    ADD COLUMN `flwTransactionId` VARCHAR(100) NULL,
    ADD COLUMN `payerId` INTEGER NULL,
    ADD COLUMN `payerType` VARCHAR(10) NULL,
    ADD COLUMN `serviceCharge` DOUBLE NULL;

-- CreateTable
CREATE TABLE `school_fee_settings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `schoolId` INTEGER NOT NULL,
    `mode` VARCHAR(10) NOT NULL DEFAULT 'direct',
    `settlementBankAccountId` INTEGER NULL,
    `flwSubaccountId` VARCHAR(64) NULL,
    `serviceChargePercent` DOUBLE NULL,
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `school_fee_settings_schoolId_key`(`schoolId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `payments_channel_idx` ON `payments`(`channel`);
