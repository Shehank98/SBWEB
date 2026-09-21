export function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ORD-<5 digits>. Uniqueness is enforced per business by a DB constraint;
// callers retry on the rare collision.
export function orderCode() {
  return 'ORD-' + Math.floor(10000 + Math.random() * 90000);
}
