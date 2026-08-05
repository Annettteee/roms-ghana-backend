const express = require('express');
const db = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Typical costs are rough Accra-market estimates meant as a starting point to
// edit, not a guarantee — every business should adjust to their own suppliers.
const STARTER_INGREDIENTS = [
  { name: 'Perfumed Jasmine Rice', category: 'Pantry Staples', unit: 'kg', unit_cost: 14.5, qty_on_hand: 20, reorder_level: 5, shelf_life_days: 180 },
  { name: 'Tomatoes', category: 'Produce', unit: 'kg', unit_cost: 8, qty_on_hand: 15, reorder_level: 5, shelf_life_days: 4 },
  { name: 'Onions', category: 'Produce', unit: 'kg', unit_cost: 6, qty_on_hand: 10, reorder_level: 3, shelf_life_days: 14 },
  { name: 'Chicken (whole/cut)', category: 'Protein', unit: 'kg', unit_cost: 42, qty_on_hand: 10, reorder_level: 3, shelf_life_days: 2 },
  { name: 'Tilapia', category: 'Protein', unit: 'kg', unit_cost: 38, qty_on_hand: 8, reorder_level: 2, shelf_life_days: 2 },
  { name: 'Smoked Mackerel', category: 'Protein', unit: 'kg', unit_cost: 65, qty_on_hand: 5, reorder_level: 2, shelf_life_days: 2 },
  { name: 'Vegetable Oil', category: 'Oils & Fats', unit: '25L', unit_cost: 180, qty_on_hand: 2, reorder_level: 1, shelf_life_days: 365 },
  { name: 'Gari', category: 'Pantry Staples', unit: 'kg', unit_cost: 7, qty_on_hand: 10, reorder_level: 3, shelf_life_days: 60 },
  { name: 'Cassava (for banku/fufu)', category: 'Produce', unit: 'kg', unit_cost: 5, qty_on_hand: 10, reorder_level: 3, shelf_life_days: 5 },
  { name: 'Plantain', category: 'Produce', unit: 'kg', unit_cost: 6, qty_on_hand: 10, reorder_level: 3, shelf_life_days: 7 },
  { name: 'Black-eyed Beans', category: 'Pantry Staples', unit: 'kg', unit_cost: 15, qty_on_hand: 8, reorder_level: 2, shelf_life_days: 180 },
  { name: 'Shito / Pepper Base', category: 'Seasoning', unit: 'batch', unit_cost: 4.26, qty_on_hand: 5, reorder_level: 1, shelf_life_days: 30 },
  { name: 'Cooking Gas', category: 'Utilities', unit: 'x14.5kg', unit_cost: 220, qty_on_hand: 1, reorder_level: 1, shelf_life_days: null },
];

const STARTER_DISHES = [
  { name: 'Jollof + Chicken', serves: 1, selling_price: 32.5, target_margin: 40, ingredients: [{ label: '250g rice', cost: 3.63 }, { label: '120g chicken', cost: 7.8 }, { label: 'sauce base', cost: 4.0 }] },
  { name: 'Waakye Special', serves: 1, selling_price: 25, target_margin: 35, ingredients: [{ label: 'rice and beans', cost: 5.0 }, { label: 'gari + shito', cost: 2.5 }] },
  { name: 'Banku + Tilapia', serves: 1, selling_price: 38, target_margin: 35, ingredients: [{ label: 'banku ball', cost: 3.5 }, { label: 'grilled tilapia', cost: 12.0 }, { label: 'pepper sauce', cost: 2.0 }] },
  { name: 'Fufu + Light Soup', serves: 1, selling_price: 30, target_margin: 35, ingredients: [{ label: 'fufu (cassava/plantain)', cost: 4.0 }, { label: 'light soup + protein', cost: 9.0 }] },
  { name: 'Kelewele', serves: 1, selling_price: 15, target_margin: 45, ingredients: [{ label: 'ripe plantain', cost: 3.0 }, { label: 'spice mix + oil', cost: 1.5 }] },
  { name: 'Red Red', serves: 1, selling_price: 20, target_margin: 40, ingredients: [{ label: 'black-eyed beans stew', cost: 5.5 }, { label: 'fried plantain', cost: 2.5 }] },
];

// POST /api/starter-kit/seed — only inserts if this business genuinely has
// nothing yet, so it can never be used to duplicate or overwrite real data.
router.post('/seed', (req, res) => {
  const existingInventory = db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE business_id = ?').get(req.businessId).c;
  const existingDishes = db.prepare('SELECT COUNT(*) c FROM dishes WHERE business_id = ?').get(req.businessId).c;
  if (existingInventory > 0 || existingDishes > 0) {
    return res.status(409).json({ error: 'This business already has its own inventory or dishes — the starter kit is only for a brand-new, empty workspace.' });
  }

  const insertInv = db.prepare(`
    INSERT INTO inventory_items (business_id, name, category, unit, unit_cost, qty_on_hand, reorder_level, shelf_life_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  STARTER_INGREDIENTS.forEach(i => insertInv.run(req.businessId, i.name, i.category, i.unit, i.unit_cost, i.qty_on_hand, i.reorder_level, i.shelf_life_days));

  const insertDish = db.prepare('INSERT INTO dishes (business_id, name, serves, selling_price, target_margin) VALUES (?, ?, ?, ?, ?)');
  const insertIng = db.prepare('INSERT INTO dish_ingredients (dish_id, label, cost) VALUES (?, ?, ?)');
  STARTER_DISHES.forEach(d => {
    const dishId = insertDish.run(req.businessId, d.name, d.serves, d.selling_price, d.target_margin).lastInsertRowid;
    d.ingredients.forEach(ing => insertIng.run(dishId, ing.label, ing.cost));
  });

  res.status(201).json({ ingredientsAdded: STARTER_INGREDIENTS.length, dishesAdded: STARTER_DISHES.length });
});

module.exports = router;
