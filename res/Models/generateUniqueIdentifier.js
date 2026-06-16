const crypto = require('crypto');

// Generate a unique identifier
const generateUniqueIdentifier = (prefix, type) => {
  // Generate a random 4-digit number
  const randomNumber = crypto.randomInt(1000, 9999);
  // Ensure the type suffix is 4 digits, pad with zeros if necessary
  const typeSuffix = type.toUpperCase().slice(0, 4);
  const uniqueIdentifier = `${prefix}-${randomNumber}-${typeSuffix}`;
  return uniqueIdentifier;
};

exports.generateUniqueIdentifier = generateUniqueIdentifier;