// PassService — the heart of ParkControl
// Handles pass creation, QR signing, verification, and rule enforcement

const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../utils/prisma');
const { logger } = require('../utils/logger');
const { writeAuditLog } = require('./auditService');

// ─────────────────────────────────────────────────────────────────────────────
// CREATE A PASS (resident issuing for visitor)
// ─────────────────────────────────────────────────────────────────────────────

const createPass = async ({
  propertyId,
  zoneId,
  plate,
  state = 'TX',
  issuedById,
  visitorLinkId = null,
  visitorName = null,
  vehicleMake = null,
  vehicleColor = null,
  durationHours,
  type = 'VISITOR',
}) => {
  // 1. Load property rules
  const rules = await prisma.propertyRules.findUnique({ where: { propertyId } });
  if (!rules) throw Object.assign(new Error('Property rules not configured'), { status: 400 });

  const normalizedPlate = plate.toUpperCase().replace(/\s/g, '');

  // 2. Check blacklist
  const blacklisted = await prisma.vehicle.findFirst({
    where: { plate: normalizedPlate, isBlacklisted: true },
  });
  if (blacklisted) {
    throw Object.assign(
      new Error(`Vehicle ${normalizedPlate} is blacklisted`),
      { status: 403, code: 'BLACKLISTED' }
    );
  }

  // 3. Enforce max concurrent visitor passes per unit (if resident-issued)
  if (issuedById && type === 'VISITOR') {
    const residentAccess = await prisma.userProperty.findFirst({
      where: { userId: issuedById, propertyId },
    });
    if (residentAccess?.unitId) {
      const activeCount = await prisma.pass.count({
        where: {
          propertyId,
          status: 'ACTIVE',
          expiresAt: { gt: new Date() },
          issuedById,
        },
      });
      if (activeCount >= rules.maxVisitorPassesPerUnit) {
        throw Object.assign(
          new Error(`Maximum of ${rules.maxVisitorPassesPerUnit} active visitor passes reached for your unit`),
          { status: 429, code: 'MAX_PASSES_REACHED' }
        );
      }
    }
  }

  // 4. Resolve (or create) vehicle record
  let vehicle = await prisma.vehicle.findFirst({
    where: { plate: normalizedPlate },
  });
  if (!vehicle) {
    vehicle = await prisma.vehicle.create({
      data: {
        plate: normalizedPlate,
        state,
        make: vehicleMake,
        color: vehicleColor,
        permitType: type === 'VISITOR' ? 'VISITOR' : 'RESIDENT',
        status: 'ACTIVE',
      },
    });
  }

  // 5. Calculate expiry
  const hours = durationHours ?? rules.visitorPassDurationHrs;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  // 6. Create pass record first (to get the ID)
  const passId = uuidv4();

  // 7. Sign QR payload
  const qrPayload = {
    passId,
    plate: normalizedPlate,
    propertyId,
    zoneId: zoneId || null,
    expiresAt: expiresAt.toISOString(),
    type,
  };
  const qrToken = jwt.sign(qrPayload, process.env.PASS_SIGNING_SECRET, {
    expiresIn: `${hours}h`,
    issuer: 'parkcontrol',
  });

  // 8. Write pass to DB
  const pass = await prisma.pass.create({
    data: {
      id: passId,
      propertyId,
      zoneId,
      vehicleId: vehicle.id,
      plate: normalizedPlate,
      issuedById,
      visitorLinkId,
      type,
      status: 'ACTIVE',
      expiresAt,
      qrToken,
      qrPayload: JSON.stringify(qrPayload),
      visitorName,
      vehicleMake,
      vehicleColor,
    },
  });

  // 9. Generate QR image (base64 PNG)
  const qrImageBase64 = await QRCode.toDataURL(qrToken, {
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 400,
  });

  // 10. Audit log
  await writeAuditLog({
    propertyId,
    userId: issuedById,
    vehicleId: vehicle.id,
    plate: normalizedPlate,
    event: 'PASS_CREATED',
    outcome: 'created',
    metadata: { passId, type, expiresAt, durationHours: hours, visitorLinkId },
  });

  return { pass, qrImageBase64, qrToken };
};

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY A PASS (enforcement scan)
// ─────────────────────────────────────────────────────────────────────────────

const verifyPass = async ({ qrToken, scannedById = null, deviceInfo = null, propertyId, zoneId }) => {
  let decoded;

  // 1. Verify JWT signature
  try {
    decoded = jwt.verify(qrToken, process.env.PASS_SIGNING_SECRET, { issuer: 'parkcontrol' });
  } catch (err) {
    // Still look up pass to log the attempt
    return _buildScanResult({
      result: 'NOT_FOUND',
      reason: err.name === 'TokenExpiredError' ? 'QR token expired' : 'Invalid QR signature',
      scannedById, deviceInfo, propertyId,
    });
  }

  // 2. Load pass from DB
  const pass = await prisma.pass.findUnique({
    where: { id: decoded.passId },
    include: { property: { include: { rules: true } }, zone: true, vehicle: true },
  });

  if (!pass) {
    return _buildScanResult({ result: 'NOT_FOUND', reason: 'Pass not in system', scannedById, deviceInfo, propertyId });
  }

  // 3. Check blacklist
  if (pass.vehicle?.isBlacklisted) {
    await _recordScan(pass.id, scannedById, 'BLACKLISTED', deviceInfo);
    await _maybeFlagVehicle(pass.vehicle, pass.property.rules);
    return _buildScanResult({ result: 'BLACKLISTED', pass, reason: 'Vehicle is blacklisted', scannedById, deviceInfo, propertyId });
  }

  // 4. Check revoked
  if (pass.status === 'REVOKED') {
    await _recordScan(pass.id, scannedById, 'REVOKED', deviceInfo);
    return _buildScanResult({ result: 'REVOKED', pass, reason: `Revoked: ${pass.revokedReason}`, scannedById, deviceInfo, propertyId });
  }

  // 5. Check expiry (with grace period)
  const now = new Date();
  const rules = pass.property.rules;
  const gracePeriodMs = (rules?.gracePeriodMinutes ?? 30) * 60 * 1000;
  const isExpired = pass.expiresAt < now;
  const isInGrace = isExpired && (pass.expiresAt.getTime() + gracePeriodMs) > now.getTime();

  if (isExpired && !isInGrace) {
    await _recordScan(pass.id, scannedById, 'EXPIRED', deviceInfo);
    await prisma.pass.update({ where: { id: pass.id }, data: { status: 'EXPIRED' } });
    return _buildScanResult({ result: 'EXPIRED', pass, reason: 'Pass has expired', scannedById, deviceInfo, propertyId });
  }

  // 6. Check zone
  if (zoneId && pass.zoneId && pass.zoneId !== zoneId) {
    await _recordScan(pass.id, scannedById, 'WRONG_ZONE', deviceInfo);
    return _buildScanResult({ result: 'WRONG_ZONE', pass, reason: `Pass is valid for zone ${pass.zone?.name} only`, scannedById, deviceInfo, propertyId });
  }

  // 7. Valid (possibly in grace period)
  const scanResult = isInGrace ? 'WITHIN_GRACE_PERIOD' : 'VALID';
  await _recordScan(pass.id, scannedById, scanResult, deviceInfo);

  await writeAuditLog({
    propertyId: pass.propertyId,
    userId: scannedById,
    vehicleId: pass.vehicleId,
    plate: pass.plate,
    event: 'PASS_SCANNED',
    outcome: scanResult.toLowerCase(),
    metadata: { passId: pass.id, zoneId, inGracePeriod: isInGrace },
  });

  return _buildScanResult({ result: scanResult, pass, scannedById, deviceInfo, propertyId });
};

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY BY PLATE (enforcement — manual plate lookup)
// ─────────────────────────────────────────────────────────────────────────────

const verifyByPlate = async ({ plate, propertyId, zoneId, scannedById, deviceInfo }) => {
  const normalizedPlate = plate.toUpperCase().replace(/\s/g, '');
  const now = new Date();

  // Check blacklist first
  const blacklisted = await prisma.vehicle.findFirst({
    where: { plate: normalizedPlate, isBlacklisted: true },
  });
  if (blacklisted) {
    await _logUnauthorizedScan({ plate: normalizedPlate, propertyId, scannedById, deviceInfo, outcome: 'BLACKLISTED' });
    return { result: 'BLACKLISTED', plate: normalizedPlate, reason: blacklisted.blacklistNote || 'Vehicle blacklisted' };
  }

  // Find active pass for this plate at this property
  const activePass = await prisma.pass.findFirst({
    where: {
      plate: normalizedPlate,
      propertyId,
      status: 'ACTIVE',
      expiresAt: { gt: now },
    },
    include: { zone: true, property: { include: { rules: true } } },
    orderBy: { expiresAt: 'desc' },
  });

  if (!activePass) {
    // Check if it's a registered resident vehicle
    const residentVehicle = await prisma.vehicle.findFirst({
      where: { plate: normalizedPlate, status: 'ACTIVE', permitType: 'RESIDENT' },
    });
    if (residentVehicle) {
      return { result: 'VALID', plate: normalizedPlate, reason: 'Registered resident vehicle', permitType: 'RESIDENT' };
    }

    await _logUnauthorizedScan({ plate: normalizedPlate, propertyId, scannedById, deviceInfo, outcome: 'NO_PASS' });
    return { result: 'NOT_FOUND', plate: normalizedPlate, reason: 'No active pass or registration found' };
  }

  await writeAuditLog({
    propertyId,
    userId: scannedById,
    plate: normalizedPlate,
    event: 'PASS_SCANNED',
    outcome: 'valid_plate_lookup',
    metadata: { passId: activePass.id, zoneId },
  });

  return {
    result: 'VALID',
    plate: normalizedPlate,
    pass: activePass,
    expiresAt: activePass.expiresAt,
    zone: activePass.zone?.name,
  };
};

// ─── Internal Helpers ─────────────────────────────────────────────────────────

const _recordScan = async (passId, scannedById, result, deviceInfo) => {
  await prisma.passScan.create({
    data: { passId, scannedById, result, deviceInfo },
  });
};

const _maybeFlagVehicle = async (vehicle, rules) => {
  if (!rules) return;
  const scanCount = await prisma.passScan.count({
    where: { pass: { vehicleId: vehicle.id }, result: { in: ['NOT_FOUND', 'BLACKLISTED', 'REVOKED'] } },
  });
  if (scanCount >= (rules.towEligibleAfterScans ?? 3)) {
    await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { status: 'TOW_ELIGIBLE' },
    });
  }
};

const _logUnauthorizedScan = async ({ plate, propertyId, scannedById, deviceInfo, outcome }) => {
  // Find or create a ghost vehicle record for tracking
  let vehicle = await prisma.vehicle.findFirst({ where: { plate } });
  if (!vehicle) {
    vehicle = await prisma.vehicle.create({
      data: { plate, status: 'MONITORING' },
    });
  }

  // Check if we need to escalate to TOW_ELIGIBLE
  const rules = await prisma.propertyRules.findUnique({ where: { propertyId } });
  await _maybeFlagVehicle(vehicle, rules);

  await writeAuditLog({
    propertyId,
    userId: scannedById,
    vehicleId: vehicle.id,
    plate,
    event: 'VEHICLE_FLAGGED',
    outcome,
    metadata: { deviceInfo },
  });
};

const _buildScanResult = ({ result, pass, reason, scannedById, deviceInfo, propertyId }) => ({
  result,
  reason,
  plate: pass?.plate,
  passId: pass?.id,
  expiresAt: pass?.expiresAt,
  visitorName: pass?.visitorName,
  zone: pass?.zone?.name,
  scannedAt: new Date().toISOString(),
});

module.exports = { createPass, verifyPass, verifyByPlate };
