// Normalize a Nigerian phone number to the international format BulkSMSNigeria expects (234XXXXXXXXXX)
const toInternationalFormat = (phone) => {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("234")) return digits;
  if (digits.startsWith("0")) return `234${digits.slice(1)}`;
  return digits;
};

module.exports = { toInternationalFormat };
