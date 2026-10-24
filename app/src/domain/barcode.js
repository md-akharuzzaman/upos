'use strict';

// Barcodes (v2.3). Retail barcodes are GTINs: EAN-8, UPC-A (12), EAN-13 and
// GTIN-14, whose last digit is a check digit - a mistyped code is refused.
// Stores can also use their own internal codes (Code 128 style: letters,
// digits, dash, dot), which have no check digit.

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID' });
}

/** GS1 check digit for the digits before it. */
function gtinCheckDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

function isValidGtin(code) {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  return gtinCheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/** Returns the stored form of a barcode, or null for "none"; throws 400 when invalid. */
function normaliseBarcode(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  const code = String(v).replace(/\s+/g, '').toUpperCase();
  if (/^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length)) {
    if (!isValidGtin(code)) throw invalid(`barcode ${code} has a wrong check digit (expected ${gtinCheckDigit(code.slice(0, -1))} at the end)`);
    return code;
  }
  if (!/^[A-Z0-9.-]{3,32}$/.test(code)) throw invalid('barcode must be a GTIN (EAN-8/UPC-A/EAN-13/GTIN-14) or 3-32 letters, digits, dash or dot');
  return code;
}

module.exports = { normaliseBarcode, isValidGtin, gtinCheckDigit };
