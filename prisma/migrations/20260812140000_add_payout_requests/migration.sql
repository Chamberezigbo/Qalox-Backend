-- Marketer-initiated payout requests, queued for Super Admin approval.
-- New table only — no existing table or row is modified.
CREATE TABLE `payout_requests` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `marketerId` INTEGER NOT NULL,
  `amount` DOUBLE NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `bankName` VARCHAR(100) NULL,
  `bankAccountNumber` VARCHAR(50) NULL,
  `bankAccountName` VARCHAR(255) NULL,
  `note` VARCHAR(255) NULL,
  `rejectionReason` TEXT NULL,
  `reviewedByAdminId` INTEGER NULL,
  `reviewedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `payout_requests_marketerId_idx`(`marketerId`),
  INDEX `payout_requests_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `payout_requests`
  ADD CONSTRAINT `payout_requests_marketerId_fkey`
  FOREIGN KEY (`marketerId`) REFERENCES `admins`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
