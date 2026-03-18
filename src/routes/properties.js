// ─── properties.js ────────────────────────────────────────────────────────────
const express = require('express');
const { authenticate, requireRole, requirePropertyAccess } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const prisma = require('../utils/prisma');

const router = express.Router();
router.use(authenticate);

// GET /api/properties
router.get('/', asyncHandler(async (req, res) => {
  const userRoles = req.user.properties.map(up => up.role);
  const isSuperAdmin = userRoles.includes('SUPER_ADMIN');

  const properties = isSuperAdmin
    ? await prisma.property.findMany({ include: { zones: true, rules: true, _count: { select: { units: true, passes: true } } } })
    : await prisma.property.findMany({
        where: { id: { in: req.user.properties.map(up => up.propertyId) } },
        include: { zones: true, rules: true, _count: { select: { units: true } } },
      });

  res.json({ properties });
}));

// POST /api/properties — super admin only
router.post('/', requireRole('SUPER_ADMIN'), asyncHandler(async (req, res) => {
  const { name, address, city, state, zip, type } = req.body;
  const property = await prisma.property.create({
    data: { name, address, city, state, zip, type: type || 'RESIDENTIAL' },
  });
  // Create default rules
  await prisma.propertyRules.create({ data: { propertyId: property.id } });
  res.status(201).json({ property });
}));

// GET /api/properties/:propertyId
router.get('/:propertyId', requirePropertyAccess(), asyncHandler(async (req, res) => {
  const property = await prisma.property.findUnique({
    where: { id: req.params.propertyId },
    include: { zones: true, rules: true, units: { include: { _count: { select: { residents: true, vehicles: true } } } } },
  });
  if (!property) return res.status(404).json({ error: 'Property not found' });
  res.json({ property });
}));

module.exports = router;