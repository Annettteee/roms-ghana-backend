const express = require('express');
const db = require('../db/schema');
const { requireAuth, requireModule, requireDeletePermission } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { maybeAutoReorder } = require('../lib/autoReorder');

/**
 * Builds a full CRUD router for a table that has a business_id column.
 * Every query is filtered by req.businessId, which comes only from the
 * verified JWT — never from anything the client sends. That's what keeps
 * each company's data separate and makes a fresh signup start at zero.
 *
 * @param {string} moduleKey - if given, gates every route in this router
 *   behind requireModule(moduleKey) so restricted teammates get a clean 403
 *   instead of being able to read/write data outside what they were granted.
 *   Delete specifically also requires requireDeletePermission(moduleKey) —
 *   a staff member can have view/add/edit access without delete rights.
 * @param {string} displayName - human name used in the "who deleted what"
 *   activity log entry, e.g. "inventory item" rather than the raw table name.
 */
function makeCrudRouter(table, fields, moduleKey, displayName) {
  const router = express.Router();
  router.use(requireAuth);
  if (moduleKey) router.use(requireModule(moduleKey));

  const cols = fields.join(', ');
  const placeholders = fields.map(() => '?').join(', ');
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const label = displayName || table;

  router.get('/', (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE business_id = ? ORDER BY id DESC`).all(req.businessId);
    res.json(rows);
  });

  router.post('/', (req, res) => {
    const values = fields.map(f => req.body[f] ?? null);
    const result = db.prepare(
      `INSERT INTO ${table} (business_id, ${cols}) VALUES (?, ${placeholders})`
    ).run(req.businessId, ...values);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(row);
  });

  router.put('/:id', async (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND business_id = ?`).get(req.params.id, req.businessId);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    const values = fields.map(f => req.body[f] ?? existing[f]);
    db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ? AND business_id = ?`)
      .run(...values, req.params.id, req.businessId);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (table === 'inventory_items') {
      const placed = await maybeAutoReorder(req.businessId, row.id);
      if (placed) row.autoOrder = placed;
    }
    res.json(row);
  });

  router.delete('/:id', moduleKey ? requireDeletePermission(moduleKey) : (req, res, next) => next(), (req, res) => {
    // Fetch the name/label BEFORE deleting, so the log entry says what was
    // actually removed ("deleted Tomatoes") instead of just an ID number.
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND business_id = ?`).get(req.params.id, req.businessId);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    const nameField = existing.name || existing.ingredient || existing.location || `#${existing.id}`;

    const result = db.prepare(`DELETE FROM ${table} WHERE id = ? AND business_id = ?`).run(req.params.id, req.businessId);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });

    logActivity(req.businessId, req.userId, 'item_deleted', `Deleted ${label}: ${nameField}`, req);
    res.status(204).end();
  });

  return router;
}

module.exports = makeCrudRouter;
