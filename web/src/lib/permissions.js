// Copy of app/src/domain/permissions.js, used only to decide which screens to
// show. The API enforces every permission on its own.
export const ROLES = ['admin', 'manager', 'cashier', 'sales', 'procurement', 'support'];
export const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  sales: 'Sales',
  procurement: 'Procurement',
  support: 'Customer support',
};
const ALL = ROLES;
const PERMISSIONS = {
  'sales.create': ['admin', 'manager', 'cashier', 'sales'],
  'sales.view': ALL,
  'refunds.create': ['admin', 'manager', 'support'],
  'refunds.override': ['admin', 'manager'],
  'products.view': ALL,
  'products.manage': ['admin', 'manager', 'procurement'],
  'categories.manage': ['admin', 'manager', 'procurement'],
  'promotions.manage': ['admin', 'manager', 'sales'],
  'reports.view': ['admin', 'manager', 'sales'],
  'staff.manage': ['admin', 'manager'],
  'store.settings': ['admin', 'manager'],
  'business.profile': ['admin'],
  'store.delete': ['admin'],
};

/** user.permissions comes from the API (v2.3+); the role table is the fallback. */
export function can(user, permission) {
  if (Array.isArray(user?.permissions)) return user.permissions.includes(permission);
  return (PERMISSIONS[permission] || []).includes(user?.role);
}

export function assignableRoles(role) {
  if (role === 'admin') return ROLES;
  if (role === 'manager') return ROLES.filter((r) => r !== 'admin');
  return [];
}
