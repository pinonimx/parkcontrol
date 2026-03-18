const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { writeAuditLog } = require('../services/auditService');
const prisma = require('../utils/prisma');

const router = express.Router();
router.use(authenticate);

// GET /api/vehicles — list vehicles (scoped to user)
router.get('/', asyncHandler(async (req, res) => {
  const { plate, propertyId, status } = req.query;
  const userRoles = req.user.properties.map(up => up.role);
  const isSuperAdmin = userRoles.includes('SUPER_ADMIN');
  const isManager = userRoles.includes('PROPERTY_MANAGER');

  let where = {};
  if (plate) where.plate = { contains: plate.toUpperCase() };
  if (status) where.status = status;

  if (!isSuperAdmin && !isManager) {
    // Residents see only their own vehicles
    where.ownerId = req.user.id;
  }

  const vehicles = await prisma.vehicle.findMany({
    where,
    include: { owner: { select: { firstName: true, lastName: true } }, unit: true, zone: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ vehicles });
}));

// POST /api/vehicles — register a vehicle
router.post('/', [
  body('plate').trim().notEmpty().toUpperCase(),
  body('propertyId').isUUID(),
  body('unitId').optional().isUUID(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { plate, state, make, model, year, color, propertyId, unitId, zoneId } = req.body;
  const normalizedPlate = plate.toUpperCase().replace(/\s/g, '');

  const access = req.user.properties.find(up => up.propertyId === propertyId);
  if (!access) return res.status(403).json({ error: 'No access to this property' });

  // Check blacklist
  const blacklisted = await prisma.vehicle.findFirst({ where: { plate: normalizedPlate, isBlacklisted: true } });
  if (blacklisted) return res.status(403).json({ error: 'This vehicle is blacklisted', code: 'BLACKLISTED' });

  const vehicle = await prisma.vehicle.upsert({
    where: { id: (await prisma.vehicle.findFirst({ where: { plate: normalizedPlate } }))?.id || 'nonexistent' },
    update: { make, model, year: year ? parseInt(year) : undefined, color, ownerId: req.user.id, unitId: unitId || access.unitId, zoneId, status: 'ACTIVE' },
    create: {
      plate: normalizedPlate, state: state || 'TX', make, model,
      year: year ? parseInt(year) : null, color,
      ownerId: req.user.id,
      unitId: unitId || access.unitId,
      zoneId,
      permitType: 'RESIDENT',
      status: 'ACTIVE',
    },
  });

  await writeAuditLog({
    propertyId,
    userId: req.user.id,
    vehicleId: vehicle.id,
    plate: normalizedPlate,
    event: 'VEHICLE_REGISTERED',
    outcome: 'registered',
    metadata: { make, model, year, color },
  });

  res.status(201).json({ vehicle });
}));

// PATCH /api/vehicles/:id/blacklist — managers only
router.patch('/:id/blacklist', requireRole('SUPER_ADMIN', 'PROPERTY_MANAGER'), [
  body('note').optional().trim(),
], asyncHandler(async (req, res) => {
  const vehicle = await prisma.vehicle.update({
    where: { id: req.params.id },
    data: { isBlacklisted: true, status: 'FLAGGED', blacklistNote: req.body.note },
  });

  await writeAuditLog({
    vehicleId: vehicle.id,
    plate: vehicle.plate,
    userId: req.user.id,
    event: 'VEHICLE_BLACKLISTED',
    outcome: 'blacklisted',
    metadata: { note: req.body.note },
  });

  res.json({ vehicle });
}));

// DELETE /api/vehicles/:id — resident removes their own vehicle
router.delete('/:id', asyncHandler(async (req, res) => {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id } });
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

  const userRoles = req.user.properties.map(up => up.role);
  const isSuperAdmin = userRoles.includes('SUPER_ADMIN');
  if (!isSuperAdmin && vehicle.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await prisma.vehicle.update({ where: { id: req.params.id }, data: { status: 'REMOVED', ownerId: null } });
  res.json({ message: 'Vehicle removed' });
}));

module.exports = router;