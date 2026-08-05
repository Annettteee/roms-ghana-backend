const db = require('../db/schema');

// Generates specific, actionable narrative recommendations from a business's
// real data — the "consulting report" style, not a bare numbers dump. Every
// line here is computed from something real; nothing is templated filler.
// Returns an array of { type: 'good'|'warning'|'critical', text } so callers
// (the PDF and the on-screen version) can style each line appropriately.
function generateNarrativeInsights(businessId) {
  const insights = [];
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  const cur = business.currency || 'GHS';

  // --- Waste: biggest single ingredient this month, with a concrete ask ---
  const topWaste = db.prepare(`
    SELECT ingredient, SUM(cost) total FROM waste_log
    WHERE business_id = ? AND created_at >= date('now','start of month')
    GROUP BY ingredient ORDER BY total DESC LIMIT 1
  `).get(businessId);
  if (topWaste && topWaste.total > 0) {
    const totalWaste = db.prepare(`SELECT COALESCE(SUM(cost),0) v FROM waste_log WHERE business_id = ? AND created_at >= date('now','start of month')`).get(businessId).v;
    const pctOfWaste = totalWaste > 0 ? Math.round((topWaste.total / totalWaste) * 100) : 0;
    insights.push({
      type: topWaste.total > 100 ? 'critical' : 'warning',
      text: `${topWaste.ingredient} is your single biggest source of waste this month (${cur} ${topWaste.total.toFixed(2)}, ${pctOfWaste}% of all waste). Consider ordering smaller, more frequent batches instead of buying in bulk.`
    });
  }

  // --- Dish margins: most and least profitable ---
  const dishes = db.prepare('SELECT * FROM dishes WHERE business_id = ?').all(businessId).map(d => {
    const cost = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM dish_ingredients WHERE dish_id = ?').get(d.id).c;
    const margin = d.selling_price > 0 ? ((d.selling_price - cost) / d.selling_price) * 100 : 0;
    return { ...d, cost, margin };
  }).filter(d => d.selling_price > 0);

  if (dishes.length >= 2) {
    const best = dishes.reduce((a, b) => (b.margin > a.margin ? b : a));
    const worst = dishes.reduce((a, b) => (b.margin < a.margin ? b : a));
    if (worst.margin < 20) {
      const recommendedPrice = worst.target_margin < 100 ? worst.cost / (1 - worst.target_margin / 100) : worst.cost;
      insights.push({
        type: 'critical',
        text: `${worst.name} is running at only ${worst.margin.toFixed(0)}% margin — among the lowest of anything on your menu. Raising it to ${cur} ${recommendedPrice.toFixed(2)} would bring it in line with your ${worst.target_margin}% target.`
      });
    }
    insights.push({
      type: 'good',
      text: `${best.name} is your most profitable dish at ${best.margin.toFixed(0)}% margin — worth featuring or upselling more, since every extra plate sold here is disproportionately good for your bottom line.`
    });
  }

  // --- Supplier reliability: flag anything genuinely unreliable ---
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE business_id = ?').all(businessId);
  const unreliable = suppliers.filter(s => (s.late_delivery_pct || 0) >= 20);
  if (unreliable.length) {
    const worst = unreliable.reduce((a, b) => (b.late_delivery_pct > a.late_delivery_pct ? b : a));
    insights.push({
      type: 'warning',
      text: `${worst.name} is late ${worst.late_delivery_pct}% of the time. If another supplier offers ${worst.item || 'the same item'} more reliably, even at a slightly higher price, it may be worth the switch — a late delivery costs more in disruption than a small price gap.`
    });
  }

  // --- Low stock: how many, most urgent ---
  const lowStock = db.prepare('SELECT * FROM inventory_items WHERE business_id = ? AND qty_on_hand <= reorder_level').all(businessId);
  if (lowStock.length) {
    insights.push({
      type: lowStock.length > 5 ? 'critical' : 'warning',
      text: `${lowStock.length} item${lowStock.length > 1 ? 's are' : ' is'} at or below reorder level right now, including ${lowStock.slice(0, 3).map(i => i.name).join(', ')}. Check Cash & Purchasing — there may already be a reorder suggestion waiting.`
    });
  }

  // --- Revenue trend: this month vs last month ---
  const thisMonth = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE business_id = ? AND created_at >= date('now','start of month')`).get(businessId).v;
  const lastMonth = db.prepare(`
    SELECT COALESCE(SUM(total),0) v FROM invoices
    WHERE business_id = ? AND created_at >= date('now','start of month','-1 month') AND created_at < date('now','start of month')
  `).get(businessId).v;
  if (lastMonth > 0) {
    const pctChange = Math.round(((thisMonth - lastMonth) / lastMonth) * 100);
    if (Math.abs(pctChange) >= 5) {
      insights.push({
        type: pctChange > 0 ? 'good' : 'warning',
        text: `Revenue is ${pctChange > 0 ? 'up' : 'down'} ${Math.abs(pctChange)}% versus last month (${cur} ${thisMonth.toFixed(2)} vs ${cur} ${lastMonth.toFixed(2)}).`
      });
    }
  }

  if (!insights.length) {
    insights.push({ type: 'good', text: 'Not enough activity yet to generate specific recommendations — add a few more invoices, dishes, and waste entries and this section will fill in with real, specific advice.' });
  }

  return insights;
}

module.exports = { generateNarrativeInsights };
