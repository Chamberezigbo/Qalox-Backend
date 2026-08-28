-- A prospective school's submission from the public landing page's "Book a
-- Demo" form. Schools can't self-register — only staff/marketers issue a
-- Token — so this is the queue Super Admin follows up from.
CREATE TABLE `landing_page_leads` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `schoolName` VARCHAR(255) NOT NULL,
  `contactPerson` VARCHAR(255) NOT NULL,
  `position` VARCHAR(100) NULL,
  `phone` VARCHAR(50) NOT NULL,
  `schoolEmail` VARCHAR(255) NOT NULL,
  `personalEmail` VARCHAR(255) NULL,
  `location` VARCHAR(255) NULL,
  `studentCount` VARCHAR(50) NULL,
  `campusCount` INTEGER NULL,
  `currentSystem` VARCHAR(255) NULL,
  `planInterest` VARCHAR(100) NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'new',
  `issuedTokenId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `landing_page_leads_status_idx`(`status`)
) DEFAULT CHARACTER SET utf8mb4;
