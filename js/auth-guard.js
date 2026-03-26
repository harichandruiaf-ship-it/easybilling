/**
 * Central place for “must be signed in” checks used by the hash router.
 * All invoice-related screens require an authenticated Firebase user.
 */

export function shouldForceLoginView(user) {
  return !user;
}

export function canAccessInvoice(user, invoiceUserId) {
  return Boolean(user && invoiceUserId && user.uid === invoiceUserId);
}
