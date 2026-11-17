/**
 * Shared seeding helpers for Scout. Import these from a seed script instead of talking to Firestore
 * directly; the guard below is what keeps a seed run off real data.
 *
 *   import { db, ensureUser, SCOUT, Timestamp } from '../../scripts/scout/fixtures.mjs';
 *   await db.collection('things').doc('scout-thing-1').set({ owner: SCOUT.userEmail, createdAt: Timestamp.now() });
 *
 * Needs `firebase-admin` in the repo's dependencies.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '';

// Refuse to run unless every write is going to an emulator on a demo project. `demo-` projects are
// emulator-only by Firebase's design, so even a missing emulator host cannot reach a real database.
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST || !projectId.startsWith('demo-')) {
  console.error(
    '[ScoutFixtures] Refusing to seed. Need FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST and a demo-* ' +
      `NEXT_PUBLIC_FIREBASE_PROJECT_ID (got "${projectId}").`,
  );
  process.exit(1);
}

if (!getApps().length) initializeApp({ projectId });

export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
export const auth = getAuth();
export { Timestamp };

/** Accounts and ids the base seed creates. Specs import the same values from `e2e/scout/_support/scout.ts`. */
export const SCOUT = {
  password: 'scout-password-123',
  userEmail: 'user@scout.test',
};

/** Creates the Auth emulator user if it does not exist yet. */
export async function ensureUser(email, password = SCOUT.password) {
  try {
    return await auth.getUserByEmail(email);
  } catch {
    return auth.createUser({ email, password, emailVerified: true });
  }
}
