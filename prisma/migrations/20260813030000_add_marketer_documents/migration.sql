-- Marketer identity documents, one row per upload.
--
-- Replaces the "one document per marketer" shape of the verification* columns
-- on `admins`. Those columns stay and keep being written (they mirror the
-- LATEST document) so the Marketer Portal's profile view is unaffected.
--
-- `path` is a filename inside res/uploads-private/kyc, never a public URL.
CREATE TABLE `marketer_documents` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `marketerId` INTEGER NOT NULL,
  `type` VARCHAR(30) NOT NULL,
  `path` VARCHAR(255) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `rejectionReason` TEXT NULL,
  `reviewedAt` DATETIME(3) NULL,
  `reviewedBy` INTEGER NULL,
  `uploadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `marketer_documents_marketerId_idx`(`marketerId`),
  INDEX `marketer_documents_status_uploadedAt_idx`(`status`, `uploadedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `marketer_documents`
  ADD CONSTRAINT `marketer_documents_marketerId_fkey`
  FOREIGN KEY (`marketerId`) REFERENCES `admins`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry every already-uploaded KYC document into the new table so the Super
-- Admin queue is not empty on day one. The legacy document-type vocabulary
-- (nin | passport | drivers | voters) maps onto the portal's vocabulary:
-- everything that is a photo ID card becomes 'id_card'; a passport stays a
-- passport. COALESCE on the timestamps because verificationSubmittedAt was
-- nullable on rows written before it was added.
INSERT INTO `marketer_documents`
  (`marketerId`, `type`, `path`, `status`, `rejectionReason`, `reviewedAt`, `uploadedAt`, `updatedAt`)
SELECT
  `id`,
  CASE `verificationDocumentType`
    WHEN 'passport' THEN 'passport'
    WHEN 'nin'      THEN 'id_card'
    WHEN 'drivers'  THEN 'id_card'
    WHEN 'voters'   THEN 'id_card'
    ELSE 'other'
  END,
  `verificationDocumentPath`,
  COALESCE(`verificationStatus`, 'pending'),
  `verificationRejectionReason`,
  `verificationReviewedAt`,
  COALESCE(`verificationSubmittedAt`, `createdAt`),
  COALESCE(`verificationSubmittedAt`, `createdAt`)
FROM `admins`
WHERE `role` = 'marketer'
  AND `verificationDocumentPath` IS NOT NULL;

-- Audit trail for marketer suspension. Both nullable: existing suspended rows
-- predate the columns and genuinely have no recorded actor or reason.
ALTER TABLE `admins`
  ADD COLUMN `suspensionReason` VARCHAR(500) NULL,
  ADD COLUMN `suspendedBy` INTEGER NULL;

-- Audit trail for Super Admin wallet operations.
ALTER TABLE `wallet_transactions`
  ADD COLUMN `performedByAdminId` INTEGER NULL;
