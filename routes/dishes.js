const express = require('express');
const db = require('../db/schema');
const { requireAuth, requireModule, requireDeletePermission } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();
router.use(requireAuth);
router.use(requireModule('menu'));

function withCosting(dish, ingredientsByDish) {
  const ingredients = ingredientsByDish[dish.id] || [];
  const cost = ingredients.reduce((sum, i) => sum + (i.cost || 0), 0);
  const profit = dish.selling_price - cost;
  const margin = dish.selling_price > 0 ? (profit / dish.selling_price) * 100 : 0;
  const recommendedPrice = dish.target_margin < 100 ? cost / (1 - dish.target_margin / 100) : cost;
  return { ...dish, ingredients, cost, profit, margin, recommendedPrice };
}
// For a single dish (after create/update) a one-off query is fine — the N+1
// problem only bites when doing this in a loop over thousands of dishes.
function withCostingSingle(dish) {
  const ingredients = db.prepare('SELECT * FROM dish_ingredients WHERE dish_id = ?').all(dish.id);
  return withCosting(dish, { [dish.id]: ingredients });
}

// GET /api/dishes — every dish + live costing, empty array for a fresh business.
// Fetches all ingredients for this business's dishes via a JOIN (one query,
// one parameter) rather than either a per-dish query (slow — a 50,000-dish
// load test took 60+ seconds and timed out) or a giant `IN (id1, id2, ...)`
// list (crashes — SQLite has a hard ~999 bound-parameter limit per query,
// which 50,000 IDs blows straight through). The JOIN has neither problem.
router.get('/', (req, res) => {
  const dishes = db.prepare('SELECT * FROM dishes WHERE business_id = ? ORDER BY id DESC').all(req.businessId);
  const allIngredients = db.prepare(`
    SELECT di.* FROM dish_ingredients di
    JOIN dishes d ON d.id = di.dish_id
    WHERE d.business_id = ?
  `).all(req.businessId);
  const ingredientsByDish = {};
  for (const ing of allIngredients) {
    (ingredientsByDish[ing.dish_id] ||= []).push(ing);
  }
  res.json(dishes.map(d => withCosting(d, ingredientsByDish)));
});

// POST /api/dishes  { name, serves, selling_price, target_margin, ingredients: [{label, cost, inventory_item_id}] }
router.post('/', (req, res) => {
  const { name, serves, selling_price, target_margin, ingredients, branch_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Dish name is required.' });

  const result = db.prepare(`
    INSERT INTO dishes (business_id, branch_id, name, serves, selling_price, target_margin)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.businessId, branch_id || null, name, serves || 1, selling_price || 0, target_margin || 40);

  const dishId = result.lastInsertRowid;
  const insertIng = db.prepare('INSERT INTO dish_ingredients (dish_id, inventory_item_id, label, quantity, cost) VALUES (?, ?, ?, ?, ?)');
  (ingredients || []).forEach(ing => {
    insertIng.run(dishId, ing.inventory_item_id || null, ing.label || '', ing.quantity || 0, ing.cost || 0);
  });

  const dish = db.prepare('SELECT * FROM dishes WHERE id = ?').get(dishId);
  res.status(201).json(withCostingSingle(dish));
});

// PUT /api/dishes/:id — replaces the dish's ingredient list wholesale (simplest correct approach)
router.put('/:id', (req, res) => {
  const dish = db.prepare('SELECT * FROM dishes WHERE id = ? AND business_id = ?').get(req.params.id, req.businessId);
  if (!dish) return res.status(404).json({ error: 'Not found.' });

  const { name, serves, selling_price, target_margin, ingredients } = req.body;
  db.prepare(`
    UPDATE dishes SET name = ?, serves = ?, selling_price = ?, target_margin = ?
    WHERE id = ? AND business_id = ?
  `).run(
    name ?? dish.name, serves ?? dish.serves, selling_price ?? dish.selling_price,
    target_margin ?? dish.target_margin, req.params.id, req.businessId
  );

  if (ingredients) {
    db.prepare('DELETE FROM dish_ingredients WHERE dish_id = ?').run(req.params.id);
    const insertIng = db.prepare('INSERT INTO dish_ingredients (dish_id, inventory_item_id, label, quantity, cost) VALUES (?, ?, ?, ?, ?)');
    ingredients.forEach(ing => insertIng.run(req.params.id, ing.inventory_item_id || null, ing.label || '', ing.quantity || 0, ing.cost || 0));
  }

  const updated = db.prepare('SELECT * FROM dishes WHERE id = ?').get(req.params.id);
  res.json(withCostingSingle(updated));
});

router.delete('/:id', requireDeletePermission('menu'), (req, res) => {
  const existing = db.prepare('SELECT * FROM dishes WHERE id = ? AND business_id = ?').get(req.params.id, req.businessId);
  if (!existing) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM dishes WHERE id = ? AND business_id = ?').run(req.params.id, req.businessId);
  logActivity(req.businessId, req.userId, 'item_deleted', `Deleted dish: ${existing.name}`, req);
  res.status(204).end();
});

module.exports = router;
