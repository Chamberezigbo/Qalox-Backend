-- Teachers can now upload a scheme of work, not just admins.
--
-- uploadedByAdminId becomes nullable and uploadedByStaffId is added alongside
-- it; a row carries exactly one of the two. Both changes are additive — the
-- NULL relaxation only loosens an existing constraint, so rows already in the
-- table stay valid and keep their admin uploader.

-- AlterTable
ALTER TABLE `scheme_of_work` ADD COLUMN `uploadedByStaffId` INTEGER NULL,
    MODIFY `uploadedByAdminId` INTEGER NULL;

-- CreateIndex
CREATE INDEX `scheme_of_work_uploadedByStaffId_idx` ON `scheme_of_work`(`uploadedByStaffId`);
