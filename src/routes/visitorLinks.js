const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { createPass } = require('../services/passService');
const notifications = require('../services/notificationService');
const prisma = require('../utils/prisma');

const router = express.Router();

// POST /api/visitor-links — resident generates a self-registration link
router.post('/', authenticate, [
  body('propertyId').isUUID(),
  body('durationHours').optional().isInt({ min: 1, max: 720 }),
  body('zoneId').optional().isUUID(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { propertyId, durationHours, zoneId } = req.body;

  const access = req.user.properties.find(up => up.propertyId === propertyId);
  if (!access) return res.status(403).json({ error: 'No access to this property' });

  // Check active pass count before issuing a link
  const rules = await prisma.propertyRules.findUnique({ where: { propertyId } });
  if (rules) {
    const activeCount = await prisma.pass.count({
      where: { issuedById: req.user.id, propertyId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    });
    if (activeCount >= rules.maxVisitorPassesPerUnit) {
      return res.status(429).json({
        error: `Maximum of ${rules.maxVisitorPassesPerUnit} active visitor passes reached for your unit`,
        code: 'MAX_PASSES_REACHED',
      });
    }
  }

  const token = uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // link valid for 48 hrs

  const link = await prisma.visitorLink.create({
    data: {
      token,
      propertyId,
      issuedById: req.user.id,
      unitId: access.unitId,
      durationHours: durationHours ?? rules?.visitorPassDurationHrs ?? 24,
      zoneId,
      expiresAt,
    },
  });

  const url = `${process.env.VISITOR_LINK_BASE_URL}/${token}`;

  // If resident provided a contact email, send the link to the visitor directly
  const visitorContact = req.body.visitorContact;
  if (visitorContact && visitorContact.includes('@')) {
    const propertyName = await prisma.property
      .findUnique({ where: { id: propertyId }, select: { name: true } })
      .then(p => p?.name || 'your property');
    const residentName = req.user.firstName;

    notifications.onVisitorLinkShared({
      toEmail: visitorContact,
      residentName,
      propertyName,
      zoneName: null,
      durationHours: link.durationHours,
      linkUrl: url,
      expiresAt: link.expiresAt,
    });
  }

  res.status(201).json({ link, url, token });
}));

// GET /api/visitor-links — list links issued by the current user
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const links = await prisma.visitorLink.findMany({
    where: { issuedById: req.user.id },
    include: { passes: { select: { id: true, plate: true, status: true } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  res.json({ links });
}));

// GET /api/visitor-links/:token — public endpoint: visitor fetches link details before submitting
// No auth required — the token IS the auth
router.get('/:token', asyncHandler(async (req, res) => {
  const link = await prisma.visitorLink.findUnique({
    where: { token: req.params.token },
    include: { property: { select: { name: true, address: true } }, issuedBy: { select: { firstName: true, unitId: true } } },
  });

  if (!link) return res.status(404).json({ error: 'Link not found or expired' });
  if (link.isUsed) return res.status(410).json({ error: 'This link has already been used' });
  if (link.expiresAt < new Date()) return res.status(410).json({ error: 'This link has expired' });

  res.json({
    valid: true,
    property: link.property,
    durationHours: link.durationHours,
    expiresAt: link.expiresAt,
    issuedBy: `${link.issuedBy.firstName} (Unit ${link.unitId})`,
  });
}));

// POST /api/visitor-links/:token/register — visitor submits their plate info
// No auth required
router.post('/:token/register', [
  body('plate').trim().notEmpty().toUpperCase(),
  body('state').optional().isLength({ min: 2, max: 3 }),
  body('make').optional().trim(),
  body('color').optional().trim(),
  body('visitorName').optional().trim(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const link = await prisma.visitorLink.findUnique({
    where: { token: req.params.token },
  });

  if (!link) return res.status(404).json({ error: 'Link not found' });
  if (link.isUsed) return res.status(410).json({ error: 'This link has already been used' });
  if (link.expiresAt < new Date()) return res.status(410).json({ error: 'This link has expired' });

  const { plate, state, make, color, visitorName } = req.body;

  const { pass, qrImageBase64 } = await createPass({
    propertyId: link.propertyId,
    zoneId: link.zoneId,
    plate,
    state,
    issuedById: link.issuedById,
    visitorLinkId: link.id,
    durationHours: link.durationHours,
    visitorName,
    vehicleMake: make,
    vehicleColor: color,
    type: 'VISITOR',
  });

  // Mark link as used
  await prisma.visitorLink.update({
    where: { id: link.id },
    data: { isUsed: true, usedAt: new Date() },
  });

  // Notify the resident that their visitor registered
  notifications.onVisitorSelfRegistered({ pass, link });

  res.status(201).json({
    pass: {
      id: pass.id,
      plate: pass.plate,
      expiresAt: pass.expiresAt,
      zone: link.zoneId,
    },
    qrImageBase64,
    message: 'Your visitor pass is active. Show the QR code to enforcement if asked.',
  });
}));

module.exports = router;