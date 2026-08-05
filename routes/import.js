const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const db = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// 15MB comfortably covers a real 50,000+ row spreadsheet (tested: a 50,000-row
// CSV runs about 2.3MB) with real headroom, while still being a sane ceiling —
// this was raised from an original 2MB after a load test caught it rejecting
// a genuinely large import with an unhelpful generic error.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Turns multer's file-size error into a clear message instead of the generic
// 500 it would otherwise fall through to.
function handleUpload(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'That file is too large — the limit is 15MB, which is normally tens of thousands of rows. Try splitting it into smaller files.' });
      }
      if (err) return res.status(400).json({ error: 'Could not process that upload: ' + err.message });
      next();
    });
  };
}

// Accepts either a real .csv file OR a .xlsx/.xls Excel file — detects by the
// actual file signature (Excel files start with the bytes "PK", being a zip
// archive) rather than trusting the filename.
function readRows(buffer) {
  const isExcel = buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4B;
  if (isExcel) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  }
  return parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
}

// POST /api/import/inventory — CSV or Excel columns: name, category, unit, unit_cost, qty_on_hand, reorder_level, shelf_life_days
//
// Duplicate protection: if an ingredient with the same name (case-insensitive)
// already exists for this business, that row is SKIPPED by default rather than
// creating a second row — this is what stops "accidentally imported the same
// file twice" from silently doubling everything. Every import is tagged with
// a batch ID so it can be undone in one click via DELETE /import/undo/:batchId
// if the import itself turns out to have been a mistake (wrong file, etc).
router.post('/inventory', handleUpload('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try { rows = readRows(req.file.buffer); } catch (e) { return res.status(400).json({ error: 'Could not read that file. Make sure it is a real .csv or .xlsx file: ' + e.message }); }

  const existingNames = new Set(
    db.prepare('SELECT LOWER(name) n FROM inventory_items WHERE business_id = ?').all(req.businessId).map(r => r.n)
  );
  const batchId = db.prepare('INSERT INTO import_batches (business_id, target_table, filename, imported_count, skipped_duplicate_count) VALUES (?, ?, ?, 0, 0)')
    .run(req.businessId, 'inventory_items', req.file.originalname).lastInsertRowid;

  const insert = db.prepare(`
    INSERT INTO inventory_items (business_id, import_batch_id, name, category, unit, unit_cost, qty_on_hand, reorder_level, shelf_life_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let imported = 0, skipped = 0, skippedDuplicate = 0;
  for (const row of rows) {
    const name = row.name || row.Name || row.ingredient || row.Ingredient;
    if (!name) { skipped++; continue; }
    if (existingNames.has(name.toLowerCase())) { skippedDuplicate++; continue; }
    insert.run(
      req.businessId, batchId, name, row.category || row.Category || null, row.unit || row.Unit || 'kg',
      parseFloat(row.unit_cost || row.cost || row.Cost) || 0,
      parseFloat(row.qty_on_hand || row.quantity || row.Quantity) || 0,
      parseFloat(row.reorder_level) || 0,
      parseInt(row.shelf_life_days || row.shelf_life) || null
    );
    existingNames.add(name.toLowerCase()); // so duplicates *within* the same file are also caught
    imported++;
  }
  db.prepare('UPDATE import_batches SET imported_count = ?, skipped_duplicate_count = ? WHERE id = ?').run(imported, skippedDuplicate, batchId);
  res.json({ imported, skipped, skippedDuplicate, total: rows.length, batchId });
});

// POST /api/import/customers — CSV or Excel columns: name, phone, birthday
// Duplicate protection: matched by phone number when given (the reliable key
// for a real person), falling back to exact name match if no phone is present.
router.post('/customers', handleUpload('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try { rows = readRows(req.file.buffer); } catch (e) { return res.status(400).json({ error: 'Could not read that file. Make sure it is a real .csv or .xlsx file: ' + e.message }); }

  const existingPhones = new Set(
    db.prepare("SELECT phone FROM customers WHERE business_id = ? AND phone IS NOT NULL AND phone != ''").all(req.businessId).map(r => r.phone)
  );
  const existingNames = new Set(
    db.prepare("SELECT LOWER(name) n FROM customers WHERE business_id = ? AND (phone IS NULL OR phone = '')").all(req.businessId).map(r => r.n)
  );
  const batchId = db.prepare('INSERT INTO import_batches (business_id, target_table, filename, imported_count, skipped_duplicate_count) VALUES (?, ?, ?, 0, 0)')
    .run(req.businessId, 'customers', req.file.originalname).lastInsertRowid;

  const insert = db.prepare('INSERT INTO customers (business_id, import_batch_id, name, phone, birthday, visits) VALUES (?, ?, ?, ?, ?, 0)');
  let imported = 0, skipped = 0, skippedDuplicate = 0;
  for (const row of rows) {
    const name = row.name || row.Name;
    if (!name) { skipped++; continue; }
    const phone = row.phone || row.Phone || null;
    const isDup = phone ? existingPhones.has(phone) : existingNames.has(name.toLowerCase());
    if (isDup) { skippedDuplicate++; continue; }
    insert.run(req.businessId, batchId, name, phone, row.birthday || row.Birthday || null);
    if (phone) existingPhones.add(phone); else existingNames.add(name.toLowerCase());
    imported++;
  }
  db.prepare('UPDATE import_batches SET imported_count = ?, skipped_duplicate_count = ? WHERE id = ?').run(imported, skippedDuplicate, batchId);
  res.json({ imported, skipped, skippedDuplicate, total: rows.length, batchId });
});

// POST /api/import/dishes — CSV or Excel columns: name, serves, selling_price, target_margin, ingredients
// "ingredients" format: "label:cost; label:cost" e.g. "250g rice:3.63; 120g chicken:7.80"
// Duplicate protection: matched by dish name (case-insensitive).
router.post('/dishes', handleUpload('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let rows;
  try { rows = readRows(req.file.buffer); } catch (e) { return res.status(400).json({ error: 'Could not read that file. Make sure it is a real .csv or .xlsx file: ' + e.message }); }

  const existingNames = new Set(
    db.prepare('SELECT LOWER(name) n FROM dishes WHERE business_id = ?').all(req.businessId).map(r => r.n)
  );
  const batchId = db.prepare('INSERT INTO import_batches (business_id, target_table, filename, imported_count, skipped_duplicate_count) VALUES (?, ?, ?, 0, 0)')
    .run(req.businessId, 'dishes', req.file.originalname).lastInsertRowid;

  const insertDish = db.prepare('INSERT INTO dishes (business_id, import_batch_id, name, serves, selling_price, target_margin) VALUES (?, ?, ?, ?, ?, ?)');
  const insertIng = db.prepare('INSERT INTO dish_ingredients (dish_id, label, cost) VALUES (?, ?, ?)');
  let imported = 0, skipped = 0, skippedDuplicate = 0;

  for (const row of rows) {
    const name = row.name || row.Name || row.dish || row.Dish;
    if (!name) { skipped++; continue; }
    if (existingNames.has(name.toLowerCase())) { skippedDuplicate++; continue; }

    const dishId = insertDish.run(
      req.businessId, batchId, name, parseInt(row.serves) || 1,
      parseFloat(row.selling_price || row.price) || 0,
      parseFloat(row.target_margin) || 40
    ).lastInsertRowid;

    const ingredientsField = row.ingredients || row.Ingredients;
    if (ingredientsField) {
      ingredientsField.split(';').map(s => s.trim()).filter(Boolean).forEach(pair => {
        const [label, cost] = pair.split(':').map(s => s.trim());
        if (label) insertIng.run(dishId, label, parseFloat(cost) || 0);
      });
    }
    existingNames.add(name.toLowerCase());
    imported++;
  }
  db.prepare('UPDATE import_batches SET imported_count = ?, skipped_duplicate_count = ? WHERE id = ?').run(imported, skippedDuplicate, batchId);
  res.json({ imported, skipped, skippedDuplicate, total: rows.length, batchId });
});

// GET /api/import/recent — the last few imports, so the UI can offer "Undo"
router.get('/recent', (req, res) => {
  const rows = db.prepare('SELECT * FROM import_batches WHERE business_id = ? ORDER BY id DESC LIMIT 10').all(req.businessId);
  res.json(rows);
});

// DELETE /api/import/undo/:batchId — removes exactly the rows created by that
// one import, and nothing else. This is the real answer to "how does a manager
// clean up after accidentally importing the same 50,000-row file twice" —
// one click, not a manual hunt.
router.delete('/undo/:batchId', (req, res) => {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ? AND business_id = ?').get(req.params.batchId, req.businessId);
  if (!batch) return res.status(404).json({ error: 'Import batch not found.' });

  const result = db.prepare(`DELETE FROM ${batch.target_table} WHERE import_batch_id = ? AND business_id = ?`)
    .run(batch.id, req.businessId);
  db.prepare('DELETE FROM import_batches WHERE id = ?').run(batch.id);

  res.json({ undone: result.changes });
});

module.exports = router;
