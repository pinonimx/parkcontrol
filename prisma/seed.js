// prisma/seed.js — populate dev database with realistic test data
// Run: node prisma/seed.js

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱  Seeding ParkControl database...');

  // ── Users ──────────────────────────────────────────────────────────────────

  const hash = (pw) => bcrypt.hash(pw, 10);

  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@parkcontrol.app' },
    update: {},
    create: {
      email: 'admin@parkcontrol.app',
      passwordHash: await hash('Admin1234!'),
      firstName: 'Super',
      lastName: 'Admin',
    },
  });

  const manager = await prisma.user.upsert({
    where: { email: 'manager@oakridge.com' },
    update: {},
    create: {
      email: 'manager@oakridge.com',
      passwordHash: await hash('Manager1234!'),
      firstName: 'Alex',
      lastName: 'Rivera',
      phone: '+12145550100',
    },
  });

  const resident1 = await prisma.user.upsert({
    where: { email: 'm.gonzalez@email.com' },
    update: {},
    create: {
      email: 'm.gonzalez@email.com',
      passwordHash: await hash('Resident1234!'),
      firstName: 'Maria',
      lastName: 'Gonzalez',
      phone: '+12145550187',
    },
  });

  const resident2 = await prisma.user.upsert({
    where: { email: 'j.okafor@email.com' },
    update: {},
    create: {
      email: 'j.okafor@email.com',
      passwordHash: await hash('Resident1234!'),
      firstName: 'James',
      lastName: 'Okafor',
      phone: '+12145550202',
    },
  });

  const officer = await prisma.user.upsert({
    where: { email: 'k.davis@enforcement.com' },
    update: {},
    create: {
      email: 'k.davis@enforcement.com',
      passwordHash: await hash('Officer1234!'),
      firstName: 'K.',
      lastName: 'Davis',
    },
  });

  console.log('  ✓ Users created');

  // ── Properties ─────────────────────────────────────────────────────────────

  const oakridge = await prisma.property.upsert({
    where: { id: 'prop-oakridge-0001' },
    update: {},
    create: {
      id: 'prop-oakridge-0001',
      name: 'Oakridge Apartments',
      address: '1200 Oakridge Blvd',
      city: 'McKinney',
      state: 'TX',
      zip: '75070',
      type: 'RESIDENTIAL',
    },
  });

  const marina = await prisma.property.upsert({
    where: { id: 'prop-marina-0002' },
    update: {},
    create: {
      id: 'prop-marina-0002',
      name: 'Marina Bay Complex',
      address: '500 Marina Dr',
      city: 'Frisco',
      state: 'TX',
      zip: '75034',
      type: 'RESIDENTIAL',
    },
  });

  const westpark = await prisma.property.upsert({
    where: { id: 'prop-westpark-0003' },
    update: {},
    create: {
      id: 'prop-westpark-0003',
      name: 'Westpark Office',
      address: '8800 Westpark Pkwy',
      city: 'Plano',
      state: 'TX',
      zip: '75024',
      type: 'COMMERCIAL',
    },
  });

  console.log('  ✓ Properties created');

  // ── Property Rules ─────────────────────────────────────────────────────────

  for (const propertyId of [oakridge.id, marina.id, westpark.id]) {
    await prisma.propertyRules.upsert({
      where: { propertyId },
      update: {},
      create: {
        propertyId,
        visitorPassDurationHrs: 24,
        allowOvernightPasses: true,
        maxVisitorPassesPerUnit: 2,
        gracePeriodMinutes: 30,
        towEligibleAfterScans: 3,
        permitRenewalDays: 365,
        renewalReminderDays: 30,
        blacklistAutoFlag: true,
      },
    });
  }

  console.log('  ✓ Property rules created');

  // ── Zones ──────────────────────────────────────────────────────────────────

  const lotA = await prisma.zone.upsert({
    where: { id: 'zone-oakridge-lota' },
    update: {},
    create: { id: 'zone-oakridge-lota', propertyId: oakridge.id, name: 'Lot A', capacity: 100 },
  });

  await prisma.zone.upsert({
    where: { id: 'zone-marina-lota' },
    update: {},
    create: { id: 'zone-marina-lota', propertyId: marina.id, name: 'Lot A', capacity: 60 },
  });

  await prisma.zone.upsert({
    where: { id: 'zone-marina-lotb' },
    update: {},
    create: { id: 'zone-marina-lotb', propertyId: marina.id, name: 'Lot B', capacity: 80 },
  });

  await prisma.zone.upsert({
    where: { id: 'zone-westpark-g1' },
    update: {},
    create: { id: 'zone-westpark-g1', propertyId: westpark.id, name: 'Garage Level 1', capacity: 120 },
  });

  await prisma.zone.upsert({
    where: { id: 'zone-westpark-g2' },
    update: {},
    create: { id: 'zone-westpark-g2', propertyId: westpark.id, name: 'Garage Level 2', capacity: 150 },
  });

  console.log('  ✓ Zones created');

  // ── Units ──────────────────────────────────────────────────────────────────

  const unit204 = await prisma.unit.upsert({
    where: { propertyId_number: { propertyId: oakridge.id, number: '204' } },
    update: {},
    create: { propertyId: oakridge.id, number: '204', floor: 2 },
  });

  const unit107 = await prisma.unit.upsert({
    where: { propertyId_number: { propertyId: oakridge.id, number: '107' } },
    update: {},
    create: { propertyId: oakridge.id, number: '107', floor: 1 },
  });

  console.log('  ✓ Units created');

  // ── User ↔ Property Assignments ────────────────────────────────────────────

  // Super admin: all-access (no property row needed — checked by role enum)
  await prisma.userProperty.upsert({
    where: { userId_propertyId: { userId: superAdmin.id, propertyId: oakridge.id } },
    update: {},
    create: { userId: superAdmin.id, propertyId: oakridge.id, role: 'SUPER_ADMIN' },
  });

  // Property manager → Oakridge
  await prisma.userProperty.upsert({
    where: { userId_propertyId: { userId: manager.id, propertyId: oakridge.id } },
    update: {},
    create: { userId: manager.id, propertyId: oakridge.id, role: 'PROPERTY_MANAGER' },
  });

  // Residents
  await prisma.userProperty.upsert({
    where: { userId_propertyId: { userId: resident1.id, propertyId: oakridge.id } },
    update: {},
    create: { userId: resident1.id, propertyId: oakridge.id, role: 'RESIDENT', unitId: unit204.id },
  });

  await prisma.userProperty.upsert({
    where: { userId_propertyId: { userId: resident2.id, propertyId: oakridge.id } },
    update: {},
    create: { userId: resident2.id, propertyId: oakridge.id, role: 'RESIDENT', unitId: unit107.id },
  });

  // Enforcement officer → Oakridge + Marina
  await prisma.userProperty.upsert({
    where: { userId_propertyId: { userId: officer.id, propertyId: oakridge.id } },
    update: {},
    create: { userId: officer.id, propertyId: oakridge.id, role: 'ENFORCEMENT' },
  });

  await prisma.userProperty.upsert({
    where: { userId_propertyId: { userId: officer.id, propertyId: marina.id } },
    update: {},
    create: { userId: officer.id, propertyId: marina.id, role: 'ENFORCEMENT' },
  });

  console.log('  ✓ User-property assignments created');

  // ── Vehicles ───────────────────────────────────────────────────────────────

  await prisma.vehicle.upsert({
    where: { id: 'veh-7xgh142' },
    update: {},
    create: {
      id: 'veh-7xgh142',
      plate: '7XGH142', state: 'TX',
      make: 'Honda', model: 'Civic', year: 2019, color: 'Silver',
      ownerId: resident1.id, unitId: unit204.id, zoneId: lotA.id,
      permitType: 'RESIDENT', status: 'ACTIVE',
    },
  });

  await prisma.vehicle.upsert({
    where: { id: 'veh-rtx5521' },
    update: {},
    create: {
      id: 'veh-rtx5521',
      plate: 'RTX5521', state: 'TX',
      make: 'Toyota', model: 'RAV4', year: 2022, color: 'White',
      ownerId: resident1.id, unitId: unit204.id, zoneId: lotA.id,
      permitType: 'RESIDENT', status: 'ACTIVE',
    },
  });

  await prisma.vehicle.upsert({
    where: { id: 'veh-tnw0034' },
    update: {},
    create: {
      id: 'veh-tnw0034',
      plate: 'TNW0034', state: 'TX',
      make: 'Ford', model: 'F-150', year: 2020, color: 'Black',
      ownerId: resident2.id, unitId: unit107.id, zoneId: lotA.id,
      permitType: 'RESIDENT', status: 'ACTIVE',
    },
  });

  // Blacklisted vehicle
  await prisma.vehicle.upsert({
    where: { id: 'veh-pzk9901' },
    update: {},
    create: {
      id: 'veh-pzk9901',
      plate: 'PZK9901', state: 'TX',
      isBlacklisted: true,
      blacklistNote: 'Trespassing — banned by management 2025-01-10',
      status: 'FLAGGED',
    },
  });

  console.log('  ✓ Vehicles created');

  console.log('\n✅  Seed complete!\n');
  console.log('Test credentials:');
  console.log('  Super Admin:  admin@parkcontrol.app      / Admin1234!');
  console.log('  Manager:      manager@oakridge.com       / Manager1234!');
  console.log('  Resident 1:   m.gonzalez@email.com       / Resident1234!');
  console.log('  Resident 2:   j.okafor@email.com         / Resident1234!');
  console.log('  Enforcement:  k.davis@enforcement.com    / Officer1234!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
