'use strict';

// Roles and permissions (v2.3). Each API route asks for one capability; each
// role has a fixed set. The browser has a copy of this table only to decide
// which screens to show (web/src/lib/permissions.js) - the API always decides.

const ROLES = ['admin', 'manager', 'cashier', 'sales', 'procurement', 'support'];

const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  sales: 'Sales',
  procurement: 'Procurement',
  support: 'Customer support',
};

const ALL = ROLES;
const PERMISSIONS = {
  'sales.create': ['admin', 'manager', 'cashier', 'sales'], // ring up sales at the register
  'sales.view': ALL, // sales list and receipts
  'refunds.create': ['admin', 'manager', 'support'], // refunds within the store policy
  'refunds.override': ['admin', 'manager'], // refunds outside the policy, with a reason
  'products.view': ALL, // the catalogue (active products)
  'products.manage': ['admin', 'manager', 'procurement'], // add/edit/import products, stock, barcodes, expiry, prices
  'categories.manage': ['admin', 'manager', 'procurement'],
  'promotions.manage': ['admin', 'manager', 'sales'],
  'reports.view': ['admin', 'manager', 'sales'],
  'staff.manage': ['admin', 'manager'],
  'store.settings': ['admin', 'manager'], // refund window
  'business.profile': ['admin'], // legal name, tax numbers, bank, payment methods
  'store.delete': ['admin'],
};

function can(role, permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) throw new Error(`unknown permission ${permission}`);
  return allowed.includes(role);
}

function permissionsOf(role) {
  return Object.keys(PERMISSIONS).filter((p) => PERMISSIONS[p].includes(role));
}

/** Which roles a user with `role` may give to (or take from) other staff. */
function assignableRoles(role) {
  if (role === 'admin') return ROLES;
  if (role === 'manager') return ROLES.filter((r) => r !== 'admin');
  return [];
}

module.exports = { ROLES, ROLE_LABELS, PERMISSIONS, can, permissionsOf, assignableRoles };
