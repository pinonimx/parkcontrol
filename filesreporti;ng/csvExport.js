// csvExport.js — lightweight CSV builder, no dependencies needed

const escapeCell = (val) => {
  if (val === null || val === undefined) return '';
  const str = String(val);
  // Wrap in quotes if contains comma, quote, or newline
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const toCsv = (rows, columns) => {
  if (!rows.length) return columns.map(c => c.header).join(',') + '\n';

  const header = columns.map(c => escapeCell(c.header)).join(',');
  const body = rows.map(row =>
    columns.map(c => escapeCell(c.accessor ? c.accessor(row) : row[c.key])).join(',')
  ).join('\n');

  return header + '\n' + body;
};

// Column definitions per report type
const COLUMNS = {
  passes: [
    { header: 'Pass ID',      key: 'passId' },
    { header: 'Plate',        key: 'plate' },
    { header: 'Type',         key: 'type' },
    { header: 'Status',       key: 'status' },
    { header: 'Property',     key: 'property' },
    { header: 'Zone',         key: 'zone' },
    { header: 'Issued By',    key: 'issuedBy' },
    { header: 'Visitor Name', key: 'visitorName' },
    { header: 'Starts At',    key: 'startsAt' },
    { header: 'Expires At',   key: 'expiresAt' },
    { header: 'Revoked At',   key: 'revokedAt' },
    { header: 'Revoke Reason', key: 'revokedReason' },
  ],

  violations: [
    { header: 'Plate',          key: 'plate' },
    { header: 'State',          key: 'state' },
    { header: 'Make',           key: 'make' },
    { header: 'Color',          key: 'color' },
    { header: 'Status',         key: 'status' },
    { header: 'Blacklisted',    accessor: r => r.blacklisted ? 'Yes' : 'No' },
    { header: 'Blacklist Note', key: 'blacklistNote' },
    { header: 'First Seen',     key: 'firstSeen' },
    { header: 'Last Updated',   key: 'lastUpdated' },
  ],

  compliance: [
    { header: 'Unit',            key: 'unitNumber' },
    { header: 'Vacant',          accessor: r => r.vacant ? 'Yes' : 'No' },
    { header: 'Residents',       key: 'residents' },
    { header: 'Vehicles',        key: 'vehicleCount' },
    { header: 'Active Passes',   key: 'activePasses' },
    { header: 'Max Passes',      key: 'maxPasses' },
    { header: 'Over Limit',      accessor: r => r.overPassLimit ? 'Yes' : 'No' },
    { header: 'Has Violation',   accessor: r => r.hasViolation ? 'Yes' : 'No' },
    { header: 'Compliant',       accessor: r => r.compliant ? 'Yes' : 'No' },
  ],

  occupancy: [
    { header: 'Property',      key: 'propertyName' },
    { header: 'City',          key: 'city' },
    { header: 'Zone',          key: 'zoneName' },
    { header: 'Capacity',      accessor: r => r.capacity ?? 'Unlimited' },
    { header: 'Active Passes', key: 'activePasses' },
    { header: 'Visitor',       key: 'visitorPasses' },
    { header: 'Resident',      key: 'residentPasses' },
    { header: 'Occupancy %',   accessor: r => r.occupancyPct !== null ? `${r.occupancyPct}%` : '—' },
    { header: 'Status',        key: 'status' },
  ],

  enforcement: [
    { header: 'Officer',        key: 'officerName' },
    { header: 'Total Scans',    key: 'total' },
    { header: 'Valid',          key: 'valid' },
    { header: 'Grace Period',   key: 'grace' },
    { header: 'Invalid',        key: 'invalid' },
  ],

  visitorLinks: [
    { header: 'Token',       key: 'token' },
    { header: 'Property',    key: 'property' },
    { header: 'Issued By',   key: 'issuedBy' },
    { header: 'Duration (hrs)', key: 'durationHrs' },
    { header: 'Used',        accessor: r => r.isUsed ? 'Yes' : 'No' },
    { header: 'Used At',     key: 'usedAt' },
    { header: 'Expires At',  key: 'expiresAt' },
    { header: 'Plate',       key: 'plate' },
    { header: 'Pass Status', key: 'passStatus' },
    { header: 'Created At',  key: 'createdAt' },
  ],

  propertySummary: [
    { header: 'Property',          key: 'propertyName' },
    { header: 'City',              key: 'city' },
    { header: 'State',             key: 'state' },
    { header: 'Type',              key: 'type' },
    { header: 'Units',             key: 'totalUnits' },
    { header: 'Zones',             key: 'zoneCount' },
    { header: 'Total Capacity',    key: 'totalCapacity' },
    { header: 'Registered Vehicles', key: 'totalVehicles' },
    { header: 'Active Passes',     key: 'activePasses' },
    { header: 'Expiring Today',    key: 'expiringToday' },
    { header: 'Open Violations',   key: 'openViolations' },
    { header: 'Passes (30 days)',  key: 'passesLast30Days' },
    { header: 'Scans (30 days)',   key: 'scansLast30Days' },
  ],

  auditTrail: [
    { header: 'Timestamp', key: 'timestamp' },
    { header: 'Event',     key: 'event' },
    { header: 'Outcome',   key: 'outcome' },
    { header: 'Plate',     key: 'plate' },
    { header: 'Property',  key: 'property' },
    { header: 'By',        key: 'by' },
  ],
};

const sendCsv = (res, filename, rows, reportType) => {
  const columns = COLUMNS[reportType];
  if (!columns) throw new Error(`Unknown report type: ${reportType}`);

  const csv = toCsv(rows, columns);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv); // BOM prefix for Excel compatibility
};

module.exports = { toCsv, sendCsv, COLUMNS };
