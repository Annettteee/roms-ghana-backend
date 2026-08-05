const express = require('express');
const db = require('../db/schema');
const { requireAuth, requireModule } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireModule('invoices'));

// GET /api/cash-reconciliation/expected?date=YYYY-MM-DD — sums that day's
// invoices by payment method, so the person counting cash doesn't have to
// manually add up every receipt themselves before comparing.
router.get('/expected', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT payment_method, COALESCE(SUM(total), 0) total
    FROM invoices
    WHERE business_id = ? AND date(created_at) = ?
    GROUP BY payment_method
  `).all(req.businessId, date);

  const expected = { cash: 0, momo: 0, pos: 0 };
  rows.forEach(r => {
    if (r.payment_method === 'cash') expected.cash = r.total;
    else if (r.payment_method === 'momo') expected.momo = r.total;
    else if (r.payment_method === 'pos' || r.payment_method === 'card') expected.pos += r.total;
  });
  res.json({ date, expected });
});

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM cash_reconciliations WHERE business_id = ? ORDER BY reconciliation_date DESC, id DESC LIMIT 60').all(req.businessId);
  res.json(rows);
});

// POST — records a day's count. Expected values are captured at save time
// (not recalculated later), so the record stays a true historical snapshot
// even if invoices are edited afterward.
router.post('/', (req, res) => {
  const { reconciliation_date, branch_id, cash_expected, cash_actual, momo_expected, momo_actual, pos_expected, pos_actual, notes, counted_by } = req.body;
  if (!reconciliation_date) return res.status(400).json({ error: 'reconciliation_date is required.' });

  const result = db.prepare(`
    INSERT INTO cash_reconciliations
      (business_id, branch_id, reconciliation_date, cash_expected, cash_actual, momo_expected, momo_actual, pos_expected, pos_actual, notes, counted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.businessId, branch_id || null, reconciliation_date,
    cash_expected || 0, cash_actual || 0, momo_expected || 0, momo_actual || 0, pos_expected || 0, pos_actual || 0,
    notes || null, counted_by || null);

  res.status(201).json(db.prepare('SELECT * FROM cash_reconciliations WHERE id = ?').get(result.lastInsertRowid));
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM cash_reconciliations WHERE id = ? AND business_id = ?').run(req.params.id, req.businessId);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM cash_reconciliations WHERE id = ? AND business_id = ?').get(req.params.id, req.businessId);
  if (!existing) return res.status(404).json({ error: 'Not found.' });

  const { reconciliation_date, branch_id, cash_expected, cash_actual, momo_expected, momo_actual, pos_expected, pos_actual, notes, counted_by } = req.body;
  db.prepare(`
    UPDATE cash_reconciliations SET
      reconciliation_date = ?, branch_id = ?, cash_expected = ?, cash_actual = ?,
      momo_expected = ?, momo_actual = ?, pos_expected = ?, pos_actual = ?, notes = ?, counted_by = ?
    WHERE id = ? AND business_id = ?
  `).run(
    reconciliation_date ?? existing.reconciliation_date, branch_id ?? existing.branch_id,
    cash_expected ?? existing.cash_expected, cash_actual ?? existing.cash_actual,
    momo_expected ?? existing.momo_expected, momo_actual ?? existing.momo_actual,
    pos_expected ?? existing.pos_expected, pos_actual ?? existing.pos_actual,
    notes ?? existing.notes, counted_by ?? existing.counted_by,
    req.params.id, req.businessId
  );
  res.json(db.prepare('SELECT * FROM cash_reconciliations WHERE id = ?').get(req.params.id));
});

module.exports = router;
