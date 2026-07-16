/**
 * Service-to-Service Authentication Middleware
 * Validates requests from Super Admin Portal & Marketer Portal
 */

const serviceAuth = (req, res, next) => {
  const serviceKey = req.headers['x-service-key'];
  const authHeader = req.headers['authorization'];

  // Check for x-service-key header
  if (serviceKey) {
    const validKeys = [
      process.env.SUPER_ADMIN_SERVICE_KEY,
      process.env.MARKETER_SERVICE_KEY
    ];

    if (!validKeys.includes(serviceKey)) {
      return res.status(401).json({
        success: false,
        message: 'Invalid service key',
        code: 'INVALID_SERVICE_KEY'
      });
    }

    // Attach service info to request
    req.service = {
      authenticated: true,
      type: serviceKey === process.env.SUPER_ADMIN_SERVICE_KEY ? 'super-admin' : 'marketer'
    };

    return next();
  }

  // Check for Bearer token (for admin users)
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const jwt = require('jsonwebtoken');

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      req.service = { authenticated: false }; // User, not service
      return next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    }
  }

  // No valid auth provided
  return res.status(401).json({
    success: false,
    message: 'Unauthorized - missing x-service-key or Authorization header',
    code: 'UNAUTHORIZED'
  });
};

module.exports = { serviceAuth };
