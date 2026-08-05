const Database = require('better-sqlite3');
const path = require('path');

// In production, DATABASE_PATH points at a Render persistent disk mounted
// OUTSIDE this code directory (e.g. /var/data/roms.sqlite) — mounting a disk
// directly at this folder's own path (db/) would silently replace this very
// file with the disk's empty contents at container start, which is exactly
// what caused a real "Cannot find module './db/schema'" crash earlier. Local
// development with no DATABASE_PATH set falls back to a file right here, same
// as always.
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'roms.sqlite');

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─────────────────────────────────────────────────────────
// Every table carries business_id. Every query in every route
// filters by it. That single rule is what gives each company
// its own isolated, empty-by-default workspace.
// ─────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  currency TEXT DEFAULT 'GHS',
  plan TEXT DEFAULT 'trial',
  subscription_status TEXT DEFAULT 'trial',   -- trial | active | overdue | cancelled
  approval_status TEXT DEFAULT 'pending',      -- pending | approved | rejected
  business_type TEXT,
  branch_count INTEGER,
  phone_number TEXT,
  session_length_days INTEGER DEFAULT 7,       -- how long a login stays valid before needing to sign in again
  auto_reorder_enabled INTEGER DEFAULT 0,      -- opt-in only: auto-places a PO (status 'sent') for low-stock items with a matching supplier, no human review step
  renewal_warning_sent_at TEXT,                -- last time we emailed this business about an upcoming lapse, so we don't re-send every time the check runs
  subscription_note TEXT,                      -- e.g. "Paid via MoMo, GHS 100, 12 Aug"
  paid_through TEXT,                            -- date the current payment covers them until
  vat_rate REAL DEFAULT 15,
  vat_enabled INTEGER DEFAULT 1,
  nhil_rate REAL DEFAULT 2.5,
  nhil_enabled INTEGER DEFAULT 1,
  tourism_levy_rate REAL DEFAULT 1,
  tourism_levy_enabled INTEGER DEFAULT 0,
  momo_number TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'owner',           -- owner | manager | staff
  branch TEXT DEFAULT 'Main Branch',
  twofa_secret TEXT,
  twofa_enabled INTEGER DEFAULT 0,
  permissions TEXT,             -- JSON array of module keys this user can access, e.g. '["inventory","reports"]'; null/owner = full access
  can_delete TEXT,               -- JSON array of module keys this user may ALSO delete from (requires having that module in permissions too); null = no delete rights beyond what role implies
  theme TEXT DEFAULT 'light',   -- light | dark
  font_size TEXT DEFAULT 'normal', -- normal | large | xlarge — for low-vision accessibility
  email_verified INTEGER DEFAULT 0,
  verification_code TEXT,
  reset_token TEXT,
  reset_token_expires TEXT,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  import_batch_id INTEGER,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT DEFAULT 'kg',
  unit_cost REAL DEFAULT 0,
  qty_on_hand REAL DEFAULT 0,
  reorder_level REAL DEFAULT 0,
  shelf_life_days INTEGER,
  last_restocked TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  import_batch_id INTEGER,
  name TEXT NOT NULL,
  serves INTEGER DEFAULT 1,
  selling_price REAL DEFAULT 0,
  target_margin REAL DEFAULT 40,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dish_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  label TEXT NOT NULL,          -- e.g. "250g rice" — free-text display
  quantity REAL DEFAULT 0,      -- real number, in the linked inventory item's own unit — this is what auto-deduction actually subtracts
  cost REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS waste_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  ingredient TEXT NOT NULL,
  quantity TEXT,
  cost REAL DEFAULT 0,
  reason TEXT,
  logged_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  item TEXT,
  price REAL DEFAULT 0,
  late_delivery_pct REAL DEFAULT 0,
  quality TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  import_batch_id INTEGER,
  name TEXT NOT NULL,
  phone TEXT,
  visits INTEGER DEFAULT 0,
  birthday TEXT,
  notes TEXT,
  last_visit_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  customer_name TEXT,
  subtotal REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0.219,
  tax REAL DEFAULT 0,
  tax_breakdown TEXT,            -- JSON: [{label, rate, amount}] so an invoice shows VAT/NHIL/Tourism Levy separately
  tip_amount REAL DEFAULT 0,
  total REAL DEFAULT 0,
  status TEXT DEFAULT 'unpaid',
  payment_method TEXT DEFAULT 'cash',   -- cash | momo | card | pos | credit — drives cash reconciliation's "expected" totals
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,  -- who served this sale, for staff performance metrics
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,  -- links to a real customer record, enabling lifetime spend/favorite dish/auto visit-tracking
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  qty REAL DEFAULT 1,
  price REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  role TEXT,
  orders_served INTEGER DEFAULT 0,
  sales_per_labor_hr REAL DEFAULT 0,
  voids INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INTEGER,
  event TEXT NOT NULL,          -- e.g. 'login', 'login_failed', '2fa_enabled', 'settings_changed', 'teammate_invited'
  detail TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  name TEXT NOT NULL,             -- e.g. "Table 4", "Patio 2"
  seats INTEGER DEFAULT 2,
  status TEXT DEFAULT 'available' -- available | occupied | reserved | cleaning
);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  party_size INTEGER DEFAULT 1,
  phone TEXT,
  quoted_wait_minutes INTEGER,
  status TEXT DEFAULT 'waiting',  -- waiting | seated | left
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS temperature_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  location TEXT NOT NULL,        -- e.g. "Walk-in fridge", "Chest freezer", "Grill line"
  temperature_c REAL,
  pass INTEGER DEFAULT 1,        -- 1 = within safe range, 0 = flagged
  checked_by TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_name TEXT NOT NULL,          -- since the admin key is shared, this is what actually identifies WHO did something
  action TEXT NOT NULL,
  detail TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,   -- the jti embedded in the JWT — how we tie a specific token to a specific row
  device_info TEXT,                  -- a short readable summary parsed from the user-agent, e.g. "Chrome on Windows"
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now')),
  revoked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cash_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  reconciliation_date TEXT NOT NULL,     -- the business day this covers, e.g. '2026-08-04'
  cash_expected REAL DEFAULT 0,          -- auto-computed from that day's cash-marked invoices at the time of counting
  cash_actual REAL DEFAULT 0,            -- manually counted
  momo_expected REAL DEFAULT 0,
  momo_actual REAL DEFAULT 0,
  pos_expected REAL DEFAULT 0,
  pos_actual REAL DEFAULT 0,
  notes TEXT,
  counted_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'draft',           -- draft | sent | received | cancelled
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  received_at TEXT
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,               -- kept even if the inventory item is later deleted, so old POs still read correctly
  quantity REAL DEFAULT 0,
  unit_cost REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  target_table TEXT NOT NULL,   -- 'inventory_items' | 'customers' | 'dishes'
  filename TEXT,
  imported_count INTEGER DEFAULT 0,
  skipped_duplicate_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ─────────────────────────────────────────────────────────
// Migration safety net. `CREATE TABLE IF NOT EXISTS` above only creates a
// table the FIRST time it's ever seen — if a table already exists (because
// you're running this against a database from an older version of this
// project), new columns added since then do NOT get added automatically.
// Without this, upgrading the code while keeping the same database file
// would crash the first time anything touched a new column, something
// businesses running this in production absolutely will do. This checks
// every table's actual columns against what the code expects and adds any
// that are missing, with a safe default — existing rows just get that
// default value for the new column, nothing existing is touched or lost.
// ─────────────────────────────────────────────────────────
const REQUIRED_COLUMNS = {
  businesses: [
    ['subscription_status', "TEXT DEFAULT 'trial'"],
    ['approval_status', "TEXT DEFAULT 'approved'"],
    ['business_type', 'TEXT'],
    ['branch_count', 'INTEGER'],
    ['phone_number', 'TEXT'],
    ['session_length_days', 'INTEGER DEFAULT 7'],
    ['auto_reorder_enabled', 'INTEGER DEFAULT 0'],
    ['renewal_warning_sent_at', 'TEXT'],
    ['subscription_note', 'TEXT'],
    ['paid_through', 'TEXT'],
    ['vat_rate', 'REAL DEFAULT 15'],
    ['vat_enabled', 'INTEGER DEFAULT 1'],
    ['nhil_rate', 'REAL DEFAULT 2.5'],
    ['nhil_enabled', 'INTEGER DEFAULT 1'],
    ['tourism_levy_rate', 'REAL DEFAULT 1'],
    ['tourism_levy_enabled', 'INTEGER DEFAULT 0'],
  ],
  users: [
    ['twofa_secret', 'TEXT'],
    ['twofa_enabled', 'INTEGER DEFAULT 0'],
    ['permissions', 'TEXT'],
    ['can_delete', 'TEXT'],
    ['theme', "TEXT DEFAULT 'light'"],
    ['font_size', "TEXT DEFAULT 'normal'"],
    ['email_verified', 'INTEGER DEFAULT 0'],
    ['verification_code', 'TEXT'],
    ['reset_token', 'TEXT'],
    ['reset_token_expires', 'TEXT'],
    ['last_login_at', 'TEXT'],
  ],
  inventory_items: [['branch_id', 'INTEGER'], ['import_batch_id', 'INTEGER']],
  dish_ingredients: [['quantity', 'REAL DEFAULT 0']],
  dishes: [['branch_id', 'INTEGER'], ['import_batch_id', 'INTEGER']],
  customers: [['branch_id', 'INTEGER'], ['import_batch_id', 'INTEGER'], ['last_visit_at', 'TEXT']],
  staff: [['branch_id', 'INTEGER']],
  waste_log: [['branch_id', 'INTEGER']],
  invoices: [['branch_id', 'INTEGER'], ['tip_amount', 'REAL DEFAULT 0'], ['tax_breakdown', 'TEXT'], ['payment_method', "TEXT DEFAULT 'cash'"], ['staff_id', 'INTEGER'], ['customer_id', 'INTEGER']],
};

for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
  if (!tableExists) continue; // brand-new install — CREATE TABLE above already includes every column
  const existingCols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [colName, colDef] of columns) {
    if (!existingCols.has(colName)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
      console.log(`[migration] Added missing column ${table}.${colName}`);
    }
  }
}

module.exports = db;
