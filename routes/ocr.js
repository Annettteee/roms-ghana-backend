const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// A line like "Tomatoes 8.00 kg" or "Rice - GHS 380" or "Chicken thighs GHC42.00"
// gets a name guess (everything before the first number) and a price guess
// (the largest-looking money number on the line). This is intentionally
// simple and will get things wrong on messy handwriting or multi-column
// layouts — it's a starting point for the owner to correct, never auto-saved.
function parseReceiptText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  const priceRe = /(?:GH[SC]?\s*)?(\d+(?:\.\d{1,2})?)/g;

  for (const line of lines) {
    const numbers = [...line.matchAll(priceRe)].map(m => parseFloat(m[1]));
    if (!numbers.length) continue;
    const price = Math.max(...numbers);
    const nameGuess = line.replace(priceRe, '').replace(/[-:|]+/g, ' ').trim();
    if (nameGuess.length < 2) continue; // probably just a stray number, not a real line
    results.push({ name_guess: nameGuess, price_guess: price, raw_line: line });
  }
  return results;
}

// POST /api/ocr/receipt — upload a photo of a supplier receipt or handwritten
// list. Returns candidate rows for the owner to review and edit before adding
// anything to inventory — nothing here writes to the database directly.
//
// NOTE: this requires internet access at runtime to download OCR language
// data the first time it runs (from a CDN) unless that data is pre-bundled
// locally — see README "Making OCR fully offline-capable" for how to do that
// for production. It could not be fully tested in the sandbox this was built
// in for that reason; the recognition logic itself is standard tesseract.js usage.
router.post('/receipt', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  try {
    const { data: { text } } = await Tesseract.recognize(req.file.buffer, 'eng');
    const candidates = parseReceiptText(text);
    res.json({ rawText: text, candidates });
  } catch (err) {
    res.status(500).json({
      error: 'Could not process that image. This feature needs internet access to download OCR language data on first use — see the README if this keeps failing.',
      detail: err.message
    });
  }
});

module.exports = router;
