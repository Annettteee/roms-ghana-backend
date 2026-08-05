const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { generateNarrativeInsights } = require('../lib/narrativeInsights');

const router = express.Router();
router.use(requireAuth);

// Brand palette, matching the app's own design tokens — this report should
// look like it came from the same product, not a generic export.
const COCOA = '#8B4A24';
const COCOA_DEEP = '#5E3117';
const GOLD = '#D9A441';
const FOREST = '#3F6B4F';
const CRITICAL = '#B23A2A';
const INK = '#2B2118';
const INK_SOFT = '#8C7A68';
const CARD_BG = '#FCF8F1';

function money(business, n) { return `${business.currency || 'GHS'} ${n.toFixed(2)}`; }

// GET /api/reports/pdf — a real, visual monthly report: colored header, KPI
// cards, bar-chart visualizations for dish margins and waste, a low-stock
// list, and branch comparison if this is a chain. Built to be the document
// an owner actually forwards to whoever they report to, not something that
// looks like a database dump.
router.get('/pdf', (req, res) => {
  const bId = req.businessId;
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(bId);
  const cur = business.currency || 'GHS';

  const revenue = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE business_id = ? AND created_at >= date('now','start of month')`).get(bId).v;
  const waste = db.prepare(`SELECT COALESCE(SUM(cost),0) v FROM waste_log WHERE business_id = ? AND created_at >= date('now','start of month')`).get(bId).v;
  const tips = db.prepare(`SELECT COALESCE(SUM(tip_amount),0) v FROM invoices WHERE business_id = ? AND created_at >= date('now','start of month')`).get(bId).v;
  const invoiceCount = db.prepare(`SELECT COUNT(*) c FROM invoices WHERE business_id = ? AND created_at >= date('now','start of month')`).get(bId).c;

  const dishes = db.prepare('SELECT * FROM dishes WHERE business_id = ?').all(bId).map(d => {
    const ingredients = db.prepare('SELECT * FROM dish_ingredients WHERE dish_id = ?').all(d.id);
    const cost = ingredients.reduce((s, i) => s + (i.cost || 0), 0);
    const margin = d.selling_price > 0 ? ((d.selling_price - cost) / d.selling_price * 100) : 0;
    return { ...d, cost, margin };
  }).sort((a, b) => b.margin - a.margin);

  const lowStock = db.prepare('SELECT * FROM inventory_items WHERE business_id = ? AND qty_on_hand <= reorder_level').all(bId);
  const branches = db.prepare('SELECT * FROM branches WHERE business_id = ?').all(bId);
  const wasteByIngredient = db.prepare(`
    SELECT ingredient, SUM(cost) total FROM waste_log WHERE business_id = ? AND created_at >= date('now','start of month')
    GROUP BY ingredient ORDER BY total DESC LIMIT 6
  `).all(bId);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${business.slug}-report-${new Date().toISOString().slice(0,10)}.pdf"`);

  const doc = new PDFDocument({ margin: 0, size: 'A4' });
  doc.pipe(res);

  const PAGE_W = doc.page.width;
  const MARGIN = 45;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  // ---------- Header banner ----------
  doc.rect(0, 0, PAGE_W, 110).fill(COCOA_DEEP);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22).text(business.name, MARGIN, 32);
  doc.font('Helvetica').fontSize(10).fillColor('#E9D3BC')
    .text(`Monthly Operations Report — ${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`, MARGIN, 62);
  doc.fontSize(8.5).fillColor('#D9A441').text(`Generated ${new Date().toLocaleDateString('en-GB')}`, MARGIN, 80);

  let y = 130;

  // ---------- KPI cards row ----------
  const kpis = [
    { label: 'REVENUE', value: money(business, revenue), color: FOREST },
    { label: 'WASTE', value: money(business, waste), color: waste > 0 ? CRITICAL : FOREST },
    { label: 'TIPS', value: money(business, tips), color: GOLD },
    { label: 'INVOICES', value: String(invoiceCount), color: COCOA },
  ];
  const cardW = (CONTENT_W - 3 * 10) / 4;
  kpis.forEach((k, i) => {
    const x = MARGIN + i * (cardW + 10);
    doc.roundedRect(x, y, cardW, 60, 6).fill(CARD_BG);
    doc.roundedRect(x, y, 4, 60, 2).fill(k.color);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK_SOFT).text(k.label, x + 12, y + 10, { width: cardW - 20 });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(k.value, x + 12, y + 26, { width: cardW - 20 });
  });
  y += 85;

  function sectionHeader(title) {
    doc.roundedRect(MARGIN, y, 4, 16, 2).fill(GOLD);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(title, MARGIN + 12, y);
    y += 24;
  }

  // ---------- Section: Dish margins (bar chart) ----------
  if (dishes.length) {
    sectionHeader('Dish Margins');
    const maxMargin = Math.max(...dishes.map(d => d.margin), 100);
    const barAreaW = CONTENT_W - 180;
    dishes.slice(0, 8).forEach(d => {
      const barColor = d.margin < 20 ? CRITICAL : d.margin < 35 ? GOLD : FOREST;
      const barW = Math.max(2, (d.margin / maxMargin) * barAreaW);
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(d.name.slice(0, 24), MARGIN, y + 2, { width: 150 });
      doc.roundedRect(MARGIN + 155, y, barAreaW, 12, 3).fill('#F1E7D8');
      doc.roundedRect(MARGIN + 155, y, barW, 12, 3).fill(barColor);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`${d.margin.toFixed(0)}%`, MARGIN + 160 + barAreaW, y + 1, { width: 30 });
      y += 20;
    });
    y += 12;
  }

  // ---------- Section: Waste breakdown (bar chart) ----------
  if (wasteByIngredient.length) {
    sectionHeader('Top Waste This Month');
    const maxWaste = Math.max(...wasteByIngredient.map(w => w.total));
    const barAreaW = CONTENT_W - 180;
    wasteByIngredient.forEach(w => {
      const barW = Math.max(2, (w.total / maxWaste) * barAreaW);
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(w.ingredient.slice(0, 24), MARGIN, y + 2, { width: 150 });
      doc.roundedRect(MARGIN + 155, y, barAreaW, 12, 3).fill('#F1E7D8');
      doc.roundedRect(MARGIN + 155, y, barW, 12, 3).fill(CRITICAL);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(money(business, w.total), MARGIN + 160 + barAreaW, y + 1, { width: 70 });
      y += 20;
    });
    y += 12;
  }

  if (y > 650) { doc.addPage(); y = 45; }

  // ---------- Section: Needs reordering ----------
  if (lowStock.length) {
    sectionHeader('Needs Reordering');
    lowStock.forEach((i, idx) => {
      doc.roundedRect(MARGIN, y, CONTENT_W, 20, 4).fill(idx % 2 === 0 ? CARD_BG : '#FFFFFF');
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(i.name, MARGIN + 10, y + 5, { width: 250 });
      doc.font('Helvetica').fontSize(9).fillColor(CRITICAL).text(`${i.qty_on_hand} ${i.unit || ''} on hand - reorder at ${i.reorder_level}`, MARGIN + 270, y + 5);
      y += 22;
    });
    y += 10;
  }

  // ---------- Section: Branch comparison ----------
  if (branches.length) {
    if (y > 680) { doc.addPage(); y = 45; }
    sectionHeader('Branch Comparison');
    branches.forEach(b => {
      const branchRevenue = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE business_id = ? AND branch_id = ? AND created_at >= date('now','start of month')`).get(bId, b.id).v;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(b.name, MARGIN, y);
      doc.font('Helvetica').fontSize(9).fillColor(INK_SOFT).text(`Revenue this month: ${money(business, branchRevenue)}`, MARGIN, y + 13);
      y += 32;
    });
  }

  // ---------- Recommendations page — the "consulting report" section ----------
  // Real, specific advice computed from this business's own data, not a
  // generic checklist — this is what makes the report worth reading past
  // the numbers, and what an owner would actually forward to a partner.
  doc.addPage();
  doc.rect(0, 0, PAGE_W, 70).fill(COCOA_DEEP);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18).text('Recommendations', MARGIN, 25);
  doc.font('Helvetica').fontSize(9.5).fillColor('#E9D3BC').text('Specific to this business, computed from this month\'s real activity.', MARGIN, 48);

  let ry = 95;
  const insights = generateNarrativeInsights(bId);
  const typeColor = { good: FOREST, warning: GOLD, critical: CRITICAL };
  const typeIcon = { good: '+', warning: '!', critical: '!' };
  insights.forEach(insight => {
    const color = typeColor[insight.type] || INK_SOFT;
    doc.circle(MARGIN + 8, ry + 8, 8).fill(color);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF').text(typeIcon[insight.type] || '-', MARGIN + 4, ry + 4, { width: 8, align: 'center' });
    const textHeight = doc.font('Helvetica').fontSize(10.5).fillColor(INK).heightOfString(insight.text, { width: CONTENT_W - 30 });
    doc.text(insight.text, MARGIN + 24, ry, { width: CONTENT_W - 30 });
    ry += textHeight + 18;
    if (ry > 720) { doc.addPage(); ry = 45; }
  });

  // ---------- Footer ----------
  doc.font('Helvetica').fontSize(8).fillColor(INK_SOFT)
    .text('Generated by ROMS Ghana - Restaurant Operations, per business.', MARGIN, doc.page.height - 40, { width: CONTENT_W, align: 'center' });

  doc.end();
});

module.exports = router;
