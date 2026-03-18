#!/usr/bin/env bash
# ParkControl — local setup script
# Run this from the parkcontrol/ directory: bash setup.sh

set -e  # exit on first error

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $1"; }
fail()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

echo ""
echo "  ParkControl — Local Setup"
echo "  ========================="
echo ""

# ── 1. Check Node version ─────────────────────────────────────────────────────
info "Checking Node.js..."
NODE_VER=$(node -e "process.exit(parseInt(process.versions.node) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
if [ "$NODE_VER" = "old" ]; then
  fail "Node.js 18+ required. Install from https://nodejs.org"
fi
info "Node $(node --version) ✓"

# ── 2. Check PostgreSQL ───────────────────────────────────────────────────────
info "Checking PostgreSQL..."
if ! command -v psql &>/dev/null; then
  warn "psql not found. Installing PostgreSQL 16..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq postgresql postgresql-client
  sudo systemctl start postgresql
  sudo systemctl enable postgresql
  info "PostgreSQL installed ✓"
else
  info "PostgreSQL $(psql --version | awk '{print $3}') ✓"
fi

# ── 3. Create database and user ───────────────────────────────────────────────
info "Setting up database..."
DB_NAME="parkcontrol"
DB_USER="parkcontrol"
DB_PASS="parkcontrol_dev"

sudo -u postgres psql -tc "SELECT 1 FROM pg_user WHERE usename = '${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};" > /dev/null
info "Database '${DB_NAME}' ready ✓"

# ── 4. Write .env ─────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  info "Generating .env..."
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  JWT_REFRESH=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  PASS_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")

  cat > .env <<EOF
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"

JWT_SECRET="${JWT_SECRET}"
JWT_REFRESH_SECRET="${JWT_REFRESH}"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"

PASS_SIGNING_SECRET="${PASS_SECRET}"

PORT=3000
NODE_ENV=development
APP_URL="http://localhost:3000"
FRONTEND_URL="http://localhost:5173"
VISITOR_LINK_BASE_URL="http://localhost:5173/v"

SMTP_HOST=""
SMTP_PORT=587
SMTP_USER=""
SMTP_PASS=""
EMAIL_FROM="ParkControl <noreply@parkcontrol.app>"
EOF
  info ".env created with generated secrets ✓"
else
  info ".env already exists — skipping ✓"
fi

# ── 5. Install npm dependencies ───────────────────────────────────────────────
info "Installing npm dependencies..."
npm install --silent
info "Dependencies installed ✓"

# ── 6. Generate Prisma client ─────────────────────────────────────────────────
info "Generating Prisma client..."
npx prisma generate --schema=prisma/schema.prisma
info "Prisma client generated ✓"

# ── 7. Run migrations ─────────────────────────────────────────────────────────
info "Running database migrations..."
npx prisma migrate dev --name init --schema=prisma/schema.prisma
info "Migrations applied ✓"

# ── 8. Seed database ──────────────────────────────────────────────────────────
info "Seeding database with test data..."
node prisma/seed.js
info "Seed complete ✓"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}  Setup complete!${NC}"
echo ""
echo "  Start the server:    npm run dev"
echo "  API health check:    curl http://localhost:3000/health"
echo ""
echo "  Test accounts:"
echo "    Super Admin:   admin@parkcontrol.app      / Admin1234!"
echo "    Manager:       manager@oakridge.com       / Manager1234!"
echo "    Resident:      m.gonzalez@email.com       / Resident1234!"
echo "    Enforcement:   k.davis@enforcement.com    / Officer1234!"
echo ""
echo "  View DB in browser:  npx prisma studio"
echo ""
