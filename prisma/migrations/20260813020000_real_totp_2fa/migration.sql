-- Real RFC 6238 TOTP two-factor authentication.
--
-- Replaces the previous non-functional implementation, which handed every user
-- the same hardcoded secret and accepted any six digits.

-- 1. Per-user 2FA state on the admin record.
ALTER TABLE `admins`
  ADD COLUMN `twoFactorSecret` TEXT NULL,
  ADD COLUMN `twoFactorPendingSecret` TEXT NULL,
  ADD COLUMN `twoFactorPendingExpiresAt` DATETIME(3) NULL,
  ADD COLUMN `twoFactorLastUsedStep` BIGINT NULL,
  ADD COLUMN `twoFactorTempTokenId` VARCHAR(64) NULL,
  ADD COLUMN `twoFactorFailedAttempts` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `twoFactorLockedUntil` DATETIME(3) NULL;

-- 2. Single-use recovery codes (bcrypt hashes only).
CREATE TABLE `two_factor_recovery_codes` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `adminId` INTEGER NOT NULL,
  `codeHash` VARCHAR(255) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `two_factor_recovery_codes_adminId_idx`(`adminId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `two_factor_recovery_codes`
  ADD CONSTRAINT `two_factor_recovery_codes_adminId_fkey`
  FOREIGN KEY (`adminId`) REFERENCES `admins`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Append-only security audit trail.
CREATE TABLE `security_events` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `adminId` INTEGER NOT NULL,
  `event` VARCHAR(64) NOT NULL,
  `detail` VARCHAR(255) NULL,
  `ipAddress` VARCHAR(64) NULL,
  `userAgent` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `security_events_adminId_idx`(`adminId`),
  INDEX `security_events_event_idx`(`event`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `security_events`
  ADD CONSTRAINT `security_events_adminId_fkey`
  FOREIGN KEY (`adminId`) REFERENCES `admins`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Clear the pre-existing dummy enrolments (spec §8).
--
-- Anyone currently flagged twoFactorEnabled = true was "enrolled" against the
-- shared hardcoded secret 'JBSWY3DPEBLW64TMMQ======', which is a published
-- example value and protects nothing. There is no secret worth carrying
-- forward, so every such account is reset to un-enrolled and must re-enrol.
-- The accompanying notification is sent by scripts/reset-dummy-2fa.js.
UPDATE `admins`
  SET `twoFactorEnabled` = false
  WHERE `twoFactorEnabled` = true;
