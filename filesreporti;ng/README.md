# ParkControl API

Multi-property parking management system — Node.js / Express / PostgreSQL / Prisma

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express 4 |
| Database | PostgreSQL 15+ |
| ORM | Prisma 5 |
| Auth | JWT (access + refresh token rotation) |
| QR Signing | JWT (separate secret) + `qrcode` lib |
| Logging | Winston |
| Validation | express-validator |

---

## Project Structure

```
parkcontrol/
├── prisma/
│   ├── schema.prisma        # Full DB schema — all models & enums
│   └── seed.js              # Dev seed with test users, properties, vehicles
├── src/
│   ├── index.js             # Express app entry point
│   ├── middleware/
│   │   ├── auth.js          # JWT verify, role guard, property-scoped access
│   │   └── errorHandler.js  # Global error handler + asyncHandler wrapper
│   ├── routes/
│   │   ├── auth.js          # register, login, refresh, logout, /me
│   │   ├── properties.js    # CRUD properties (super admin)
│   │   ├── units.js         # CRUD units per property
│   │   ├── users.js         # Profile update, user-property assignment
│   │   ├── vehicles.js      # Register, list, blacklist, remove vehicles
│   │   ├── passes.js        # Issue, list, view, revoke passes + QR
│   │   ├── visitorLinks.js  # Generate links, visitor self-registration
│   │   ├── enforcement.js   # QR scan + plate lookup endpoints
│   │   ├── audit.js         # Filterable audit log
│   │   └── rules.js         # Per-property rules CRUD
│   ├── services/
│   │   ├── passService.js   # Core pass engine: create, verify, plate lookup
│   │   └── auditService.js  # Audit log writer (never throws)
│   └── utils/
│       ├── prisma.js        # Prisma client singleton
│       └── logger.js        # Winston logger
└── .env.example
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment
```bash
cp .env.example .env
# Edit .env — set DATABASE_URL and generate secrets:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Run that 3 times — paste into JWT_SECRET, JWT_REFRESH_SECRET, PASS_SIGNING_SECRET
```

### 3. Set up the database
```bash
# Make sure PostgreSQL is running, then:
npx prisma migrate dev --name init
npx prisma generate
node prisma/seed.js
```

### 4. Run the server
```bash
npm run dev        # development (nodemon)
npm start          # production
```

Server runs on `http://localhost:3000`

---

## API Reference

### Auth
| Method | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login, get tokens |
| POST | `/api/auth/refresh` | Rotate refresh token |
| POST | `/api/auth/logout` | Revoke refresh token |
| GET  | `/api/auth/me` | Current user + properties |

### Properties
| Method | Route | Auth |
|---|---|---|
| GET | `/api/properties` | All roles |
| POST | `/api/properties` | Super admin |
| GET | `/api/properties/:propertyId` | Property access |

### Units
| Method | Route | Auth |
|---|---|---|
| GET | `/api/units?propertyId=` | Property access |
| POST | `/api/units` | Manager+ |

### Vehicles
| Method | Route | Auth |
|---|---|---|
| GET | `/api/vehicles` | Scoped to role |
| POST | `/api/vehicles` | Resident+ |
| PATCH | `/api/vehicles/:id/blacklist` | Manager+ |
| DELETE | `/api/vehicles/:id` | Owner or admin |

### Passes
| Method | Route | Auth |
|---|---|---|
| POST | `/api/passes` | Resident+ |
| GET | `/api/passes` | Scoped to role |
| GET | `/api/passes/:id` | Owner or manager |
| PATCH | `/api/passes/:id/revoke` | Owner or manager |

### Visitor Self-Registration Links
| Method | Route | Auth |
|---|---|---|
| POST | `/api/visitor-links` | Resident+ |
| GET | `/api/visitor-links` | Resident (own links) |
| GET | `/api/visitor-links/:token` | Public (no auth) |
| POST | `/api/visitor-links/:token/register` | Public (no auth) |

### Enforcement
| Method | Route | Auth |
|---|---|---|
| POST | `/api/enforcement/scan-qr` | Enforcement+ |
| POST | `/api/enforcement/lookup-plate` | Enforcement+ |

### Reporting
All reports accept `?format=csv` to return a downloadable CSV file (Excel-compatible with BOM).
Time-range reports accept `?from=` and `?to=` as ISO date strings.

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/reports` | Manager+ | Index of all available reports |
| GET | `/api/reports/summary` | Super admin | All-properties KPI dashboard |
| GET | `/api/reports/occupancy` | Manager+ | Current zone occupancy snapshot |
| GET | `/api/reports/passes` | Manager+ | Pass activity with daily time series |
| GET | `/api/reports/violations` | Manager+ | Unauthorized / flagged / tow-eligible vehicles |
| GET | `/api/reports/compliance` | Manager+ | Per-unit resident compliance (requires `propertyId`) |
| GET | `/api/reports/enforcement` | Manager+ | Officer scan counts + hourly heatmap |
| GET | `/api/reports/visitor-links` | Manager+ | Self-registration link usage rate |
| GET | `/api/reports/audit-trail` | Manager+ | Full event log per plate or pass (legal/disputes) |

### Rules
| Method | Route | Auth |
|---|---|---|
| GET | `/api/rules/:propertyId` | Property access |
| PATCH | `/api/rules/:propertyId` | Manager+ |

---

## Role Hierarchy

```
SUPER_ADMIN          → full access to all properties and system config
PROPERTY_MANAGER     → full access to their assigned properties
RESIDENT             → their unit only: register vehicles, issue/revoke visitor passes
ENFORCEMENT          → scan QR codes and look up plates (read-only)
```

---

## Pass Engine — How It Works

1. **Resident issues a pass** → `POST /api/passes`
   - Rules are checked (blacklist, max passes per unit)
   - Pass record created with expiry
   - JWT signed with `PASS_SIGNING_SECRET` containing `{passId, plate, propertyId, zoneId, expiresAt}`
   - QR code image generated from that JWT
   - Audit log written

2. **Visitor self-registers** → `POST /api/visitor-links/:token/register`
   - Resident first generates a link via `POST /api/visitor-links`
   - Visitor opens link, enters their own plate/vehicle info
   - Same pass creation flow fires, link marked as used

3. **Enforcement scans QR** → `POST /api/enforcement/scan-qr`
   - JWT signature verified (tamper-proof)
   - Pass looked up in DB
   - Checks: blacklist → revoked → expired (with grace period) → wrong zone
   - Scan recorded in `PassScan` table
   - Result returned: `VALID | WITHIN_GRACE_PERIOD | EXPIRED | REVOKED | BLACKLISTED | WRONG_ZONE | NOT_FOUND`
   - Unregistered vehicles accumulate scan counts → auto-flag `TOW_ELIGIBLE` after threshold

4. **Plate lookup** → `POST /api/enforcement/lookup-plate`
   - Finds active pass OR registered resident vehicle for that plate
   - Falls through to unauthorized tracking if neither found

---

## Scan Result Reference

| Result | Meaning | Display suggestion |
|---|---|---|
| `VALID` | Pass active, in zone, not expired | Green — allow |
| `WITHIN_GRACE_PERIOD` | Expired but within grace window | Yellow — warn |
| `EXPIRED` | Pass has expired | Red — violation |
| `REVOKED` | Manually revoked | Red — violation |
| `BLACKLISTED` | Vehicle on blacklist | Red — call management |
| `WRONG_ZONE` | Valid pass, wrong lot | Yellow — redirect |
| `NOT_FOUND` | No pass in system | Red — flag/log |

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Access token signing secret |
| `JWT_REFRESH_SECRET` | Refresh token signing secret |
| `JWT_EXPIRES_IN` | Access token TTL (default `15m`) |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL (default `7d`) |
| `PASS_SIGNING_SECRET` | QR pass payload signing secret |
| `PORT` | Server port (default `3000`) |
| `FRONTEND_URL` | CORS allowed origin |
| `VISITOR_LINK_BASE_URL` | Base URL for visitor self-reg links |
| `SMTP_*` | Email configuration |

---

## What's built

- [x] Multi-property + multi-zone data model
- [x] Role hierarchy: Super Admin → Manager → Resident → Enforcement
- [x] Pass engine with JWT-signed QR codes
- [x] Visitor self-registration via one-time links
- [x] Grace period + tow-eligible auto-flagging
- [x] Email notifications (9 templates, Ethereal dev / SMTP prod)
- [x] Background scheduler (expiry, warnings, renewal reminders)
- [x] Reporting suite (8 reports, JSON + CSV export)
- [x] Audit log (every event, every scan, every change)

## Future ideas

- [ ] Webhook support for tow company integrations
- [ ] Stripe billing integration for SaaS pricing
- [ ] Native iOS / Android app (React Native) for enforcement
