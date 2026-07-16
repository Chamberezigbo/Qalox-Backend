/**
 * Response Formatter - Standardizes all API responses
 */

const formatSuccess = (data = null, message = 'Success', statusCode = 200) => {
  return {
    statusCode,
    body: {
      success: true,
      message,
      data
    }
  };
};

const formatError = (message = 'Error', code = 'UNKNOWN_ERROR', statusCode = 400, details = null) => {
  return {
    statusCode,
    body: {
      success: false,
      message,
      code,
      ...(details && { details })
    }
  };
};

const sendSuccess = (res, data = null, message = 'Success', statusCode = 200) => {
  const response = formatSuccess(data, message, statusCode);
  return res.status(response.statusCode).json(response.body);
};

const sendError = (res, message = 'Error', code = 'UNKNOWN_ERROR', statusCode = 400, details = null) => {
  const response = formatError(message, code, statusCode, details);
  return res.status(response.statusCode).json(response.body);
};

module.exports = {
  formatSuccess,
  formatError,
  sendSuccess,
  sendError
};
