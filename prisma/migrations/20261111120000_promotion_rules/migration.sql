-- AlterTable
ALTER TABLE `promotion_policies` ADD COLUMN `rules` JSON NULL;

-- AlterTable
ALTER TABLE `classes` ADD COLUMN `promotionRules` JSON NULL;
