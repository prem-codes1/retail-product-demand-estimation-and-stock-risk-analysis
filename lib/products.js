'use strict';
// Product name search: lets users type a product name (or part of it) or a code.
const fs = require('fs');

// Loads data/products.json -> [{ code, name }]
function loadProducts(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8')).products;
}

// Pre-compute lowercase text and word lists once, so each search is fast
function buildIndex(products) {
  return products.map((p) => ({
    code: p.code,
    name: p.name,
    lowerCode: p.code.toLowerCase(),
    lowerName: p.name.toLowerCase(),
    words: p.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  }));
}

// Finds products whose name or code STARTS with the text, or where any WORD
// in the name starts with it. "wh" matches "WHITE HANGING HEART T-LIGHT HOLDER".
// Names that start with the text are listed first.
function searchProducts(index, text, limit = 10) {
  const query = text.trim().toLowerCase();
  if (!query) return [];
  // Each word typed must match the start of some word in the name ("hanging heart")
  const tokens = query.split(/[^a-z0-9]+/).filter(Boolean);
  const startMatches = [];
  const wordMatches = [];
  for (const p of index) {
    if (p.lowerName.startsWith(query) || p.lowerCode.startsWith(query)) {
      startMatches.push(p);
    } else if (tokens.length && tokens.every((t) => p.words.some((w) => w.startsWith(t)))) {
      wordMatches.push(p);
    }
  }
  return [...startMatches, ...wordMatches].slice(0, limit).map(({ code, name }) => ({ code, name }));
}

// Turns what the user typed into one product code.
// Returns one of:
//   { status: 'found', code }
//   { status: 'ambiguous', matches: [{code,name}, ...] }
//   { status: 'not_found' }
function resolveProduct(index, historyCodes, text) {
  const input = text.trim();
  if (!input) return { status: 'not_found' };

  // 1. Exact code (try the text as typed, then in capitals)
  for (const candidate of [input, input.toUpperCase()]) {
    if (historyCodes.has(candidate)) return { status: 'found', code: candidate };
  }

  // 2. Exact name (not case-sensitive)
  const lower = input.toLowerCase();
  const exact = index.filter((p) => p.lowerName === lower);
  if (exact.length === 1) return { status: 'found', code: exact[0].code };
  if (exact.length > 1) {
    return { status: 'ambiguous', matches: exact.map(({ code, name }) => ({ code, name })) };
  }

  // 3. Partial text: one match is used, several are returned for the user to pick
  const matches = searchProducts(index, input, 10);
  if (matches.length === 1) return { status: 'found', code: matches[0].code };
  if (matches.length > 1) return { status: 'ambiguous', matches };
  return { status: 'not_found' };
}

module.exports = { loadProducts, buildIndex, searchProducts, resolveProduct };
