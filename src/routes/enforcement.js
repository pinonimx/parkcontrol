const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { verifyPass, verifyByPlate } = require('../services/passService');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('SUPER_ADMIN', 'PROPERTY_MANAGER', 'ENFORCEMENT'));

// POST /api/enforcement/scan-qr
// Enforcement officer scans a QR code
router.post('/scan-qr', [
  body('qrToken').notEmpty(),
  body('propertyId').isUUID(),
  body('zoneId').optional().isUUID(),
  body('deviceInfo').optional().isString(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { qrToken, propertyId, zoneId, deviceInfo } = req.body;

  const result = await verifyPass({
    qrToken,
    scannedById: req.user.id,
    propertyId,
    zoneId,
    deviceInfo,
  });

  // Map result to HTTP status
  const statusMap = {
    VALID: 200,
    WITHIN_GRACE_PERIOD: 200,
    EXPIRED: 200,
    REVOKED: 200,
    NOT_FOUND: 200,
    BLACKLISTED: 200,
    WRONG_ZONE: 200,
  };

  // Always 200 — the result field tells the app what to display/alert
  res.status(200).json(result);
}));

// POST /api/enforcement/lookup-plate
// Officer manually enters a plate number
router.post('/lookup-plate', [
  body('plate').trim().notEmpty().toUpperCase(),
  body('propertyId').isUUID(),
  body('zoneId').optional().isUUID(),
  body('deviceInfo').optional().isString(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { plate, propertyId, zoneId, deviceInfo } = req.body;

  const result = await verifyByPlate({
    plate,
    propertyId,
    zoneId,
    scannedById: req.user.id,
    deviceInfo,
  });

  res.json(result);
}));

module.exports = router;