const db = require('../db/schema');
const { logActivity } = require('./activityLog');

// Auto-places a purchase order (status 'sent', skipping the draft/review
// step) for a single low-stock item — deliberately narrow and cautious:
//
//   1. Only runs at all if the business has explicitly opted in
//      (auto_reorder_enabled), off by default.
//   2. Only fires for an item genuinely at or below its reorder level.
//   3. Only fires if there's a supplier whose `item` field matches this
//      ingredient by name — no supplier match means no auto-order, full
//      stop, since ordering from nobody isn't a real order.
//   4. Never creates a second auto-order for something that already has an
//      open PO (draft or sent) covering it — the whole risk with "no human
//      review" is spamming duplicate orders, and this is the guard against
//      that specific failure mode.
//
// Called after any change that could drop stock (auto-deduction from a
// sale, or a manual quantity edit) — best-effort: a failure here never
// blocks the calling request, since a missed auto-order is far less harmful
// than a broken inventory update.
async function maybeAutoReorder(businessId, inventoryItemId) {
  try {
    const business = db.prepare('SELECT auto_reorder_enabled FROM businesses WHERE id = ?').get(businessId);
    if (!business || !business.auto_reorder_enabled) return null;

    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND business_id = ?').get(inventoryItemId, businessId);
    if (!item || item.qty_on_hand > item.reorder_level) return null;

    const supplier = db.prepare(`
      SELECT * FROM suppliers WHERE business_id = ? AND LOWER(item) = LOWER(?) LIMIT 1
    `).get(businessId, item.name);
    if (!supplier) return null; // nobody to order from — this is the real safety boundary

    const alreadyOpen = db.prepare(`
      SELECT poi.id FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE poi.inventory_item_id = ? AND po.business_id = ? AND po.status IN ('draft','sent')
      LIMIT 1
    `).get(item.id, businessId);
    if (alreadyOpen) return null; // don't pile up duplicate auto-orders while one is still pending

    const suggestedQty = Math.max(item.reorder_level * 2 - item.qty_on_hand, item.reorder_level || 1);

    const orderId = db.prepare(`
      INSERT INTO purchase_orders (business_id, supplier_id, status, notes) VALUES (?, ?, 'sent', 'Placed automatically -- stock fell to or below reorder level.')
    `).run(businessId, supplier.id).lastInsertRowid;
    db.prepare(`
      INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, item_name, quantity, unit_cost) VALUES (?, ?, ?, ?, ?)
    `).run(orderId, item.id, item.name, suggestedQty, item.unit_cost || 0);

    logActivity(businessId, null, 'auto_po_created', `Auto-ordered ${suggestedQty} ${item.unit || ''} of ${item.name} from ${supplier.name} (PO #${orderId})`, null);

    return { orderId, itemName: item.name, supplierName: supplier.name, quantity: suggestedQty };
  } catch (err) {
    console.error('Auto-reorder check failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = { maybeAutoReorder };
