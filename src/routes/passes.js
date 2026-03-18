const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticate, requirePropertyAccess } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { createPass } = require('../services/passService');
const notifications = require('../services/notificationService');
const prisma = require('../utils/prisma');

const router = express.Router();
router.use(authenticate);

// POST /api/passes — issue a new pass (resident or manager)
router.post('/', [
  body('propertyId').isUUID(),
  body('plate').trim().notEmpty().toUpperCase(),
  body('durationHours').optional().isInt({ min: 1, max: 720 }),
  body('zoneId').optional().isUUID(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const {
    propertyId, plate, state, durationHours, zoneId,
    visitorName, vehicleMake, vehicleColor, type,
  } = req.body;

  // Residents can only issue for their property
  const access = req.user.properties.find(up => up.propertyId === propertyId);
  if (!access) return res.status(403).json({ error: 'No access to this property' });

  const { pass, qrImageBase64 } = await createPass({
    propertyId,
    zoneId,
    plate,
    state,
    issuedById: req.user.id,
    durationHours,
    visitorName,
    vehicleMake,
    vehicleColor,
    type: type || 'VISITOR',
  });

  res.status(201).json({ pass, qrImageBase64 });
}));

// GET /api/passes — list passes (scoped to user's properties / unit)
router.get('/', asyncHandler(async (req, res) => {
  const { propertyId, status, plate } = req.query;
  const userRoles = req.user.properties.map(up => up.role);
  const isSuperAdmin = userRoles.includes('SUPER_ADMIN');

  let where = {};

  if (plate) where.plate = plate.toUpperCase().replace(/\s/g, '');
  if (status) where.status = status;

  if (isSuperAdmin) {
    if (propertyId) where.propertyId = propertyId;
  } else {
    const allowedPropertyIds = req.user.properties.map(up => up.propertyId);
    where.propertyId = propertyId && allowedPropertyIds.includes(propertyId)
      ? propertyId
      : { in: allowedPropertyIds };

    // Residents only see passes they issued
    const isResidentOnly = !userRoles.some(r => ['PROPERTY_MANAGER', 'ENFORCEMENT'].includes(r));
    if (isResidentOnly) where.issuedById = req.user.id;
  }

  const passes = await prisma.pass.findMany({
    where,
    include: { zone: true, issuedBy: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json({ passes });
}));

// GET /api/passes/:id — get single pass + QR token
router.get('/:id', asyncHandler(async (req, res) => {
  const pass = await prisma.pass.findUnique({
    where: { id: req.params.id },
    include: { zone: true, vehicle: true, scans: { orderBy: { scannedAt: 'desc' }, take: 10 } },
  });
  if (!pass) return res.status(404).json({ error: 'Pass not found' });

  // Residents can only see their own passes
  const userRoles = req.user.properties.map(up => up.role);
  const isSuperAdmin = userRoles.includes('SUPER_ADMIN');
  const isManager = userRoles.includes('PROPERTY_MANAGER');
  if (!isSuperAdmin && !isManager && pass.issuedById !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized to view this pass' });
  }

  const QRCode = require('qrcode');
  const qrImageBase64 = await QRCode.toDataURL(pass.qrToken, {
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 400,
  });

  res.json({ pass, qrImageBase64 });
}));

// PATCH /api/passes/:id/revoke — revoke a pass
router.patch('/:id/revoke', [
  body('reason').optional().trim(),
], asyncHandler(async (req, res) => {
  const pass = await prisma.pass.findUnique({ where: { id: req.params.id } });
  if (!pass) return res.status(404).json({ error: 'Pass not found' });

  const userRoles = req.user.properties.map(up => up.role);
  const isSuperAdmin = userRoles.includes('SUPER_ADMIN');
  const isManager = userRoles.includes('PROPERTY_MANAGER');
  const isOwner = pass.issuedById === req.user.id;

  if (!isSuperAdmin && !isManager && !isOwner) {
    return res.status(403).json({ error: 'Not authorized to revoke this pass' });
  }

  const updated = await prisma.pass.update({
    where: { id: pass.id },
    data: {
      status: 'REVOKED',
      revokedAt: new Date(),
      revokedReason: req.body.reason || 'Revoked by user',
    },
  });

  // Notify resident if revoked by someone else (manager)
  if (pass.issuedById && pass.issuedById !== req.user.id) {
    notifications.onPassRevoked({ pass: updated, revokedByManagerId: req.user.id });
  }

  res.json({ pass: updated });
}));

module.exports = router;