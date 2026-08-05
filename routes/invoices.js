const express = require('express');
const db = require('../db/schema');
const { requireAuth, requireModule } = require('../middleware/auth');
const { maybeAutoReorder } = require('../lib/autoReorder');

const router = express.Router();
router.use(requireAuth);
router.use(requireModule('invoices'));

router.get('/', (req, res) => {
  const invoices = db.prepare('SELECT * FROM invoices WHERE business_id = ? ORDER BY id DESC').all(req.businessId);
  const withItems = invoices.map(inv => ({
    ...inv,
    items: db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id)
  }));
  res.json(withItems);
});

// POST /api/invoices { customer_name, tax_rate (optional override), items: [{item, qty, price}] }
router.post('/', async (req, res) => {
  const { customer_name, tax_rate, items, branch_id, tip_amount, payment_method, staff_id, customer_id } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'At least one line item is required.' });

  const subtotal = items.reduce((s, i) => s + (i.qty || 0) * (i.price || 0), 0);
  const tip = tip_amount || 0;

  let tax, appliedRate, breakdown;
  if (tax_rate !== undefined && tax_rate !== null) {
    // Manual override (e.g. the VAT Flat Rate Scheme toggle in the UI) — one flat rate, no breakdown.
    appliedRate = tax_rate;
    tax = subtotal * appliedRate;
    breakdown = [{ label: 'Tax (manual rate)', rate: appliedRate, amount: tax }];
  } else {
    // Default: use this business's configured Ghana tax settings, itemized —
    // matches how a real Ghanaian invoice shows VAT/NHIL/Tourism Levy as separate lines.
    const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.businessId);
    breakdown = [];
    tax = 0;
    if (biz.vat_enabled) { const amt = subtotal * (biz.vat_rate / 100); breakdown.push({ label: 'VAT', rate: biz.vat_rate, amount: amt }); tax += amt; }
    if (biz.nhil_enabled) { const amt = subtotal * (biz.nhil_rate / 100); breakdown.push({ label: 'NHIL', rate: biz.nhil_rate, amount: amt }); tax += amt; }
    if (biz.tourism_levy_enabled) { const amt = subtotal * (biz.tourism_levy_rate / 100); breakdown.push({ label: 'Tourism Levy', rate: biz.tourism_levy_rate, amount: amt }); tax += amt; }
    appliedRate = subtotal > 0 ? tax / subtotal : 0;
  }
  const total = subtotal + tax + tip;

  const result = db.prepare(`
    INSERT INTO invoices (business_id, branch_id, customer_name, subtotal, tax_rate, tax, tax_breakdown, tip_amount, total, payment_method, staff_id, customer_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.businessId, branch_id || null, customer_name || 'Walk-in customer', subtotal, appliedRate, tax, JSON.stringify(breakdown), tip, total, payment_method || 'cash', staff_id || null, customer_id || null);

  // Auto-tracks the visit — this is what makes "+1 visit" no longer something
  // someone has to remember to click by hand every time a regular comes in.
  if (customer_id) {
    db.prepare("UPDATE customers SET visits = visits + 1, last_visit_at = datetime('now') WHERE id = ? AND business_id = ?")
      .run(customer_id, req.businessId);
  }

  const invoiceId = result.lastInsertRowid;
  const insertItem = db.prepare('INSERT INTO invoice_items (invoice_id, item, qty, price) VALUES (?, ?, ?, ?)');
  items.forEach(i => insertItem.run(invoiceId, i.item, i.qty, i.price));

  // Auto-deduct inventory: if a line item's name matches an existing dish
  // (case-insensitive, exact match — not fuzzy, to avoid deducting the wrong
  // recipe on a near-miss), walk that dish's ingredients and subtract
  // quantity × line-item-qty from whichever inventory items they're linked
  // to. Ingredients with no inventory_item_id link are skipped — there's
  // nothing to deduct from if the dish was never connected to real stock.
  const deductions = []; // returned in the response so the UI can show what happened, not leave it invisible
  const autoOrders = [];
  const dishStmt = db.prepare('SELECT * FROM dishes WHERE business_id = ? AND LOWER(name) = LOWER(?)');
  const ingredientsStmt = db.prepare('SELECT * FROM dish_ingredients WHERE dish_id = ? AND inventory_item_id IS NOT NULL AND quantity > 0');
  const invItemStmt = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND business_id = ?');
  const deductStmt = db.prepare('UPDATE inventory_items SET qty_on_hand = qty_on_hand - ? WHERE id = ?');

  for (const lineItem of items) {
    const dish = dishStmt.get(req.businessId, lineItem.item);
    if (!dish) continue; // no matching dish — this was a one-off item, nothing to deduct
    const ingredients = ingredientsStmt.all(dish.id);
    for (const ing of ingredients) {
      const invItem = invItemStmt.get(ing.inventory_item_id, req.businessId);
      if (!invItem) continue;
      const deductAmount = ing.quantity * lineItem.qty;
      deductStmt.run(deductAmount, invItem.id);
      deductions.push({ inventory_item: invItem.name, deducted: deductAmount, unit: invItem.unit, remaining: invItem.qty_on_hand - deductAmount });
      const placed = await maybeAutoReorder(req.businessId, invItem.id);
      if (placed) autoOrders.push(placed);
    }
  }

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  invoice.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
  invoice.inventoryDeductions = deductions;
  invoice.autoOrders = autoOrders;
  res.status(201).json(invoice);
});

router.patch('/:id/status', (req, res) => {
  const { status } = req.body;
  const result = db.prepare('UPDATE invoices SET status = ? WHERE id = ? AND business_id = ?')
    .run(status, req.params.id, req.businessId);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

// GET /api/invoices/:id/pdf — a real downloadable document for this one invoice,
// the kind you'd actually hand or email to a customer/vendor.
router.get('/:id/pdf', (req, res) => {
  const PDFDocument = require('pdfkit');
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND business_id = ?').get(req.params.id, req.businessId);
  if (!invoice) return res.status(404).json({ error: 'Not found.' });
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoice.id);
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.businessId);
  const breakdown = invoice.tax_breakdown ? JSON.parse(invoice.tax_breakdown) : [];

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.id}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).fillColor('#5E3117').text(business.name);
  doc.fontSize(10).fillColor('#8C7A68').text(`Invoice #${invoice.id} — ${(invoice.created_at||'').slice(0,10)}`);
  doc.moveDown(1);
  doc.fontSize(12).fillColor('#2B2118').text(`Billed to: ${invoice.customer_name}`);
  doc.moveDown(1);

  items.forEach(i => {
    doc.fontSize(11).text(`${i.item}   x${i.qty}   @ ${business.currency||'GHS'} ${i.price.toFixed(2)}   =  ${(i.qty*i.price).toFixed(2)}`);
  });
  doc.moveDown(0.5);
  doc.fontSize(11).text(`Subtotal: ${business.currency||'GHS'} ${invoice.subtotal.toFixed(2)}`);
  breakdown.forEach(b => doc.text(`${b.label} (${b.rate}%): ${business.currency||'GHS'} ${b.amount.toFixed(2)}`));
  if (invoice.tip_amount) doc.text(`Tip: ${business.currency||'GHS'} ${invoice.tip_amount.toFixed(2)}`);
  doc.moveDown(0.3);
  doc.fontSize(14).fillColor('#5E3117').text(`Total due: ${business.currency||'GHS'} ${invoice.total.toFixed(2)}`);
  doc.fontSize(10).fillColor(invoice.status==='paid' ? '#3F6B4F' : '#B23A2A').text(`Status: ${invoice.status.toUpperCase()}`);

  doc.end();
});

module.exports = router;
