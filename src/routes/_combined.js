const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate, requireRole, requirePropertyAccess } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const prisma = require('../utils/prisma');

// ─── Audit Router ─────────────────────────────────────────────────────────────
const auditRouter = express.Router();
auditRouter.use(authenticate);
auditRouter.use(requireRole('SUPER_ADMIN', 'PROPERTY_MANAGER', 'ENFORCEMENT'));

// GET /api/audit?propertyId=&event=&plate=&from=&to=&limit=
auditRouter.get('/', asyncHandler(async (req, res) => {
  const { propertyId, event, plate, from, to, limit = 100 } = req.query;
  const userRoles = req.user.properties.map(up => up.role);
  const isSuperAdmin = userRoles.includes('SUPER_ADMIN');

  const where = {};
  if (event) where.event = event;
  if (plate) where.plate = plate.toUpperCase().replace(/\s/g, '');
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  if (isSuperAdmin) {
    if (propertyId) where.propertyId = propertyId;
  } else {
    const allowedIds = req.user.properties.map(up => up.propertyId);
    where.propertyId = propertyId && allowedIds.includes(propertyId)
      ? propertyId
      : { in: allowedIds };
  }

  const logs = await prisma.auditLog.findMany({
    where,
    include: {
      user: { select: { firstName: true, lastName: true } },
      property: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(parseInt(limit), 500),
  });

  res.json({ logs, count: logs.length });
}));

// ─── Rules Router ─────────────────────────────────────────────────────────────
const rulesRouter = express.Router();
rulesRouter.use(authenticate);

// GET /api/rules/:propertyId
rulesRouter.get('/:propertyId', requirePropertyAccess(), asyncHandler(async (req, res) => {
  const rules = await prisma.propertyRules.findUnique({
    where: { propertyId: req.params.propertyId },
  });
  if (!rules) return res.status(404).json({ error: 'Rules not found for this property' });
  res.json({ rules });
}));

// PATCH /api/rules/:propertyId — managers only
rulesRouter.patch('/:propertyId',
  requirePropertyAccess('SUPER_ADMIN', 'PROPERTY_MANAGER'),
  asyncHandler(async (req, res) => {
    const allowed = [
      'visitorPassDurationHrs', 'allowOvernightPasses', 'maxVisitorPassesPerUnit',
      'gracePeriodMinutes', 'towEligibleAfterScans', 'permitRenewalDays',
      'renewalReminderDays', 'blacklistAutoFlag',
    ];
    const data = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }

    const rules = await prisma.propertyRules.update({
      where: { propertyId: req.params.propertyId },
      data,
    });

    res.json({ rules });
  })
);

// ─── Units Router ─────────────────────────────────────────────────────────────
const unitsRouter = express.Router();
unitsRouter.use(authenticate);

// GET /api/units?propertyId=
unitsRouter.get('/', asyncHandler(async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const access = req.user.properties.find(up => up.propertyId === propertyId);
  if (!access) return res.status(403).json({ error: 'No access to this property' });

  const units = await prisma.unit.findMany({
    where: { propertyId },
    include: {
      residents: { include: { user: { select: { firstName: true, lastName: true, email: true } } } },
      vehicles: true,
      _count: { select: { vehicles: true } },
    },
    orderBy: { number: 'asc' },
  });

  res.json({ units });
}));

// POST /api/units — manager creates a unit
unitsRouter.post('/', requireRole('SUPER_ADMIN', 'PROPERTY_MANAGER'), [
  body('propertyId').isUUID(),
  body('number').trim().notEmpty(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const unit = await prisma.unit.create({
    data: { propertyId: req.body.propertyId, number: req.body.number, floor: req.body.floor },
  });
  res.status(201).json({ unit });
}));

// ─── Users Router ─────────────────────────────────────────────────────────────
const usersRouter = express.Router();
usersRouter.use(authenticate);

// PATCH /api/users/me — update own profile + notification prefs
usersRouter.patch('/me', asyncHandler(async (req, res) => {
  const allowed = ['firstName', 'lastName', 'phone',
    'notifyPassExpiry', 'notifyVisitorRegistered', 'notifySmsExpiry', 'notifyPermitRenewal'];
  const data = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) data[key] = req.body[key];
  }
  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  res.json({ user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, phone: user.phone } });
}));

// POST /api/users/assign — manager assigns user to property/unit
usersRouter.post('/assign', requireRole('SUPER_ADMIN', 'PROPERTY_MANAGER'), [
  body('userId').isUUID(),
  body('propertyId').isUUID(),
  body('role').isIn(['RESIDENT', 'PROPERTY_MANAGER', 'ENFORCEMENT']),
  body('unitId').optional().isUUID(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { userId, propertyId, role, unitId } = req.body;

  const assignment = await prisma.userProperty.upsert({
    where: { userId_propertyId: { userId, propertyId } },
    update: { role, unitId },
    create: { userId, propertyId, role, unitId },
  });

  res.json({ assignment });
}));

module.exports = { auditRouter, rulesRouter, unitsRouter, usersRouter };