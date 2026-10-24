// Product sheets: the columns a manager edits in Excel. The same layout is used
// for the blank template, the export of current products and the import.
// The Excel libraries are loaded only when a manager imports or exports, so the
// register stays small and fast.
import { parseMoney } from './money.js';

export const COLUMNS = ['SKU', 'Barcode', 'Name', 'Category', 'Sub-category', 'Price', 'Tax %', 'Stock', 'Expiry date', 'Refundable', 'Active'];

const KEYS = {
  sku: 'sku',
  name: 'name',
  category: 'category',
  'sub-category': 'subcategory',
  subcategory: 'subcategory',
  barcode: 'barcode',
  'expiry date': 'expiresOn',
  expiry: 'expiresOn',
  'best before': 'expiresOn',
  price: 'price',
  'tax %': 'tax',
  tax: 'tax',
  stock: 'stock',
  refundable: 'refundable',
  active: 'active',
};

const yes = (v) => {
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  return undefined;
};

/**
 * Turns sheet rows (first row = headings) into import rows for the API.
 * Returns { rows, problems } - problems are things the browser can already
 * tell (unknown headings, unreadable numbers); the server checks the rest.
 */
export function rowsToProducts(sheet) {
  const [head = [], ...body] = sheet;
  const keys = head.map(
    (h) =>
      KEYS[
        String(h ?? '')
          .trim()
          .toLowerCase()
      ],
  );
  const problems = [];
  if (!keys.includes('sku')) problems.push('The first row must contain the headings, including SKU.');
  head.forEach((h, i) => {
    if (h != null && String(h).trim() && !keys[i]) problems.push(`Unknown column "${h}" is ignored.`);
  });
  const rows = [];
  body.forEach((cells, i) => {
    if (!cells || cells.every((c) => c == null || String(c).trim() === '')) return; // blank line
    const r = {};
    const raw = {};
    keys.forEach((k, j) => {
      if (k && cells[j] != null && String(cells[j]).trim() !== '') raw[k] = cells[j];
    });
    const row = i + 2;
    if (raw.sku !== undefined) r.sku = String(raw.sku).trim();
    if (raw.name !== undefined) r.name = String(raw.name).trim();
    if (raw.category !== undefined) r.category = String(raw.category).trim();
    if (raw.subcategory !== undefined) r.subcategory = String(raw.subcategory).trim();
    if (raw.barcode !== undefined) r.barcode = String(raw.barcode).trim();
    if (raw.expiresOn !== undefined) {
      const v = raw.expiresOn instanceof Date ? raw.expiresOn.toISOString().slice(0, 10) : String(raw.expiresOn).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) problems.push(`Row ${row}: expiry date "${raw.expiresOn}" must be YYYY-MM-DD.`);
      else r.expiresOn = v;
    }
    if (raw.price !== undefined) {
      const cents = typeof raw.price === 'number' ? Math.round(raw.price * 100) : parseMoney(raw.price);
      if (cents == null) problems.push(`Row ${row}: price "${raw.price}" is not a number.`);
      else r.priceCents = cents;
    }
    if (raw.tax !== undefined) {
      const t = Number(String(raw.tax).replace('%', ''));
      if (!Number.isFinite(t)) problems.push(`Row ${row}: tax "${raw.tax}" is not a number.`);
      else r.taxRateBp = Math.round((typeof raw.tax === 'number' && raw.tax > 0 && raw.tax < 1 ? raw.tax * 100 : t) * 100);
    }
    if (raw.stock !== undefined) {
      const n = Number(raw.stock);
      if (!Number.isInteger(n)) problems.push(`Row ${row}: stock "${raw.stock}" is not a whole number.`);
      else r.stock = n;
    }
    for (const k of ['refundable', 'active']) {
      if (raw[k] === undefined) continue;
      const b = yes(raw[k]);
      if (b === undefined) problems.push(`Row ${row}: ${k} must be Yes or No.`);
      else r[k] = b;
    }
    rows.push(r);
  });
  return { rows, problems };
}

/** Minimal CSV reader (quotes, commas, CRLF) for files saved as .csv. */
export function parseCsv(text) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

/** Reads an uploaded .xlsx or .csv File into sheet rows. */
export async function readSheetFile(file) {
  if (/\.csv$/i.test(file.name)) return parseCsv((await file.text()).replace(/^\uFEFF/, ''));
  const { readSheet } = await import('read-excel-file/universal');
  return readSheet(await file.arrayBuffer());
}

/** Sheet rows for the template (no products) or an export of current products. */
export function productsToSheet(products = []) {
  const bold = (value) => ({ value, fontWeight: 'bold' });
  const rows = products.map((p) => [
    { value: p.sku },
    { value: p.barcode || '' },
    { value: p.name },
    { value: p.category },
    { value: p.subcategory || '' },
    { value: p.priceCents / 100, type: Number, format: '0.00' },
    { value: p.taxRateBp / 100, type: Number },
    { value: p.stock, type: Number },
    { value: p.expiresOn || '' },
    { value: p.refundable === false ? 'No' : 'Yes' },
    { value: p.active === false ? 'No' : 'Yes' },
  ]);
  if (products.length === 0) {
    const ex = (sku, code, name, cat, sub, price, tax, stock, expiry, refundable) => [
      { value: sku },
      { value: code },
      { value: name },
      { value: cat },
      { value: sub },
      { value: price, type: Number },
      { value: tax, type: Number },
      { value: stock, type: Number },
      { value: expiry },
      { value: refundable },
      { value: 'Yes' },
    ];
    rows.push(ex('COF-001', '2000000000015', 'Coffee, medium', 'Drinks', 'Coffee', 2.45, 13, 20, '', 'Yes'));
    rows.push(ex('SAN-001', '2000000000022', 'Ham sandwich', 'Food', 'Sandwiches', 6.5, 13, 10, '2026-12-31', 'No'));
  }
  return [COLUMNS.map(bold), ...rows];
}

/** Builds the .xlsx and hands it to the browser as a download. */
export async function downloadProducts(products, fileName) {
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  const blob = await writeExcelFile(productsToSheet(products), {
    columns: [
      { width: 12 },
      { width: 15 },
      { width: 36 },
      { width: 14 },
      { width: 16 },
      { width: 9 },
      { width: 7 },
      { width: 7 },
      { width: 12 },
      { width: 11 },
      { width: 8 },
    ],
  }).toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
