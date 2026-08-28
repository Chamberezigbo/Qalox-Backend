-- SMS quota is now derived from the school's active BillingPlan instead of
-- being a manually-set number. Add the plan-level quota (null = mirror
-- maxStudents), then set it explicitly for Premium since maxStudents is null
-- (unlimited) there.
ALTER TABLE `billing_plans` ADD COLUMN `smsQuotaPerTerm` INTEGER NULL;
UPDATE `billing_plans` SET `smsQuotaPerTerm` = 2500 WHERE `name` = 'Premium';

-- Repurpose the old per-school manual quota column into a manual override
-- (null = no override, defer to the plan). Every existing row currently holds
-- the untouched default of 300 — there's no way to distinguish "Super Admin
-- deliberately overrode this" from "never touched", so this wipes it to NULL.
-- The manual-override endpoint has seen negligible real use to date.
ALTER TABLE `schools` CHANGE COLUMN `smsQuotaPerTerm` `smsQuotaOverride` INTEGER NULL DEFAULT NULL;
UPDATE `schools` SET `smsQuotaOverride` = NULL;

-- Launch-campaign coupon codes: redeeming one grants a school N free days on
-- a specific plan.
CREATE TABLE `coupons` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(50) NOT NULL,
  `billingPlanId` INTEGER NOT NULL,
  `freeDays` INTEGER NOT NULL DEFAULT 30,
  `maxRedemptions` INTEGER NULL,
  `redemptionCount` INTEGER NOT NULL DEFAULT 0,
  `expiresAt` DATETIME(3) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdByAdminId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `coupons_code_key`(`code`),
  PRIMARY KEY (`id`),
  INDEX `coupons_code_idx`(`code`)
) DEFAULT CHARACTER SET utf8mb4;

CREATE TABLE `coupon_redemptions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `couponId` INTEGER NOT NULL,
  `schoolId` INTEGER NOT NULL,
  `redeemedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `coupon_redemptions_schoolId_key`(`schoolId`),
  PRIMARY KEY (`id`),
  INDEX `coupon_redemptions_couponId_idx`(`couponId`)
) DEFAULT CHARACTER SET utf8mb4;
