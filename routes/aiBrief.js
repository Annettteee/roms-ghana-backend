const express = require('express');
const db = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/ai/daily-brief — the "AI Business Coach" idea: a short, specific,
// plain-English paragraph generated from this business's own real numbers —
// not a canned template. Requires ANTHROPIC_API_KEY to be set; without one,
// this returns a clear message rather than pretending to work.
router.get('/daily-brief', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'The Daily Business Coach needs an Anthropic API key set as ANTHROPIC_API_KEY in .env — see README "Setting up the Daily Business Coach".'
    });
  }

  const bId = req.businessId;
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(bId);

  const revenue = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE business_id = ? AND created_at >= date('now','-1 day')`).get(bId).v;
  const revenueMonth = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE business_id = ? AND created_at >= date('now','start of month')`).get(bId).v;
  const waste = db.prepare(`SELECT COALESCE(SUM(cost),0) v FROM waste_log WHERE business_id = ? AND created_at >= date('now','-1 day')`).get(bId).v;
  const topWaste = db.prepare(`
    SELECT ingredient, SUM(cost) total FROM waste_log WHERE business_id = ? AND created_at >= date('now','start of month')
    GROUP BY ingredient ORDER BY total DESC LIMIT 1
  `).get(bId);
  const dishes = db.prepare('SELECT * FROM dishes WHERE business_id = ?').all(bId).map(d => {
    const cost = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM dish_ingredients WHERE dish_id = ?').get(d.id).c;
    const margin = d.selling_price > 0 ? ((d.selling_price - cost) / d.selling_price) * 100 : 0;
    return { name: d.name, margin: Math.round(margin) };
  });
  const worstMarginDish = dishes.sort((a, b) => a.margin - b.margin)[0];
  const lowStock = db.prepare('SELECT name FROM inventory_items WHERE business_id = ? AND qty_on_hand <= reorder_level LIMIT 3').all(bId).map(i => i.name);
  const expiring = db.prepare(`SELECT name, shelf_life_days FROM inventory_items WHERE business_id = ? AND shelf_life_days IS NOT NULL AND shelf_life_days <= 2`).all(bId).map(i => i.name);

  // If there's genuinely nothing to talk about yet, don't waste an API call —
  // and don't have the AI invent activity that didn't happen.
  const hasAnyData = revenueMonth > 0 || dishes.length > 0 || lowStock.length > 0;
  if (!hasAnyData) {
    return res.json({ brief: `Welcome to ${business.name}. Once you've logged a few dishes, some inventory, and a sale or two, this brief will start giving you specific, daily advice based on your real numbers.` });
  }

  const dataSummary = `
Business: ${business.name} (currency: ${business.currency || 'GHS'})
Revenue last 24h: ${revenue.toFixed(2)}
Revenue this month so far: ${revenueMonth.toFixed(2)}
Waste last 24h: ${waste.toFixed(2)}
Top waste ingredient this month: ${topWaste ? topWaste.ingredient + ' (' + topWaste.total.toFixed(2) + ')' : 'none logged'}
Lowest-margin dish: ${worstMarginDish ? worstMarginDish.name + ' at ' + worstMarginDish.margin + '% margin' : 'no dishes costed yet'}
Items at/below reorder level: ${lowStock.length ? lowStock.join(', ') : 'none'}
Items expiring within 2 days: ${expiring.length ? expiring.join(', ') : 'none'}
`.trim();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are a plain-spoken restaurant operations coach. Based ONLY on the real data below, write one short paragraph (3-5 sentences, no headers, no bullet points) of specific, actionable advice for the owner this morning. Reference the actual numbers given. Do not invent any figures not in this data. If a figure is "none", don't dwell on it.\n\n${dataSummary}`
        }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      return res.status(502).json({ error: 'The AI service did not respond successfully.', detail: errBody });
    }

    const data = await response.json();
    const brief = data.content.find(b => b.type === 'text')?.text || 'No brief generated.';
    res.json({ brief });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the AI service.', detail: err.message });
  }
});

// GET /api/ai/menu-suggestions — beyond a single margin alert, an actual
// review of the whole menu: what to promote, what to reprice, what to
// consider dropping — based on real sales volume AND margin together,
// since a dish can look fine on margin alone while barely selling, or sell
// well while quietly losing money on every plate.
router.get('/menu-suggestions', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'Menu suggestions need an Anthropic API key set as ANTHROPIC_API_KEY in .env — see README "Setting up the Daily Business Coach".'
    });
  }

  const bId = req.businessId;
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(bId);

  const dishes = db.prepare('SELECT * FROM dishes WHERE business_id = ?').all(bId).map(d => {
    const cost = db.prepare('SELECT COALESCE(SUM(cost),0) c FROM dish_ingredients WHERE dish_id = ?').get(d.id).c;
    const margin = d.selling_price > 0 ? ((d.selling_price - cost) / d.selling_price) * 100 : 0;
    return { name: d.name, sellingPrice: d.selling_price, cost, margin: Math.round(margin * 10) / 10 };
  });

  const salesByDish = db.prepare(`
    SELECT ii.item, SUM(ii.qty) total_qty, SUM(ii.qty * ii.price) revenue
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.business_id = ? AND i.created_at >= date('now','start of month')
    GROUP BY ii.item ORDER BY revenue DESC
  `).all(bId);
  const salesByName = {};
  salesByDish.forEach(s => { salesByName[s.item.toLowerCase()] = s; });

  const combined = dishes.map(d => ({
    ...d,
    unitsSoldThisMonth: salesByName[d.name.toLowerCase()]?.total_qty || 0,
    revenueThisMonth: salesByName[d.name.toLowerCase()]?.revenue || 0
  }));

  if (combined.length === 0) {
    return res.json({ suggestions: `No dishes costed yet for ${business.name}. Add a few dishes with ingredients in Menu & Dish Costs first, then this will have something real to look at.` });
  }

  const dataSummary = combined.map(d =>
    `${d.name}: margin ${d.margin}%, sold ${d.unitsSoldThisMonth} this month, revenue GH${d.revenueThisMonth.toFixed(2)}`
  ).join('\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `You are a restaurant menu consultant. Based ONLY on the real data below (dish name, current margin %, units sold this month, revenue this month), give the owner 3-5 short, specific, actionable bullet points about their menu: which dishes to actively promote (high margin AND good volume), which to reprice (good volume but weak margin — suggest roughly how much to raise the price), and which to consider dropping (low volume AND weak margin). Do not invent numbers not given. Plain text bullet points starting with "-", no headers, no markdown formatting beyond the dashes.\n\n${dataSummary}`
        }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      return res.status(502).json({ error: 'The AI service did not respond successfully.', detail: errBody });
    }

    const data = await response.json();
    const suggestions = data.content.find(b => b.type === 'text')?.text || 'No suggestions generated.';
    res.json({ suggestions, dishData: combined });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the AI service.', detail: err.message });
  }
});

// The ONLY report types a natural-language query can ever select — this is
// the actual safety boundary. The AI's job is narrow: read a sentence and
// pick one of these plus a time period. It never writes or touches SQL
// itself; every one of these runs through our own fixed, parameterized
// query, exactly like the buttons elsewhere in the app already do. Whatever
// the AI outputs gets validated against this exact list before anything
// runs — if it says anything else, the request is rejected, not guessed at.
const REPORT_TYPES = ['revenue', 'waste', 'sales_by_dish', 'staff_performance', 'cash_reconciliation'];
const PERIODS = ['today', 'this_week', 'this_month', 'last_month'];

function periodToDates(period) {
  switch (period) {
    case 'today': return "date('now')";
    case 'this_week': return "date('now', 'weekday 0', '-7 days')";
    case 'last_month': return "date('now', 'start of month', '-1 month')";
    case 'this_month':
    default: return "date('now', 'start of month')";
  }
}

function runReport(businessId, reportType, period) {
  const since = periodToDates(period);
  switch (reportType) {
    case 'revenue': {
      const rows = db.prepare(`SELECT date(created_at) day, COALESCE(SUM(total),0) revenue FROM invoices WHERE business_id = ? AND created_at >= ${since} GROUP BY day ORDER BY day`).all(businessId);
      return { columns: ['Day', 'Revenue'], rows: rows.map(r => [r.day, r.revenue.toFixed(2)]) };
    }
    case 'waste': {
      const rows = db.prepare(`SELECT ingredient, SUM(cost) total FROM waste_log WHERE business_id = ? AND created_at >= ${since} GROUP BY ingredient ORDER BY total DESC`).all(businessId);
      return { columns: ['Ingredient', 'Waste cost'], rows: rows.map(r => [r.ingredient, r.total.toFixed(2)]) };
    }
    case 'sales_by_dish': {
      const rows = db.prepare(`
        SELECT ii.item, SUM(ii.qty) qty, SUM(ii.qty * ii.price) revenue
        FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.business_id = ? AND i.created_at >= ${since} GROUP BY ii.item ORDER BY revenue DESC
      `).all(businessId);
      return { columns: ['Dish', 'Quantity sold', 'Revenue'], rows: rows.map(r => [r.item, r.qty, r.revenue.toFixed(2)]) };
    }
    case 'staff_performance': {
      const rows = db.prepare(`
        SELECT s.name, COUNT(i.id) orders, COALESCE(SUM(i.total),0) sales
        FROM staff s LEFT JOIN invoices i ON i.staff_id = s.id AND i.created_at >= ${since}
        WHERE s.business_id = ? GROUP BY s.id ORDER BY sales DESC
      `).all(businessId);
      return { columns: ['Staff', 'Orders', 'Sales generated'], rows: rows.map(r => [r.name, r.orders, r.sales.toFixed(2)]) };
    }
    case 'cash_reconciliation': {
      const rows = db.prepare(`SELECT reconciliation_date, cash_expected, cash_actual, momo_expected, momo_actual FROM cash_reconciliations WHERE business_id = ? AND reconciliation_date >= ${since} ORDER BY reconciliation_date`).all(businessId);
      return { columns: ['Date', 'Cash expected', 'Cash actual', 'MoMo expected', 'MoMo actual'], rows: rows.map(r => [r.reconciliation_date, r.cash_expected, r.cash_actual, r.momo_expected, r.momo_actual]) };
    }
  }
}

// POST /api/ai/report-query { query: "show me last month's waste" }
// Two-step, deliberately: (1) the AI classifies the sentence into one of a
// FIXED set of report types + a period — nothing else, no SQL, no free text
// that touches the database; (2) we validate that classification ourselves
// before running anything. If the AI ever returns something outside the
// allowed lists, the request is rejected rather than trusted.
router.post('/report-query', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Natural-language reports need an Anthropic API key set as ANTHROPIC_API_KEY in .env.' });
  }
  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.length > 300) {
    return res.status(400).json({ error: 'Enter a short question, e.g. "show me last month\'s waste by ingredient".' });
  }

  let classification;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Classify this restaurant-owner request into exactly one report_type and one period. Respond with ONLY a JSON object, nothing else, no markdown fences.\nAllowed report_type values: ${REPORT_TYPES.join(', ')}\nAllowed period values: ${PERIODS.join(', ')}\nRequest: "${query}"\nJSON:`
        }]
      })
    });
    if (!response.ok) return res.status(502).json({ error: 'The AI service did not respond successfully.' });
    const data = await response.json();
    const text = data.content.find(b => b.type === 'text')?.text || '{}';
    classification = JSON.parse(text.trim());
  } catch (err) {
    return res.status(502).json({ error: 'Could not interpret that request.', detail: err.message });
  }

  // The actual safety check — never trust the AI's output blindly, even
  // though we asked it to only pick from these lists.
  if (!REPORT_TYPES.includes(classification.report_type) || !PERIODS.includes(classification.period)) {
    return res.status(422).json({ error: "Couldn't match that to a report I know how to run. Try mentioning revenue, waste, dish sales, staff performance, or cash reconciliation, and a time period like this month or last month." });
  }

  const result = runReport(req.businessId, classification.report_type, classification.period);
  res.json({ report_type: classification.report_type, period: classification.period, ...result });
});

module.exports = router;
