require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { errorHandler } = require('./middleware/errorHandler');
const { logger } = require('./utils/logger');

// Routes
const authRoutes = require('./routes/auth');
const propertiesRoutes = require('./routes/properties');
const unitsRoutes = require('./routes/units');
const usersRoutes = require('./routes/users');
const vehiclesRoutes = require('./routes/vehicles');
const passesRoutes = require('./routes/passes');
const visitorLinksRoutes = require('./routes/visitorLinks');
const enforcementRoutes = require('./routes/enforcement');
const auditRoutes = require('./routes/audit');
const rulesRoutes = require('./routes/rules');

const app = express();

// ─── Security & Parsing ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // strict on login/register
  message: { error: 'Too many auth attempts, please try again later.' },
});

app.use(globalLimiter);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',          authLimiter, authRoutes);
app.use('/api/properties',    propertiesRoutes);
app.use('/api/units',         unitsRoutes);
app.use('/api/users',         usersRoutes);
app.use('/api/vehicles',      vehiclesRoutes);
app.use('/api/passes',        passesRoutes);
app.use('/api/visitor-links', visitorLinksRoutes);
app.use('/api/enforcement',   enforcementRoutes);
app.use('/api/audit',         auditRoutes);
app.use('/api/rules',         rulesRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`ParkControl API running on port ${PORT} [${process.env.NODE_ENV}]`);
});

module.exports = app;
