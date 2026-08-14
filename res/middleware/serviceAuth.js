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
      // If that fails, try Marketer Portal's JWT_SECRET (for frontend clients).
      //
      // NO literal fallback here. This previously read
      //   process.env.MARKETER_PORTAL_JWT_SECRET || 'your-strong-random-secret-here'
      // which publishes a signing key in the source tree: anyone who can read
      // the repo could mint a token with any payload — including
      // role: 'platform_super_admin' — and pass requirePlatformSuperAdmin.
      // When the var is missing we now skip this branch and fall through to
      // the service-key check, i.e. fail closed instead of trusting a
      // well-known string.
      const marketerPortalSecret = process.env.MARKETER_PORTAL_JWT_SECRET;

      try {
        if (!marketerPortalSecret) {
          throw new Error('MARKETER_PORTAL_JWT_SECRET is not configured');
        }

        const decoded = jwt.verify(token, marketerPortalSecret);
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

/**
 * Authorization layer for Super Admin-only routes under /api/public.
 *
 * serviceAuth only proves *identity* — that a valid token or a known service
 * key was presented. It does not check *authority*, so on its own it lets any
 * signed-in marketer reach Super Admin endpoints (marketer bank details,
 * wallet mutation, school suspend/delete). Chain this after it on every route
 * that only the platform super admin may call.
 *
 * Accepts:
 *   - a Bearer token whose role is platform_super_admin, or
 *   - a request carrying the SUPER_ADMIN_SERVICE_KEY and no user token
 *     (back-compat for service-to-service calls that send no Bearer).
 */
const requirePlatformSuperAdmin = (req, res, next) => {
  if (req.user?.role === 'platform_super_admin') return next();

  // No user identity, but authenticated as the Super Admin service itself.
  if (!req.user && req.service?.authenticated && req.service.type === 'super-admin') {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'Only super admins can access this resource',
    code: 'FORBIDDEN'
  });
};

module.exports = { serviceAuth, requirePlatformSuperAdmin };
