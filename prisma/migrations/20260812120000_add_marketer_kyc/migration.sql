-- Marketer KYC verification.
-- Purely additive: every column is nullable, so existing rows are untouched.
-- verificationStatus defaults to 'pending', which is the correct starting state
-- for existing marketers too — none of them have submitted a document yet.
ALTER TABLE `admins`
  ADD COLUMN `verificationStatus` VARCHAR(20) NULL DEFAULT 'pending',
  ADD COLUMN `verificationDocumentType` VARCHAR(20) NULL,
  ADD COLUMN `verificationDocumentPath` VARCHAR(255) NULL,
  ADD COLUMN `verificationSubmittedAt` DATETIME(3) NULL,
  ADD COLUMN `verificationReviewedAt` DATETIME(3) NULL,
  ADD COLUMN `verificationRejectionReason` TEXT NULL;
