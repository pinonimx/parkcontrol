const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');

// Verify access token and attach user to req
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        properties: {
          include: { property: true, unit: true },
        },
      },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Role guard factory — pass one or more allowed roles
// Usage: requireRole('SUPER_ADMIN', 'PROPERTY_MANAGER')
const requireRole = (...roles) => (req, res, next) => {
  const userRoles = req.user.properties.map(up => up.role);
  const isSuperAdmin = userRoles.includes('SUPER_ADMIN');
  const hasRole = roles.some(r => userRoles.includes(r));

  if (!isSuperAdmin && !hasRole) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

// Property-scoped access guard
// Ensures the user has access to req.params.propertyId (or body.propertyId)
const requirePropertyAccess = (...roles) => async (req, res, next) => {
  const propertyId = req.params.propertyId || req.body.propertyId || req.query.propertyId;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const userRoles = req.user.properties.map(up => up.role);
  if (userRoles.includes('SUPER_ADMIN')) return next();

  const access = req.user.properties.find(up => up.propertyId === propertyId);
  if (!access) {
    return res.status(403).json({ error: 'No access to this property' });
  }

  if (roles.length && !roles.includes(access.role)) {
    return res.status(403).json({ error: 'Insufficient role for this property' });
  }

  req.propertyAccess = access; // { role, unitId, propertyId }
  next();
};

module.exports = { authenticate, requireRole, requirePropertyAccess };
