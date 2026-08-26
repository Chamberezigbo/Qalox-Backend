-- Direct bank-transfer fee payment: a school's own bank account(s) that
-- parents/students transfer into and declare, replacing the previous
-- Flutterwave-virtual-account flow for school fees (Flutterwave stays for
-- the school's own Qalox subscription billing — a separate model, untouched).
--
-- No FOREIGN KEY constraints, matching this schema's relationMode = "prisma":
-- referential actions are enforced by the Prisma client, not the database.
CREATE TABLE `school_bank_accounts` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `schoolId` INTEGER NOT NULL,
  `bankName` VARCHAR(100) NOT NULL,
  `accountName` VARCHAR(255) NOT NULL,
  `accountNumber` VARCHAR(20) NOT NULL,
  `label` VARCHAR(100) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `school_bank_accounts_schoolId_idx`(`schoolId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Which account a parent/student claims to have paid into (declared
-- payments only — null for admin-recorded and legacy Flutterwave payments),
-- and why an admin rejected a declared payment, if they did.
ALTER TABLE `payments`
  ADD COLUMN `bankAccountId` INTEGER NULL,
  ADD COLUMN `rejectionReason` VARCHAR(255) NULL;

CREATE INDEX `payments_bankAccountId_idx` ON `payments`(`bankAccountId`);
