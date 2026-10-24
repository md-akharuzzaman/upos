'use strict';

// Payment methods (v2.4). The POS records how a sale was paid; it never takes
// the money itself and never sees card numbers:
//  * cash      - tendered amount and change
//  * debit     - Interac debit on the store's payment terminal: approval code
//  * credit    - credit card on the terminal: approval code (+ card brand)
//  * card      - v2.0-v2.3 "card" (debit or credit not recorded); still accepted
//  * etransfer - Interac e-Transfer to the store's e-mail: the reference number
//                from the deposit notification
//  * stripe    - charged in Stripe (Terminal, payment link, invoice): the
//                Stripe payment id (pi_..., ch_... or py_...)
// Older versions only know 'cash' and 'card', so the database keeps that
// compatible value in payment_method and the exact type in payment_type.

const METHODS = ['cash', 'debit', 'credit', 'card', 'etransfer', 'stripe'];
const LABELS = {
  cash: 'Cash',
  debit: 'Debit (Interac)',
  credit: 'Credit card',
  card: 'Card',
  etransfer: 'Interac e-Transfer',
  stripe: 'Stripe',
};
const CARD_BRANDS = ['visa', 'mastercard', 'amex', 'discover', 'unionpay', 'jcb', 'other'];
const isCard = (m) => m === 'debit' || m === 'credit' || m === 'card';

/** The value older versions understand (stored in sales.payment_method / refunds.method). */
const legacyMethod = (m) => (m === 'cash' ? 'cash' : 'card');

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID' });
}

/** Whether a store with these accepted methods (business profile) takes `method`. */
function accepts(enabled, method) {
  if (!Array.isArray(enabled) || enabled.length === 0) return true; // no profile yet
  if (method === 'card') return enabled.includes('debit') || enabled.includes('credit');
  return enabled.includes(method);
}

const REFERENCE = {
  card: { re: /^[A-Za-z0-9-]{4,40}$/, hint: 'the terminal approval reference (4-40 letters, digits or -)' },
  etransfer: { re: /^[A-Za-z0-9]{6,40}$/, hint: 'the e-Transfer reference number from the deposit notification (6-40 letters or digits)' },
  stripe: { re: /^(pi|ch|py)_[A-Za-z0-9]{8,37}$/, hint: 'the Stripe payment id, e.g. pi_3Q0abc... (from the Stripe dashboard)' },
};

/**
 * Validates a payment against the sale total and the store's accepted methods.
 * Returns the payment as stored: { method, tenderedCents, changeCents, reference, brand }
 * (+ cardReference, the v2.0-v2.3 name of reference, for older clients).
 */
function settlePayment(payment, totalCents, enabled) {
  const method = payment?.method;
  if (!METHODS.includes(method)) throw invalid(`payment.method must be one of: ${METHODS.join(', ')}`);
  if (!accepts(enabled, method)) throw invalid(`${LABELS[method]} is not accepted by this store (Business → Payment methods)`);
  if (method === 'cash') {
    const t = payment.tenderedCents;
    if (!Number.isInteger(t) || t < totalCents) throw invalid('cash tendered must be an integer number of cents >= total');
    return { method, tenderedCents: t, changeCents: t - totalCents, reference: null, cardReference: null, brand: null };
  }
  const rule = REFERENCE[isCard(method) ? 'card' : method];
  const reference = String(payment.reference ?? '').trim();
  if (!rule.re.test(reference)) throw invalid(`${LABELS[method]} payments need ${rule.hint}`);
  let brand = null;
  if (method === 'debit') brand = 'interac';
  if (method === 'credit' && payment.brand != null && payment.brand !== '') {
    brand = String(payment.brand).toLowerCase();
    if (!CARD_BRANDS.includes(brand)) throw invalid(`brand must be one of: ${CARD_BRANDS.join(', ')}`);
  }
  return { method, tenderedCents: null, changeCents: null, reference, cardReference: reference, brand };
}

/** What the person refunding has to do to give the money back. */
function refundInstruction(payment) {
  const ref = payment?.reference ?? payment?.cardReference;
  switch (payment?.method) {
    case 'cash':
      return 'Give the customer this amount in cash from the drawer.';
    case 'etransfer':
      return `Send this amount back to the customer by Interac e-Transfer (original reference ${ref}).`;
    case 'stripe':
      return `Refund this amount in the Stripe dashboard (payment ${ref}).`;
    default:
      return `Reverse this amount on the card terminal (original approval ${ref}).`;
  }
}

module.exports = { METHODS, LABELS, CARD_BRANDS, legacyMethod, accepts, settlePayment, refundInstruction };
