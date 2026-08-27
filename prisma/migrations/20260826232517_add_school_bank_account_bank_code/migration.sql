-- Stores the NIP bank code alongside the display bank name on a school's
-- bank account, so the account name can be re-resolved against Flutterwave
-- (verify it hasn't changed, or re-check on edit) without asking the admin
-- to re-select the bank from scratch.
ALTER TABLE `school_bank_accounts`
  ADD COLUMN `bankCode` VARCHAR(10) NULL;
