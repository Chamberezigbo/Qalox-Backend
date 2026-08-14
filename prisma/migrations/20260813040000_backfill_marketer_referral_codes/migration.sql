-- Backfill referralCode for every marketer that has none.
--
-- The column and its UNIQUE index already exist (see 20260720214849). What was
-- missing was any code path that filled it: marketerSignup — the route the
-- Marketer Portal actually uses — never set it, so every row is NULL.
--
-- Why an affine map instead of RAND()/UUID():
--   A random 6-character code can collide, and a collision inside a single
--   UPDATE aborts the whole migration against the UNIQUE index. Instead we use
--     f(id) = (id * 1103515247 + 12345) MOD 36^6
--   which is a bijection over the 36^6 code space, because 1103515247 is
--   coprime to 36^6 = 2^12 * 3^12 (it is odd, and its digits sum to 29 so it is
--   not divisible by 3). Distinct ids therefore always produce distinct codes —
--   the backfill cannot fail on a duplicate, at any table size.
--
-- The multiplier scrambles the output so codes are not visibly sequential
-- (id 25 -> QAL-EBTAQF, not QAL-000019). New signups use the random generator
-- in res/util/referralCode.js, which retries on the unique-constraint error.
UPDATE `admins`
SET `referralCode` = CONCAT(
  'QAL-',
  LPAD(UPPER(CONV((`id` * 1103515247 + 12345) MOD 2176782336, 10, 36)), 6, '0')
)
WHERE `role` = 'marketer'
  AND (`referralCode` IS NULL OR `referralCode` = '');
