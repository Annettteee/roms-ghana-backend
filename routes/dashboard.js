const express = require('express');
const db = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { generateNarrativeInsights } = require('../lib/narrativeInsights');

const router = express.Router();
router.use(requireAuth);

// GET /api/dashboard — every number is computed live from this business's own
// tables. A brand new signup has no rows anywhere, so every figure below is
// genuinely 0 / empty until the owner starts entering real data.
router.get('/', (req, res) => {
  const bId = req.businessId;

  const inventoryCount = db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE business_id = ?').get(bId).c;
  const lowStock = db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE business_id = ? AND qty_on_hand <= reorder_level').get(bId).c;

  const wasteThisMonth = db.prepare(`
    SELECT COALESCE(SUM(cost),0) total FROM waste_log
    WHERE business_id = ? AND created_at >= date('now','start of month')
  `).get(bId).total;

  const topWasteIngredient = db.prepare(`
    SELECT ingredient, SUM(cost) total FROM waste_log
    WHERE business_id = ? AND created_at >= date('now','start of month')
    GROUP BY ingredient ORDER BY total DESC LIMIT 1
  `).get(bId);

  const invoiceTotals = db.prepare(`
    SELECT COALESCE(SUM(total),0) revenue, COALESCE(SUM(tip_amount),0) tips FROM invoices
    WHERE business_id = ? AND created_at >= date('now','start of month')
  `).get(bId);

  const dishCount = db.prepare('SELECT COUNT(*) c FROM dishes WHERE business_id = ?').get(bId).c;
  const customerCount = db.prepare('SELECT COUNT(*) c FROM customers WHERE business_id = ?').get(bId).c;
  const staffCount = db.prepare('SELECT COUNT(*) c FROM staff WHERE business_id = ?').get(bId).c;

  res.json({
    inventoryCount,
    lowStock,
    wasteThisMonth,
    topWasteIngredient: topWasteIngredient ? topWasteIngredient.ingredient : null,
    revenueThisMonth: invoiceTotals.revenue,
    tipsThisMonth: invoiceTotals.tips,
    dishCount,
    customerCount,
    staffCount,
    isEmpty: inventoryCount === 0 && dishCount === 0 && customerCount === 0
  });
});

// GET /api/dashboard/charts — real data shaped for charting: a 7-day revenue
// trend, waste by ingredient, and top-ordered items by quantity. Every array
// can be empty for a new business — the frontend shows an empty state rather
// than a broken chart in that case.
router.get('/charts', (req, res) => {
  const bId = req.businessId;

  const dailyRevenue = db.prepare(`
    SELECT date(created_at) as day, COALESCE(SUM(total),0) as revenue
    FROM invoices WHERE business_id = ? AND created_at >= date('now','-6 days')
    GROUP BY date(created_at) ORDER BY day ASC
  `).all(bId);

  const wasteByIngredient = db.prepare(`
    SELECT ingredient, SUM(cost) as total FROM waste_log
    WHERE business_id = ? AND created_at >= date('now','start of month')
    GROUP BY ingredient ORDER BY total DESC LIMIT 6
  `).all(bId);

  const topItems = db.prepare(`
    SELECT ii.item, SUM(ii.qty) as qty FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.business_id = ? GROUP BY ii.item ORDER BY qty DESC LIMIT 6
  `).all(bId);

  res.json({ dailyRevenue, wasteByIngredient, topItems });
});

// GET /api/dashboard/health-score — the 7-category breakdown (Inventory, Waste,
// Suppliers, Pricing, Customer Loyalty, Staff, Profitability), each 0-100,
// computed from real data with a simple, explainable formula per category —
// not a black box. A brand-new business gets a neutral score (50) on
// categories with no data yet rather than a misleading 0 or 100.
router.get('/health-score', (req, res) => {
  const bId = req.businessId;
  const NEUTRAL = 50;

  // Inventory: rewards having stock tracked and not much of it below reorder level
  const invTotal = db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE business_id = ?').get(bId).c;
  const invLow = db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE business_id = ? AND qty_on_hand <= reorder_level').get(bId).c;
  const inventoryScore = invTotal === 0 ? NEUTRAL : Math.round(100 - (invLow / invTotal) * 100);

  // Waste: rewards low waste relative to revenue this month
  const revenue = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE business_id = ? AND created_at >= date('now','start of month')`).get(bId).v;
  const waste = db.prepare(`SELECT COALESCE(SUM(cost),0) v FROM waste_log WHERE business_id = ? AND created_at >= date('now','start of month')`).get(bId).v;
  const wasteScore = revenue === 0 ? NEUTRAL : Math.max(0, Math.round(100 - (waste / revenue) * 100 * 5)); // waste >20% of revenue -> 0

  // Suppliers: rewards low average late-delivery rate
  const suppliers = db.prepare('SELECT late_delivery_pct FROM suppliers WHERE business_id = ?').all(bId);
  const supplierScore = suppliers.length === 0 ? NEUTRAL : Math.round(100 - (suppliers.reduce((s, x) => s + (x.late_delivery_pct || 0), 0) / suppliers.length));

  // Pricing: rewards dishes sitting at or above their own target margin
  const dishes = db.prepare('SELECT id, selling_price, target_margin FROM dishes WHERE business_id = ?').all(bId);
  let pricingScore = NEUTRAL;
  if (dishes.length) {
    const onTarget = dishes.filter(d => {
      const cost = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM dish_ingredients WHERE dish_id = ?').get(d.id).c;
      const margin = d.selling_price > 0 ? ((d.selling_price - cost) / d.selling_price) * 100 : 0;
      return margin >= (d.target_margin || 40);
    }).length;
    pricingScore = Math.round((onTarget / dishes.length) * 100);
  }

  // Customer loyalty: rewards a healthy repeat-visit rate
  const customers = db.prepare('SELECT visits FROM customers WHERE business_id = ?').all(bId);
  const loyaltyScore = customers.length === 0 ? NEUTRAL : Math.round(Math.min(100, (customers.filter(c => (c.visits || 0) >= 2).length / customers.length) * 100 + 20));

  // Staff: rewards low void rate relative to orders served
  const staff = db.prepare('SELECT orders_served, voids FROM staff WHERE business_id = ?').all(bId);
  const totalOrders = staff.reduce((s, x) => s + (x.orders_served || 0), 0);
  const totalVoids = staff.reduce((s, x) => s + (x.voids || 0), 0);
  const staffScore = staff.length === 0 ? NEUTRAL : (totalOrders === 0 ? NEUTRAL : Math.max(0, Math.round(100 - (totalVoids / totalOrders) * 300)));

  // Profitability: rewards healthy overall margin this month across invoiced items vs recorded dish costs
  const profitabilityScore = revenue === 0 ? NEUTRAL : Math.min(100, Math.round(pricingScore * 0.6 + (revenue > waste * 5 ? 40 : 20)));

  const categories = {
    inventory: inventoryScore, waste: wasteScore, suppliers: supplierScore,
    pricing: pricingScore, customer_loyalty: loyaltyScore, staff: staffScore, profitability: profitabilityScore
  };
  const overall = Math.round(Object.values(categories).reduce((a, b) => a + b, 0) / Object.keys(categories).length);

  res.json({ overall, categories });
});

// GET /api/dashboard/by-branch — chain roll-up: same numbers as above, one row
// per branch, plus an "Unassigned" row for anything not tagged to a branch yet.
// This is what makes the platform actually fit a multi-branch chain rather than
// just a single restaurant.
router.get('/by-branch', (req, res) => {
  const bId = req.businessId;
  const branches = db.prepare('SELECT * FROM branches WHERE business_id = ?').all(bId);
  const rows = [...branches, { id: null, name: 'Unassigned / not yet set' }].map(branch => {
    const branchFilter = branch.id === null ? 'IS NULL' : '= ' + branch.id;
    const revenue = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE business_id = ? AND branch_id ${branchFilter}`).get(bId).v;
    const waste = db.prepare(`SELECT COALESCE(SUM(cost),0) v FROM waste_log WHERE business_id = ? AND branch_id ${branchFilter}`).get(bId).v;
    const inventoryCount = db.prepare(`SELECT COUNT(*) c FROM inventory_items WHERE business_id = ? AND branch_id ${branchFilter}`).get(bId).c;
    const dishCount = db.prepare(`SELECT COUNT(*) c FROM dishes WHERE business_id = ? AND branch_id ${branchFilter}`).get(bId).c;
    return { branch_id: branch.id, branch_name: branch.name, revenue, waste, inventoryCount, dishCount };
  }).filter(r => r.branch_id !== null || r.revenue > 0 || r.inventoryCount > 0 || r.dishCount > 0); // hide the empty "Unassigned" row for chains that always tag a branch
  res.json(rows);
});

// GET /api/dashboard/insights — the "consulting report" narrative recommendations
router.get('/insights', (req, res) => {
  res.json(generateNarrativeInsights(req.businessId));
});

module.exports = router;
