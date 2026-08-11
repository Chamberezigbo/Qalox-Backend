/**
 * Service-to-Service Authentication Middleware
 * Validates requests from Super Admin Portal & Marketer Portal
 */

const serviceAuth = (req, res, next) => {
  const serviceKey = req.headers['x-service-key'];
  const authHeader = req.headers['authorization'];

  // Check Bearer token first — it identifies the actual signed-in user
  // (req.user), which many controllers need (e.g. to scope data to the
  // calling marketer). x-service-key only proves "a known frontend app is
  // calling," not who's logged in, so it must never take priority over a
  // present Bearer token now that the frontend sends both together.
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const jwt = require('jsonwebtoken');

    // Try verifying with Qalox JWT_SECRET first
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      req.service = { authenticated: false }; // User, not service
      return next();
    } catch (error) {
      // If that fails, try Marketer Portal's JWT_SECRET (for frontend clients)
      try {
        const decoded = jwt.verify(token, process.env.MARKETER_PORTAL_JWT_SECRET || 'your-strong-random-secret-here');
        req.user = decoded;
        req.service = { authenticated: false, source: 'marketer-portal' }; // Frontend client
        return next();
      } catch (error2) {
        // Fall through to the x-service-key check below rather than failing
        // immediately — a request can carry a stale/invalid Bearer token
        // alongside a still-valid x-service-key.
      }
    }
  }

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

  // No valid auth provided
  return res.status(401).json({
    success: false,
    message: 'Unauthorized - missing x-service-key or Authorization header',
    code: 'UNAUTHORIZED'
  });
};

module.exports = { serviceAuth };
