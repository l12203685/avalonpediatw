/**
 * AdminService — manages the admin email whitelist stored in Firestore.
 *
 * Firestore path: config/admins
 * Doc shape:      { emails: string[] }
 *
 * Seed on first boot with l12203685@gmail.com + avalonpediatw@gmail.com,
 * unless the doc already exists with its own list.
 */

import { getAdminFirestore } from './firebase';

const SEED_ADMIN_EMAILS: ReadonlyArray<string> = [
  'l12203685@gmail.com',
  'avalonpediatw@gmail.com',
];

const CONFIG_COLLECTION = 'config';
const ADMINS_DOC_ID = 'admins';

interface AdminsDoc {
  emails: string[];
}

function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * Ensure the admins doc exists. Creates it with the seed list if missing.
 * Safe to call repeatedly (idempotent).
 */
export async function ensureAdminsSeed(): Promise<void> {
  try {
    const firestore = getAdminFirestore();
    const ref = firestore.collection(CONFIG_COLLECTION).doc(ADMINS_DOC_ID);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({ emails: [...SEED_ADMIN_EMAILS] });
      console.log(`[admin-service] seeded config/admins with ${SEED_ADMIN_EMAILS.length} email(s)`);
      return;
    }

    const data = snap.data() as Partial<AdminsDoc> | undefined;
    const existing = Array.isArray(data?.emails) ? data!.emails : [];
    const existingNorm = new Set(existing.map(normalizeEmail));

    // Top-up: add any seed email that's missing, but don't touch extras admins
    // added by users. This guarantees the boot-time guarantee Edward asked for.
    const missing = SEED_ADMIN_EMAILS.filter(e => !existingNorm.has(normalizeEmail(e)));
    if (missing.length > 0) {
      await ref.update({ emails: [...existing, ...missing] });
      console.log(`[admin-service] topped up config/admins with ${missing.join(', ')}`);
    }
  } catch (err) {
    console.error('[admin-service] ensureAdminsSeed failed:', err);
  }
}

/**
 * Load the admin email whitelist. Returns an empty list on error.
 */
export async function listAdmins(): Promise<string[]> {
  try {
    const firestore = getAdminFirestore();
    const snap = await firestore.collection(CONFIG_COLLECTION).doc(ADMINS_DOC_ID).get();
    if (!snap.exists) return [];
    const data = snap.data() as Partial<AdminsDoc> | undefined;
    return Array.isArray(data?.emails) ? [...data!.emails] : [];
  } catch (err) {
    console.error('[admin-service] listAdmins failed:', err);
    return [];
  }
}

/**
 * Check whether the given email is on the admin whitelist. Case-insensitive.
 */
export async function isAdmin(email: string | null | undefined): Promise<boolean> {
  const e = normalizeEmail(email);
  if (!e) return false;
  const admins = await listAdmins();
  return admins.some(a => normalizeEmail(a) === e);
}

/**
 * Add a new admin email. Returns the updated list (normalized, de-duped).
 * Idempotent — adding an existing email is a no-op.
 */
export async function addAdmin(email: string): Promise<string[]> {
  const target = normalizeEmail(email);
  if (!target) throw new Error('Invalid email');

  const firestore = getAdminFirestore();
  const ref = firestore.collection(CONFIG_COLLECTION).doc(ADMINS_DOC_ID);
  const snap = await ref.get();
  const existing: string[] = snap.exists
    ? (Array.isArray((snap.data() as Partial<AdminsDoc>).emails)
        ? (snap.data() as AdminsDoc).emails
        : [])
    : [];
  const existingNorm = new Set(existing.map(normalizeEmail));
  if (existingNorm.has(target)) return existing;

  const updated = [...existing, target];
  if (snap.exists) {
    await ref.update({ emails: updated });
  } else {
    await ref.set({ emails: updated });
  }
  return updated;
}

/**
 * Remove an admin email. Returns the updated list.
 * Throws when removing would leave the list empty (safety net — never lock
 * everyone out).
 */
export async function removeAdmin(email: string): Promise<string[]> {
  const target = normalizeEmail(email);
  if (!target) throw new Error('Invalid email');

  const firestore = getAdminFirestore();
  const ref = firestore.collection(CONFIG_COLLECTION).doc(ADMINS_DOC_ID);
  const snap = await ref.get();
  if (!snap.exists) return [];
  const existing: string[] = Array.isArray((snap.data() as Partial<AdminsDoc>).emails)
    ? (snap.data() as AdminsDoc).emails
    : [];
  const updated = existing.filter(e => normalizeEmail(e) !== target);

  if (updated.length === 0) {
    throw new Error('Cannot remove the last admin');
  }

  await ref.update({ emails: updated });
  return updated;
}

export function getSeedAdminEmails(): ReadonlyArray<string> {
  return SEED_ADMIN_EMAILS;
}
