const express = require('express');
const db = require('../db/schema');
const { requireAuth, requireModule } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
router.use(requireAuth);
router.use(requireModule('inventory'));

router.get('/', (req, res) => {
  const orders = db.prepare('SELECT * FROM purchase_orders WHERE business_id = ? ORDER BY id DESC').all(req.businessId);
  const withItems = orders.map(o => {
    const supplier = o.supplier_id ? db.prepare('SELECT name FROM suppliers WHERE id = ?').get(o.supplier_id) : null;
    return {
      ...o,
      supplier_name: supplier ? supplier.name : null,
      items: db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(o.id)
    };
  });
  res.json(withItems);
});

// GET /api/purchase-orders/suggestions — every low-stock item, pre-filled
// with a suggested reorder quantity, ready to turn into a PO with one click.
// Suggested quantity: enough to get back to 2x the reorder level — a simple,
// explainable default the owner can always edit before sending.
router.get('/suggestions', (req, res) => {
  const lowStock = db.prepare('SELECT * FROM inventory_items WHERE business_id = ? AND qty_on_hand <= reorder_level').all(req.businessId);
  const suggestions = lowStock.map(i => ({
    inventory_item_id: i.id,
    item_name: i.name,
    current_qty: i.qty_on_hand,
    reorder_level: i.reorder_level,
    suggested_quantity: Math.max(i.reorder_level * 2 - i.qty_on_hand, i.reorder_level || 1),
    unit_cost: i.unit_cost,
    unit: i.unit
  }));
  res.json(suggestions);
});

// POST { supplier_id, items: [{inventory_item_id, item_name, quantity, unit_cost}], notes }
router.post('/', (req, res) => {
  const { supplier_id, items, notes } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required.' });

  const result = db.prepare('INSERT INTO purchase_orders (business_id, supplier_id, notes, status) VALUES (?, ?, ?, ?)')
    .run(req.businessId, supplier_id || null, notes || null, 'draft');
  const orderId = result.lastInsertRowid;

  const insertItem = db.prepare('INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, item_name, quantity, unit_cost) VALUES (?, ?, ?, ?, ?)');
  items.forEach(i => insertItem.run(orderId, i.inventory_item_id || null, i.item_name, i.quantity || 0, i.unit_cost || 0));

  res.status(201).json({
    ...db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(orderId),
    items: db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(orderId)
  });
});

router.patch('/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['draft', 'sent', 'received', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'status must be draft, sent, received, or cancelled.' });
  }
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND business_id = ?').get(req.params.id, req.businessId);
  if (!order) return res.status(404).json({ error: 'Not found.' });

  db.prepare('UPDATE purchase_orders SET status = ?, received_at = ? WHERE id = ?')
    .run(status, status === 'received' ? new Date().toISOString() : order.received_at, order.id);

  // Marking a PO received automatically adds its quantities back into
  // inventory — the natural inverse of auto-deduction on the sales side,
  // so stock stays accurate without a second manual re-entry step.
  if (status === 'received' && order.status !== 'received') {
    const items = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(order.id);
    const addStock = db.prepare("UPDATE inventory_items SET qty_on_hand = qty_on_hand + ?, unit_cost = ?, last_restocked = datetime('now') WHERE id = ? AND business_id = ?");
    items.forEach(i => {
      if (i.inventory_item_id) addStock.run(i.quantity, i.unit_cost, i.inventory_item_id, req.businessId);
    });
  }

  res.json(db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(order.id));
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM purchase_orders WHERE id = ? AND business_id = ?').run(req.params.id, req.businessId);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

module.exports = router;
