// reportingService.js
// All reporting queries for ParkControl.
// Each function returns structured data — routes handle formatting (JSON/CSV).

const prisma = require('../utils/prisma');

// ─── Shared helpers ───────────────────────────────────────────────────────────

const dateRange = (from, to) => {
  const where = {};
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to)   where.createdAt.lte = new Date(to);
  }
  return where;
};

const passDateRange = (from, to) => {
  const where = {};
  if (from || to) {
    where.startsAt = {};
    if (from) where.startsAt.gte = new Date(from);
    if (to)   where.startsAt.lte = new Date(to);
  }
  return where;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. OCCUPANCY REPORT
// Current snapshot: how many spaces are in use per zone, per property.
// ─────────────────────────────────────────────────────────────────────────────

const occupancyReport = async ({ propertyId } = {}) => {
  const now = new Date();

  const zoneWhere = propertyId ? { propertyId } : {};
  const zones = await prisma.zone.findMany({
    where: { ...zoneWhere, isActive: true },
    include: {
      property: { select: { id: true, name: true, city: true, state: true } },
      passes: {
        where: { status: 'ACTIVE', expiresAt: { gt: now } },
        select: { id: true, type: true, plate: true },
      },
    },
    orderBy: [{ property: { name: 'asc' } }, { name: 'asc' }],
  });

  const rows = zones.map(z => {
    const total    = z.passes.length;
    const visitor  = z.passes.filter(p => p.type === 'VISITOR').length;
    const resident = z.passes.filter(p => p.type === 'RESIDENT_PERMIT').length;
    const pct      = z.capacity ? Math.round((total / z.capacity) * 100) : null;

    return {
      propertyId:   z.property.id,
      propertyName: z.property.name,
      city:         z.property.city,
      state:        z.property.state,
      zoneId:       z.id,
      zoneName:     z.name,
      capacity:     z.capacity,
      activePasses: total,
      visitorPasses:   visitor,
      residentPasses:  resident,
      occupancyPct: pct,
      status:       pct === null ? 'unknown' : pct >= 100 ? 'full' : pct >= 80 ? 'high' : 'normal',
    };
  });

  const summary = {
    totalZones:       rows.length,
    fullZones:        rows.filter(r => r.status === 'full').length,
    highZones:        rows.filter(r => r.status === 'high').length,
    totalActivePasses: rows.reduce((s, r) => s + r.activePasses, 0),
    generatedAt:      now.toISOString(),
  };

  return { summary, rows };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. PASS ACTIVITY REPORT
// Passes issued over a period — counts, types, duration breakdown, by property.
// ─────────────────────────────────────────────────────────────────────────────

const passActivityReport = async ({ propertyId, from, to } = {}) => {
  const where = {
    ...(propertyId ? { propertyId } : {}),
    ...passDateRange(from, to),
  };

  const passes = await prisma.pass.findMany({
    where,
    include: {
      property: { select: { name: true } },
      zone:     { select: { name: true } },
      issuedBy: { select: { firstName: true, lastName: true } },
    },
    orderBy: { startsAt: 'desc' },
    take: 2000,
  });

  // Aggregate by property
  const byProperty = {};
  for (const p of passes) {
    const key = p.propertyId;
    if (!byProperty[key]) {
      byProperty[key] = {
        propertyId:   p.propertyId,
        propertyName: p.property.name,
        total: 0, visitor: 0, residentPermit: 0, temporary: 0,
        active: 0, expired: 0, revoked: 0,
        selfRegistered: 0, managerIssued: 0, residentIssued: 0,
      };
    }
    const b = byProperty[key];
    b.total++;
    if (p.type === 'VISITOR')          b.visitor++;
    if (p.type === 'RESIDENT_PERMIT')  b.residentPermit++;
    if (p.type === 'TEMPORARY')        b.temporary++;
    if (p.status === 'ACTIVE')         b.active++;
    if (p.status === 'EXPIRED')        b.expired++;
    if (p.status === 'REVOKED')        b.revoked++;
    if (p.visitorLinkId)               b.selfRegistered++;
    else if (p.issuedById)             b.residentIssued++;
    else                               b.managerIssued++;
  }

  // Daily time series (last 30 data points)
  const dailyCounts = {};
  for (const p of passes) {
    const day = p.startsAt.toISOString().slice(0, 10);
    dailyCounts[day] = (dailyCounts[day] || 0) + 1;
  }
  const timeSeries = Object.entries(dailyCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  const summary = {
    total:          passes.length,
    visitor:        passes.filter(p => p.type === 'VISITOR').length,
    residentPermit: passes.filter(p => p.type === 'RESIDENT_PERMIT').length,
    active:         passes.filter(p => p.status === 'ACTIVE').length,
    expired:        passes.filter(p => p.status === 'EXPIRED').length,
    revoked:        passes.filter(p => p.status === 'REVOKED').length,
    selfRegistered: passes.filter(p => p.visitorLinkId).length,
    period:         { from: from || null, to: to || null },
    generatedAt:    new Date().toISOString(),
  };

  const rows = passes.map(p => ({
    passId:       p.id.slice(0, 8).toUpperCase(),
    plate:        p.plate,
    type:         p.type,
    status:       p.status,
    property:     p.property.name,
    zone:         p.zone?.name || '—',
    issuedBy:     p.issuedById ? `${p.issuedBy?.firstName} ${p.issuedBy?.lastName}` : p.visitorLinkId ? 'Self-registered' : '—',
    visitorName:  p.visitorName || '—',
    startsAt:     p.startsAt.toISOString(),
    expiresAt:    p.expiresAt.toISOString(),
    revokedAt:    p.revokedAt?.toISOString() || '—',
    revokedReason: p.revokedReason || '—',
  }));

  return { summary, byProperty: Object.values(byProperty), timeSeries, rows };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. VIOLATIONS REPORT
// Unauthorized vehicles, blacklisted plates, tow-eligible, scan counts.
// ─────────────────────────────────────────────────────────────────────────────

const violationsReport = async ({ propertyId, from, to, status } = {}) => {
  const vehicleWhere = {
    status: status ? status : { in: ['MONITORING', 'FLAGGED', 'TOW_ELIGIBLE'] },
    ...(propertyId ? {
      passes: { none: {} },   // narrow further below per-pass
    } : {}),
  };

  const vehicles = await prisma.vehicle.findMany({
    where: vehicleWhere,
    include: {
      passes: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { propertyId: true, createdAt: true },
      },
      _count: { select: { passes: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });

  // Unauthorized scan events from audit log
  const auditWhere = {
    event: { in: ['VEHICLE_FLAGGED', 'TOW_ELIGIBLE_SET'] },
    ...dateRange(from, to),
    ...(propertyId ? { propertyId } : {}),
  };

  const auditEvents = await prisma.auditLog.findMany({
    where: auditWhere,
    include: {
      property: { select: { name: true } },
      user:     { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });

  // Scan counts per plate from PassScan
  const scanCounts = await prisma.passScan.groupBy({
    by: ['result'],
    where: {
      result: { in: ['NOT_FOUND', 'BLACKLISTED', 'REVOKED', 'EXPIRED'] },
      scannedAt: from || to ? {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to   ? { lte: new Date(to)   } : {}),
      } : undefined,
    },
    _count: { result: true },
  });

  const summary = {
    monitoring:   vehicles.filter(v => v.status === 'MONITORING').length,
    flagged:      vehicles.filter(v => v.status === 'FLAGGED').length,
    towEligible:  vehicles.filter(v => v.status === 'TOW_ELIGIBLE').length,
    blacklisted:  vehicles.filter(v => v.isBlacklisted).length,
    scanBreakdown: Object.fromEntries(scanCounts.map(s => [s.result, s._count.result])),
    period:       { from: from || null, to: to || null },
    generatedAt:  new Date().toISOString(),
  };

  const rows = vehicles.map(v => ({
    plate:         v.plate,
    state:         v.state,
    make:          v.make || '—',
    color:         v.color || '—',
    status:        v.status,
    blacklisted:   v.isBlacklisted,
    blacklistNote: v.blacklistNote || '—',
    firstSeen:     v.createdAt.toISOString(),
    lastUpdated:   v.updatedAt.toISOString(),
  }));

  return { summary, rows, auditEvents: auditEvents.map(e => ({
    event:     e.event,
    plate:     e.plate,
    property:  e.property?.name || '—',
    officer:   e.user ? `${e.user.firstName} ${e.user.lastName}` : 'System',
    outcome:   e.outcome,
    createdAt: e.createdAt.toISOString(),
    metadata:  e.metadata,
  })) };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. RESIDENT COMPLIANCE REPORT
// Per-unit: vehicle count, active passes, permit status, violations.
// ─────────────────────────────────────────────────────────────────────────────

const residentComplianceReport = async ({ propertyId } = {}) => {
  if (!propertyId) throw Object.assign(new Error('propertyId required'), { status: 400 });

  const units = await prisma.unit.findMany({
    where: { propertyId },
    include: {
      residents: {
        include: { user: { select: { firstName: true, lastName: true, email: true } } },
      },
      vehicles: {
        where: { status: { not: 'REMOVED' } },
        include: {
          passes: {
            where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
            select: { id: true, type: true, expiresAt: true },
          },
        },
      },
    },
    orderBy: { number: 'asc' },
  });

  const rules = await prisma.propertyRules.findUnique({ where: { propertyId } });

  const rows = units.map(u => {
    const residentNames = u.residents.map(r => `${r.user.firstName} ${r.user.lastName}`).join(', ') || '—';
    const allVehicles   = u.vehicles;
    const activePasses  = allVehicles.flatMap(v => v.passes);
    const hasViolation  = allVehicles.some(v => v.isBlacklisted || ['FLAGGED', 'TOW_ELIGIBLE'].includes(v.status));
    const overLimit     = activePasses.length > (rules?.maxVisitorPassesPerUnit || 2);

    return {
      unitNumber:    u.number,
      vacant:        u.isVacant,
      residents:     residentNames,
      vehicleCount:  allVehicles.length,
      activePasses:  activePasses.length,
      maxPasses:     rules?.maxVisitorPassesPerUnit || 2,
      overPassLimit: overLimit,
      hasViolation,
      compliant:     !hasViolation && !overLimit,
    };
  });

  const summary = {
    totalUnits:     rows.length,
    vacantUnits:    rows.filter(r => r.vacant).length,
    compliantUnits: rows.filter(r => r.compliant).length,
    violationUnits: rows.filter(r => r.hasViolation).length,
    overLimitUnits: rows.filter(r => r.overPassLimit).length,
    generatedAt:    new Date().toISOString(),
  };

  return { summary, rows };
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. ENFORCEMENT ACTIVITY REPORT
// Officer scan counts, outcomes, time-of-day heatmap.
// ─────────────────────────────────────────────────────────────────────────────

const enforcementActivityReport = async ({ propertyId, from, to } = {}) => {
  const scans = await prisma.passScan.findMany({
    where: {
      scannedAt: from || to ? {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to   ? { lte: new Date(to)   } : {}),
      } : undefined,
      ...(propertyId ? { pass: { propertyId } } : {}),
    },
    include: {
      pass:      { select: { propertyId: true, plate: true, type: true } },
      // scannedBy is just a userId — we join manually below
    },
    orderBy: { scannedAt: 'desc' },
    take: 5000,
  });

  // Load officer names for scannedById values
  const officerIds = [...new Set(scans.map(s => s.scannedById).filter(Boolean))];
  const officers = await prisma.user.findMany({
    where: { id: { in: officerIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const officerMap = Object.fromEntries(officers.map(o => [o.id, `${o.firstName} ${o.lastName}`]));

  // Per-officer breakdown
  const byOfficer = {};
  for (const s of scans) {
    const key  = s.scannedById || 'anonymous';
    const name = officerMap[key] || 'Anonymous / Kiosk';
    if (!byOfficer[key]) byOfficer[key] = { officerId: key, officerName: name, total: 0, valid: 0, invalid: 0, grace: 0 };
    byOfficer[key].total++;
    if (['VALID'].includes(s.result))                      byOfficer[key].valid++;
    else if (['WITHIN_GRACE_PERIOD'].includes(s.result))   byOfficer[key].grace++;
    else                                                   byOfficer[key].invalid++;
  }

  // Hour-of-day heatmap (0–23)
  const hourCounts = Array(24).fill(0);
  for (const s of scans) hourCounts[new Date(s.scannedAt).getHours()]++;

  // Result breakdown
  const byResult = {};
  for (const s of scans) byResult[s.result] = (byResult[s.result] || 0) + 1;

  // Daily series
  const dailyCounts = {};
  for (const s of scans) {
    const day = s.scannedAt.toISOString().slice(0, 10);
    dailyCounts[day] = (dailyCounts[day] || 0) + 1;
  }

  const summary = {
    totalScans:   scans.length,
    uniqueOfficers: Object.keys(byOfficer).length,
    validRate:    scans.length ? Math.round((byResult['VALID'] || 0) / scans.length * 100) : 0,
    violationRate: scans.length ? Math.round(
      ((byResult['NOT_FOUND'] || 0) + (byResult['BLACKLISTED'] || 0) + (byResult['EXPIRED'] || 0)) / scans.length * 100
    ) : 0,
    period:       { from: from || null, to: to || null },
    generatedAt:  new Date().toISOString(),
  };

  return {
    summary,
    byOfficer:   Object.values(byOfficer).sort((a, b) => b.total - a.total),
    byResult,
    hourlyHeatmap: hourCounts.map((count, hour) => ({ hour, count })),
    timeSeries:  Object.entries(dailyCounts).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. VISITOR LINK USAGE REPORT
// How residents use the self-registration link feature.
// ─────────────────────────────────────────────────────────────────────────────

const visitorLinkReport = async ({ propertyId, from, to } = {}) => {
  const where = {
    ...(propertyId ? { propertyId } : {}),
    ...dateRange(from, to),
  };

  const links = await prisma.visitorLink.findMany({
    where,
    include: {
      issuedBy: { select: { firstName: true, lastName: true } },
      property: { select: { name: true } },
      passes:   { select: { id: true, plate: true, status: true, startsAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });

  const summary = {
    total:      links.length,
    used:       links.filter(l => l.isUsed).length,
    unused:     links.filter(l => !l.isUsed).length,
    expired:    links.filter(l => !l.isUsed && l.expiresAt < new Date()).length,
    useRate:    links.length ? Math.round(links.filter(l => l.isUsed).length / links.length * 100) : 0,
    period:     { from: from || null, to: to || null },
    generatedAt: new Date().toISOString(),
  };

  const rows = links.map(l => ({
    token:       l.token,
    property:    l.property.name,
    issuedBy:    `${l.issuedBy.firstName} ${l.issuedBy.lastName}`,
    durationHrs: l.durationHours,
    isUsed:      l.isUsed,
    usedAt:      l.usedAt?.toISOString() || '—',
    expiresAt:   l.expiresAt.toISOString(),
    plate:       l.passes[0]?.plate || '—',
    passStatus:  l.passes[0]?.status || '—',
    createdAt:   l.createdAt.toISOString(),
  }));

  return { summary, rows };
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. PROPERTY SUMMARY DASHBOARD REPORT
// High-level snapshot per property — intended for the super admin dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const propertySummaryReport = async () => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

  const properties = await prisma.property.findMany({
    where: { isActive: true },
    include: {
      zones:  { select: { id: true, name: true, capacity: true } },
      rules:  true,
      _count: { select: { units: true } },
    },
    orderBy: { name: 'asc' },
  });

  const rows = await Promise.all(properties.map(async (prop) => {
    const [
      totalVehicles, activePasses, expiringToday,
      violations, passesLast30, scansLast30,
    ] = await Promise.all([
      prisma.vehicle.count({
        where: { unit: { propertyId: prop.id }, status: { not: 'REMOVED' } },
      }),
      prisma.pass.count({
        where: { propertyId: prop.id, status: 'ACTIVE', expiresAt: { gt: now } },
      }),
      prisma.pass.count({
        where: {
          propertyId: prop.id, status: 'ACTIVE',
          expiresAt: { gte: now, lte: new Date(now.getTime() + 86400000) },
        },
      }),
      prisma.vehicle.count({
        where: {
          status: { in: ['FLAGGED', 'TOW_ELIGIBLE'] },
          unit: { propertyId: prop.id },
        },
      }),
      prisma.pass.count({
        where: { propertyId: prop.id, startsAt: { gte: thirtyDaysAgo } },
      }),
      prisma.passScan.count({
        where: { pass: { propertyId: prop.id }, scannedAt: { gte: thirtyDaysAgo } },
      }),
    ]);

    return {
      propertyId:   prop.id,
      propertyName: prop.name,
      city:         prop.city,
      state:        prop.state,
      type:         prop.type,
      totalUnits:   prop._count.units,
      zoneCount:    prop.zones.length,
      totalCapacity: prop.zones.reduce((s, z) => s + (z.capacity || 0), 0),
      totalVehicles,
      activePasses,
      expiringToday,
      openViolations: violations,
      passesLast30Days: passesLast30,
      scansLast30Days:  scansLast30,
      maxVisitorPasses: prop.rules?.maxVisitorPassesPerUnit,
      gracePeriodMin:   prop.rules?.gracePeriodMinutes,
    };
  }));

  const summary = {
    totalProperties: rows.length,
    totalVehicles:   rows.reduce((s, r) => s + r.totalVehicles, 0),
    totalActivePasses: rows.reduce((s, r) => s + r.activePasses, 0),
    totalViolations: rows.reduce((s, r) => s + r.openViolations, 0),
    generatedAt:     now.toISOString(),
  };

  return { summary, rows };
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. SCAN AUDIT TRAIL — per pass or per plate (legal / dispute resolution)
// Full chronological log of every event for a specific plate or pass.
// ─────────────────────────────────────────────────────────────────────────────

const scanAuditTrail = async ({ plate, passId, propertyId } = {}) => {
  if (!plate && !passId) throw Object.assign(new Error('plate or passId required'), { status: 400 });

  const normalizedPlate = plate?.toUpperCase().replace(/\s/g, '');

  // Load all passes for this plate / passId
  const passes = await prisma.pass.findMany({
    where: {
      ...(passId ? { id: passId } : { plate: normalizedPlate }),
      ...(propertyId ? { propertyId } : {}),
    },
    include: {
      property: { select: { name: true } },
      zone:     { select: { name: true } },
      issuedBy: { select: { firstName: true, lastName: true } },
      scans: {
        include: { /* scannedById resolved below */ },
        orderBy: { scannedAt: 'asc' },
      },
    },
    orderBy: { startsAt: 'desc' },
  });

  // Load scan officer names
  const scanUserIds = [...new Set(passes.flatMap(p => p.scans.map(s => s.scannedById)).filter(Boolean))];
  const scanUsers = await prisma.user.findMany({
    where: { id: { in: scanUserIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const scanUserMap = Object.fromEntries(scanUsers.map(u => [u.id, `${u.firstName} ${u.lastName}`]));

  // Load audit log events for this plate
  const auditEvents = await prisma.auditLog.findMany({
    where: {
      plate: normalizedPlate || undefined,
      ...(propertyId ? { propertyId } : {}),
    },
    include: {
      user:     { select: { firstName: true, lastName: true } },
      property: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const passRows = passes.map(p => ({
    passId:      p.id,
    plate:       p.plate,
    type:        p.type,
    status:      p.status,
    property:    p.property.name,
    zone:        p.zone?.name || '—',
    issuedBy:    p.issuedById ? `${p.issuedBy?.firstName} ${p.issuedBy?.lastName}` : p.visitorLinkId ? 'Visitor self-registered' : '—',
    visitorName: p.visitorName || '—',
    startsAt:    p.startsAt.toISOString(),
    expiresAt:   p.expiresAt.toISOString(),
    revokedAt:   p.revokedAt?.toISOString() || '—',
    revokedReason: p.revokedReason || '—',
    scans: p.scans.map(s => ({
      scannedAt:  s.scannedAt.toISOString(),
      result:     s.result,
      officer:    scanUserMap[s.scannedById] || 'Anonymous',
      deviceInfo: s.deviceInfo || '—',
      note:       s.note || '—',
    })),
  }));

  const auditRows = auditEvents.map(e => ({
    timestamp: e.createdAt.toISOString(),
    event:     e.event,
    outcome:   e.outcome || '—',
    plate:     e.plate || '—',
    property:  e.property?.name || '—',
    by:        e.user ? `${e.user.firstName} ${e.user.lastName}` : 'System',
    metadata:  e.metadata,
  }));

  return {
    plate: normalizedPlate || null,
    passId: passId || null,
    passes: passRows,
    auditTrail: auditRows,
    generatedAt: new Date().toISOString(),
  };
};

module.exports = {
  occupancyReport,
  passActivityReport,
  violationsReport,
  residentComplianceReport,
  enforcementActivityReport,
  visitorLinkReport,
  propertySummaryReport,
  scanAuditTrail,
};
