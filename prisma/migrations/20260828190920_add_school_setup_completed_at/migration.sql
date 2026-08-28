-- setupCompletedAt is a precise, untouched setup timestamp for the 48h
-- payment-lock grace period. createdAt can't be used for this: the app's
-- global Prisma middleware (res/util/prisma.js) truncates every model's
-- createdAt to a date-only value when read back into JS, which would let the
-- grace period run as short as ~24h depending on time of day. The column
-- itself still holds full DATETIME(3) precision, so backfilling existing
-- schools from it here is accurate.
ALTER TABLE `schools` ADD COLUMN `setupCompletedAt` DATETIME(3) NULL;
UPDATE `schools` SET `setupCompletedAt` = `createdAt` WHERE `setupCompletedAt` IS NULL;
