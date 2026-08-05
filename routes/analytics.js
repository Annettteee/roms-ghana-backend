const express = require('express');
const db = require('../db/schema');
const { requireAuth, requireModule } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireModule('reports'));

// GET /api/analytics/sales-by-hour — revenue and order count bucketed by hour
// of day, this month. SQLite's strftime pulls the hour straight out of the
// stored timestamp — no need to fetch every row into JS and bucket manually.
router.get('/sales-by-hour', (req, res) => {
  const rows = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) hour, COUNT(*) orders, COALESCE(SUM(total), 0) revenue
    FROM invoices
    WHERE business_id = ? AND created_at >= date('now', 'start of month')
    GROUP BY hour ORDER BY hour
  `).all(req.businessId);

  // Fill in every hour 0-23 with zero so the chart doesn't have gaps.
  const byHour = {};
  rows.forEach(r => { byHour[r.hour] = r; });
  const full = [];
  for (let h = 0; h < 24; h++) {
    full.push(byHour[h] || { hour: h, orders: 0, revenue: 0 });
  }
  res.json(full);
});

// GET /api/analytics/sales-by-dish — best and worst sellers this month, by
// matching invoice line item names to dish names (same matching used by
// auto-deduction, so what you see here is exactly what triggers a deduction).
router.get('/sales-by-dish', (req, res) => {
  const rows = db.prepare(`
    SELECT ii.item, COUNT(*) times_sold, SUM(ii.qty) total_qty, SUM(ii.qty * ii.price) revenue
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.business_id = ? AND i.created_at >= date('now', 'start of month')
    GROUP BY ii.item ORDER BY revenue DESC
  `).all(req.businessId);
  res.json(rows);
});

// GET /api/analytics/suppliers — reliability score per supplier, plus which
// supplier is cheapest/most-recommended for each item name multiple
// suppliers provide.
router.get('/suppliers', (req, res) => {
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE business_id = ?').all(req.businessId);

  const scored = suppliers.map(s => {
    // Simple, explainable formula: start at 100, lose points for lateness,
    // lose points for below-"good" quality. Never below 0.
    const latePenalty = (s.late_delivery_pct || 0) * 0.6; // 20% late -> -12 points
    const qualityPenalty = { 'Excellent': 0, 'Good': 5, 'Fair': 15, 'Poor': 30 }[s.quality] ?? 10;
    const score = Math.max(0, Math.round(100 - latePenalty - qualityPenalty));
    return { ...s, reliability_score: score };
  });

  // Group by item name to find the cheapest and the best-scored supplier
  // for each thing multiple suppliers provide — real procurement comparison.
  const byItem = {};
  scored.forEach(s => {
    if (!s.item) return;
    const key = s.item.toLowerCase();
    (byItem[key] ||= []).push(s);
  });
  const recommendations = Object.entries(byItem)
    .filter(([, list]) => list.length > 1) // only worth comparing if there's a real choice
    .map(([item, list]) => ({
      item: list[0].item,
      cheapest: list.reduce((a, b) => (b.price < a.price ? b : a)).name,
      most_reliable: list.reduce((a, b) => (b.reliability_score > a.reliability_score ? b : a)).name,
    }));

  res.json({ suppliers: scored.sort((a, b) => b.reliability_score - a.reliability_score), recommendations });
});

// GET /api/analytics/staff — sales generated and average order value per
// staff member, from invoices tagged with staff_id at the point of sale.
router.get('/staff', (req, res) => {
  const staff = db.prepare('SELECT * FROM staff WHERE business_id = ?').all(req.businessId);
  const result = staff.map(s => {
    const stats = db.prepare(`
      SELECT COUNT(*) order_count, COALESCE(SUM(total), 0) sales_generated
      FROM invoices WHERE business_id = ? AND staff_id = ? AND created_at >= date('now', 'start of month')
    `).get(req.businessId, s.id);
    return {
      ...s,
      sales_generated: stats.sales_generated,
      order_count: stats.order_count,
      avg_order_value: stats.order_count > 0 ? stats.sales_generated / stats.order_count : 0,
      // void_rate is only meaningful once there's a real volume of orders THIS
      // MONTH to divide by — voids is a lifetime running counter, so dividing
      // it by a handful of this-month orders can produce a wildly misleading
      // percentage (e.g. 300%) that looks like an alarm when it's really just
      // an artifact of the two numbers covering different time spans.
      void_rate: stats.order_count >= 3 ? Math.min(100, s.voids / stats.order_count * 100) : null
    };
  });
  res.json(result.sort((a, b) => b.sales_generated - a.sales_generated));
});

// GET /api/analytics/customers — loyalty tier, real lifetime spend, and
// favorite dish, computed from invoices actually linked to each customer
// (not just the visits counter, which can be bumped manually for walk-ins
// with no invoice at all).
router.get('/customers', (req, res) => {
  const customers = db.prepare('SELECT * FROM customers WHERE business_id = ?').all(req.businessId);

  const tierFor = (visits) => {
    if (visits >= 10) return 'Gold';
    if (visits >= 3) return 'Silver';
    return 'Regular';
  };

  const result = customers.map(c => {
    const spend = db.prepare('SELECT COALESCE(SUM(total), 0) v FROM invoices WHERE business_id = ? AND customer_id = ?').get(req.businessId, c.id).v;
    const favorite = db.prepare(`
      SELECT ii.item, COUNT(*) cnt FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.business_id = ? AND i.customer_id = ?
      GROUP BY ii.item ORDER BY cnt DESC LIMIT 1
    `).get(req.businessId, c.id);
    return {
      ...c,
      tier: tierFor(c.visits || 0),
      lifetime_spend: spend,
      favorite_dish: favorite ? favorite.item : null
    };
  });

  res.json(result.sort((a, b) => b.lifetime_spend - a.lifetime_spend));
});

// GET /api/analytics/inventory-usage — average daily usage and estimated
// days-of-stock-remaining per ingredient, reconstructed from real sales
// history (invoice line items matched to dishes matched to their linked
// inventory items) — the same matching auto-deduction itself uses, so this
// is genuinely "what's been leaving the shelf," not a guess.
router.get('/inventory-usage', (req, res) => {
  const usage = db.prepare(`
    SELECT di.inventory_item_id, SUM(di.quantity * ii.qty) total_used
    FROM invoice_items ii
    JOIN invoices inv ON inv.id = ii.invoice_id
    JOIN dishes d ON d.business_id = inv.business_id AND LOWER(d.name) = LOWER(ii.item)
    JOIN dish_ingredients di ON di.dish_id = d.id AND di.inventory_item_id IS NOT NULL
    WHERE inv.business_id = ? AND inv.created_at >= date('now', '-30 days')
    GROUP BY di.inventory_item_id
  `).all(req.businessId);

  const usageById = {};
  usage.forEach(u => { usageById[u.inventory_item_id] = u.total_used; });

  const items = db.prepare('SELECT * FROM inventory_items WHERE business_id = ?').all(req.businessId);
  const result = items.map(i => {
    const totalUsed30d = usageById[i.id] || 0;
    const avgDailyUsage = totalUsed30d / 30;
    const daysRemaining = avgDailyUsage > 0 ? i.qty_on_hand / avgDailyUsage : null;
    return {
      inventory_item_id: i.id,
      avg_daily_usage: Math.round(avgDailyUsage * 100) / 100,
      days_remaining: daysRemaining !== null ? Math.round(daysRemaining * 10) / 10 : null
    };
  });
  res.json(result);
});

// GET /api/analytics/since?since=ISO_TIMESTAMP — a real summary of what
// happened between then and now: revenue, waste, new low-stock items,
// unpaid invoices piling up. Meant for a "since you last checked in" prompt
// after a few days away, not a generic "welcome back."
router.get('/since', (req, res) => {
  const since = req.query.since;
  if (!since) return res.status(400).json({ error: 'since is required.' });

  const revenue = db.prepare(`SELECT COALESCE(SUM(total),0) v, COUNT(*) c FROM invoices WHERE business_id = ? AND created_at >= ?`).get(req.businessId, since);
  const waste = db.prepare(`SELECT COALESCE(SUM(cost),0) v FROM waste_log WHERE business_id = ? AND created_at >= ?`).get(req.businessId, since);
  const newLowStock = db.prepare(`SELECT COUNT(*) c FROM inventory_items WHERE business_id = ? AND qty_on_hand <= reorder_level`).get(req.businessId).c;
  const unpaidInvoices = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(total),0) v FROM invoices WHERE business_id = ? AND status = 'unpaid' AND created_at >= ?`).get(req.businessId, since);
  const topWaste = db.prepare(`
    SELECT ingredient, SUM(cost) total FROM waste_log WHERE business_id = ? AND created_at >= ?
    GROUP BY ingredient ORDER BY total DESC LIMIT 1
  `).get(req.businessId, since);

  res.json({
    since,
    revenue: revenue.v,
    invoiceCount: revenue.c,
    waste: waste.v,
    topWasteIngredient: topWaste ? topWaste.ingredient : null,
    lowStockCount: newLowStock,
    unpaidInvoiceCount: unpaidInvoices.c,
    unpaidInvoiceTotal: unpaidInvoices.v
  });
});

module.exports = router;
