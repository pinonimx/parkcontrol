// routes/reports.js
// All reporting endpoints. Every report:
//   - Requires authentication + manager/admin role
//   - Enforces property-scoped access (managers only see their properties)
//   - Accepts ?format=csv to return a downloadable CSV instead of JSON
//   - Accepts ?from= and ?to= (ISO date strings) for time-range filtering

const express = require('express');
const { authenticate, requireRole, requirePropertyAccess } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { sendCsv } = require('../utils/csvExport');
const reports = require('../services/reportingService');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('SUPER_ADMIN', 'PROPERTY_MANAGER', 'ENFORCEMENT'));

// ─── Shared helpers ───────────────────────────────────────────────────────────

const isSuperAdmin = (user) => user.properties.some(up => up.role === 'SUPER_ADMIN');

// Validate that the requesting user has access to the requested propertyId
const validatePropertyAccess = (user, propertyId) => {
  if (isSuperAdmin(user)) return true;
  return user.properties.some(up => up.propertyId === propertyId);
};

const fmt = (date) => date ? new Date(date).toISOString().slice(0, 10).replace(/-/g, '') : 'all';
const filename = (name, propertyId, from, to) =>
  `parkcontrol_${name}_${propertyId || 'all'}_${fmt(from)}_${fmt(to)}.csv`;

// ─── GET /api/reports/summary ─────────────────────────────────────────────────
// Super-admin dashboard: one row per property with KPIs.
// Super admin only — managers have access to only their properties.

router.get('/summary', requireRole('SUPER_ADMIN'), asyncHandler(async (req, res) => {
  const data = await reports.propertySummaryReport();

  if (req.query.format === 'csv') {
    return sendCsv(res, 'parkcontrol_property_summary.csv', data.rows, 'propertySummary');
  }
  res.json(data);
}));

// ─── GET /api/reports/occupancy ───────────────────────────────────────────────
// Current occupancy snapshot per zone.

router.get('/occupancy', asyncHandler(async (req, res) => {
  const { propertyId, format } = req.query;

  if (propertyId && !validatePropertyAccess(req.user, propertyId)) {
    return res.status(403).json({ error: 'No access to this property' });
  }

  const scopedPropertyId = isSuperAdmin(req.user)
    ? propertyId
    : req.user.properties[0]?.propertyId;

  const data = await reports.occupancyReport({ propertyId: scopedPropertyId });

  if (format === 'csv') {
    return sendCsv(res, filename('occupancy', scopedPropertyId, null, null), data.rows, 'occupancy');
  }
  res.json(data);
}));

// ─── GET /api/reports/passes ──────────────────────────────────────────────────
// Pass issuance activity over a date range.
// ?propertyId= &from= &to= &format=csv

router.get('/passes', asyncHandler(async (req, res) => {
  const { propertyId, from, to, format } = req.query;

  if (propertyId && !validatePropertyAccess(req.user, propertyId)) {
    return res.status(403).json({ error: 'No access to this property' });
  }

  const scopedPropertyId = isSuperAdmin(req.user)
    ? propertyId
    : req.user.properties[0]?.propertyId;

  const data = await reports.passActivityReport({ propertyId: scopedPropertyId, from, to });

  if (format === 'csv') {
    return sendCsv(res, filename('passes', scopedPropertyId, from, to), data.rows, 'passes');
  }
  res.json(data);
}));

// ─── GET /api/reports/violations ─────────────────────────────────────────────
// Unauthorized / blacklisted / tow-eligible vehicles.
// ?propertyId= &from= &to= &status=TOW_ELIGIBLE|FLAGGED|MONITORING &format=csv

router.get('/violations', asyncHandler(async (req, res) => {
  const { propertyId, from, to, status, format } = req.query;

  if (propertyId && !validatePropertyAccess(req.user, propertyId)) {
    return res.status(403).json({ error: 'No access to this property' });
  }

  const scopedPropertyId = isSuperAdmin(req.user)
    ? propertyId
    : req.user.properties[0]?.propertyId;

  const data = await reports.violationsReport({ propertyId: scopedPropertyId, from, to, status });

  if (format === 'csv') {
    return sendCsv(res, filename('violations', scopedPropertyId, from, to), data.rows, 'violations');
  }
  res.json(data);
}));

// ─── GET /api/reports/compliance ─────────────────────────────────────────────
// Per-unit resident compliance (vehicle counts, pass limits, violations).
// Requires ?propertyId= (always scoped to one property).

router.get('/compliance', asyncHandler(async (req, res) => {
  const { propertyId, format } = req.query;

  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });
  if (!validatePropertyAccess(req.user, propertyId)) {
    return res.status(403).json({ error: 'No access to this property' });
  }

  const data = await reports.residentComplianceReport({ propertyId });

  if (format === 'csv') {
    return sendCsv(res, filename('compliance', propertyId, null, null), data.rows, 'compliance');
  }
  res.json(data);
}));

// ─── GET /api/reports/enforcement ────────────────────────────────────────────
// Officer scan activity, result breakdown, hourly heatmap.
// ?propertyId= &from= &to= &format=csv

router.get('/enforcement', asyncHandler(async (req, res) => {
  const { propertyId, from, to, format } = req.query;

  if (propertyId && !validatePropertyAccess(req.user, propertyId)) {
    return res.status(403).json({ error: 'No access to this property' });
  }

  const scopedPropertyId = isSuperAdmin(req.user)
    ? propertyId
    : req.user.properties[0]?.propertyId;

  const data = await reports.enforcementActivityReport({ propertyId: scopedPropertyId, from, to });

  if (format === 'csv') {
    return sendCsv(res, filename('enforcement', scopedPropertyId, from, to), data.byOfficer, 'enforcement');
  }
  res.json(data);
}));

// ─── GET /api/reports/visitor-links ──────────────────────────────────────────
// Self-registration link usage rate and details.
// ?propertyId= &from= &to= &format=csv

router.get('/visitor-links', asyncHandler(async (req, res) => {
  const { propertyId, from, to, format } = req.query;

  if (propertyId && !validatePropertyAccess(req.user, propertyId)) {
    return res.status(403).json({ error: 'No access to this property' });
  }

  const scopedPropertyId = isSuperAdmin(req.user)
    ? propertyId
    : req.user.properties[0]?.propertyId;

  const data = await reports.visitorLinkReport({ propertyId: scopedPropertyId, from, to });

  if (format === 'csv') {
    return sendCsv(res, filename('visitor_links', scopedPropertyId, from, to), data.rows, 'visitorLinks');
  }
  res.json(data);
}));

// ─── GET /api/reports/audit-trail ────────────────────────────────────────────
// Full chronological event log for a specific plate or pass.
// Used for legal disputes, tow documentation, resident inquiries.
// ?plate=ABC1234 OR ?passId=uuid &propertyId= &format=csv

router.get('/audit-trail', asyncHandler(async (req, res) => {
  const { plate, passId, propertyId, format } = req.query;

  if (!plate && !passId) {
    return res.status(400).json({ error: 'plate or passId query parameter required' });
  }
  if (propertyId && !validatePropertyAccess(req.user, propertyId)) {
    return res.status(403).json({ error: 'No access to this property' });
  }

  const data = await reports.scanAuditTrail({ plate, passId, propertyId });

  if (format === 'csv') {
    const name = plate ? `plate_${plate}` : `pass_${passId?.slice(0, 8)}`;
    return sendCsv(res, `parkcontrol_audit_${name}.csv`, data.auditTrail, 'auditTrail');
  }
  res.json(data);
}));

// ─── GET /api/reports — index of available reports ───────────────────────────

router.get('/', asyncHandler(async (req, res) => {
  const isAdmin = isSuperAdmin(req.user);
  const base = '/api/reports';

  res.json({
    reports: [
      isAdmin && {
        name: 'Property Summary',
        endpoint: `${base}/summary`,
        description: 'High-level KPIs for all properties — super admin only',
        formats: ['json', 'csv'],
        params: [],
      },
      {
        name: 'Zone Occupancy',
        endpoint: `${base}/occupancy`,
        description: 'Current active passes per zone with capacity utilization',
        formats: ['json', 'csv'],
        params: ['propertyId'],
      },
      {
        name: 'Pass Activity',
        endpoint: `${base}/passes`,
        description: 'Pass issuance counts, types, and daily time series',
        formats: ['json', 'csv'],
        params: ['propertyId', 'from', 'to'],
      },
      {
        name: 'Violations',
        endpoint: `${base}/violations`,
        description: 'Unauthorized, flagged, and tow-eligible vehicles',
        formats: ['json', 'csv'],
        params: ['propertyId', 'from', 'to', 'status'],
      },
      {
        name: 'Resident Compliance',
        endpoint: `${base}/compliance`,
        description: 'Per-unit vehicle and pass compliance — requires propertyId',
        formats: ['json', 'csv'],
        params: ['propertyId (required)'],
      },
      {
        name: 'Enforcement Activity',
        endpoint: `${base}/enforcement`,
        description: 'Officer scan counts, result breakdown, hourly heatmap',
        formats: ['json', 'csv'],
        params: ['propertyId', 'from', 'to'],
      },
      {
        name: 'Visitor Link Usage',
        endpoint: `${base}/visitor-links`,
        description: 'Self-registration link issuance and use rate',
        formats: ['json', 'csv'],
        params: ['propertyId', 'from', 'to'],
      },
      {
        name: 'Scan Audit Trail',
        endpoint: `${base}/audit-trail`,
        description: 'Full event history for a specific plate or pass (legal/disputes)',
        formats: ['json', 'csv'],
        params: ['plate OR passId', 'propertyId'],
      },
    ].filter(Boolean),
  });
}));

module.exports = router;
