require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { requireAuth, requireModule } = require('./middleware/auth');
const db = require('./db/schema');
const { logActivity } = require('./lib/activityLog');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const dishesRoutes = require('./routes/dishes');
const invoicesRoutes = require('./routes/invoices');
const cashReconciliationRoutes = require('./routes/cashReconciliation');
const purchaseOrdersRoutes = require('./routes/purchaseOrders');
const analyticsRoutes = require('./routes/analytics');
const dashboardRoutes = require('./routes/dashboard');
const importRoutes = require('./routes/import');
const starterKitRoutes = require('./routes/starterKit');
const reportsPdfRoutes = require('./routes/reportsPdf');
const ocrRoutes = require('./routes/ocr');
const aiBriefRoutes = require('./routes/aiBrief');
const paymentsRoutes = require('./routes/payments');
const makeCrudRouter = require('./routes/crudFactory');

const app = express();

// Trust Render/Railway's proxy so rate limiting and `secure` cookies see the real client IP/protocol.
app.set('trust proxy', 1);

// Security headers (X-Content-Type-Options, X-Frame-Options, HSTS in production, etc).
// CSP is left off by default because app.html uses inline <script>/<style> for simplicity —
// see README "Tightening the Content Security Policy" for how to lock that down further.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: only the configured frontend origin may call this API with credentials.
// Same-origin requests (frontend served from this same server) don't need CORS at all —
// this matters once you deploy the frontend somewhere separate from the API.
const allowedOrigin = process.env.ALLOWED_ORIGIN || true; // true = reflect request origin, fine for local dev only
app.use(cors({ origin: allowedOrigin, credentials: true }));

app.use(express.json({
  limit: '200kb', // small limit — this API never needs huge payloads
  verify: (req, res, buf) => { req.rawBody = buf; } // needed to verify the Paystack webhook signature
}));
app.use(cookieParser());

// A gentle global ceiling on top of the tighter limiter already on /api/auth/*,
// so no single client can hammer the API and degrade it for every business on it.
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const inventoryRouter = makeCrudRouter('inventory_items',
  ['name', 'category', 'unit', 'unit_cost', 'qty_on_hand', 'reorder_level', 'shelf_life_days', 'last_restocked', 'branch_id'], 'inventory', 'inventory item');
const suppliersRouter = makeCrudRouter('suppliers',
  ['name', 'item', 'price', 'late_delivery_pct', 'quality', 'notes'], 'inventory', 'supplier');
const customersRouter = makeCrudRouter('customers',
  ['name', 'phone', 'visits', 'birthday', 'notes', 'branch_id'], 'customers', 'customer');
const staffRouter = makeCrudRouter('staff',
  ['name', 'role', 'orders_served', 'sales_per_labor_hr', 'voids', 'branch_id'], 'settings', 'staff member');
const wasteRouter = makeCrudRouter('waste_log',
  ['ingredient', 'quantity', 'cost', 'reason', 'logged_by', 'branch_id'], 'inventory', 'waste log entry');
const branchesRouter = makeCrudRouter('branches', ['name', 'address'], 'settings', 'branch');
const tablesRouter = makeCrudRouter('tables', ['name', 'seats', 'status', 'branch_id'], null, 'table'); // front-of-house — everyone with a login needs this
const waitlistRouter = makeCrudRouter('waitlist', ['name', 'party_size', 'phone', 'quoted_wait_minutes', 'status', 'branch_id'], null, 'waitlist entry');
const temperatureRouter = makeCrudRouter('temperature_checks', ['location', 'temperature_c', 'pass', 'checked_by', 'notes', 'branch_id'], null, 'temperature check');


app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/inventory', inventoryRouter);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/customers', customersRouter);
app.use('/api/staff', staffRouter);
app.use('/api/waste', wasteRouter);
app.use('/api/branches', branchesRouter);
app.use('/api/tables', tablesRouter);
app.use('/api/waitlist', waitlistRouter);
app.use('/api/temperature-checks', temperatureRouter);
app.use('/api/dishes', dishesRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/cash-reconciliation', cashReconciliationRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/import', importRoutes);
app.use('/api/starter-kit', starterKitRoutes);
app.use('/api/reports', reportsPdfRoutes);
app.use('/api/ocr', ocrRoutes);
app.use('/api/ai', aiBriefRoutes);
app.use('/api/payments', paymentsRoutes);

app.put('/api/business', requireAuth, (req, res) => {
  const { name, currency, momo_number, vat_rate, vat_enabled, nhil_rate, nhil_enabled, tourism_levy_rate, tourism_levy_enabled, session_length_days, auto_reorder_enabled } = req.body;
  const existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.businessId);
  if (!existing) return res.status(404).json({ error: 'Business not found.' });

  // Bounded 1-90 days — long enough to be useful, short enough that a
  // forgotten "forever" session isn't quietly sitting on some old device.
  let sessionDays = existing.session_length_days;
  if (session_length_days !== undefined) {
    const n = parseInt(session_length_days);
    if (!Number.isFinite(n) || n < 1 || n > 90) return res.status(400).json({ error: 'Session length must be between 1 and 90 days.' });
    sessionDays = n;
  }

  db.prepare(`
    UPDATE businesses SET name = ?, currency = ?, momo_number = ?,
      vat_rate = ?, vat_enabled = ?, nhil_rate = ?, nhil_enabled = ?, tourism_levy_rate = ?, tourism_levy_enabled = ?, session_length_days = ?, auto_reorder_enabled = ?
    WHERE id = ?
  `).run(
    name ?? existing.name, currency ?? existing.currency, momo_number ?? existing.momo_number,
    vat_rate ?? existing.vat_rate, vat_enabled ?? existing.vat_enabled,
    nhil_rate ?? existing.nhil_rate, nhil_enabled ?? existing.nhil_enabled,
    tourism_levy_rate ?? existing.tourism_levy_rate, tourism_levy_enabled ?? existing.tourism_levy_enabled,
    sessionDays,
    auto_reorder_enabled !== undefined ? (auto_reorder_enabled ? 1 : 0) : existing.auto_reorder_enabled,
    req.businessId
  );
  logActivity(req.businessId, req.userId, 'settings_changed', 'business settings updated', req);
  res.json(db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.businessId));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  let dbOk = true;
  try {
    require('./db/schema').prepare('SELECT 1').get();
  } catch (e) {
    dbOk = false;
  }
  res.json({ ok: true, database: dbOk, time: new Date().toISOString() });
});

// Centralized error handler — never leak stack traces or internal error details to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`ROMS Ghana backend running on http://localhost:${PORT}`));
