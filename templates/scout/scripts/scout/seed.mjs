/**
 * Base seed for Scout: the accounts and the little data every flow starts from. It runs once, after the
 * emulators start and before the app does. Data for one flow is seeded by the scripts Scout writes under
 * `e2e/scout/_seed/`. Keep document shapes in step with the app's own models.
 */
import { db, ensureUser, SCOUT } from './fixtures.mjs';

await ensureUser(SCOUT.userEmail);

// TODO: the documents a signed-in user needs to see a working app, for example:
// await db.collection('users').doc(SCOUT.userEmail).set({ email: SCOUT.userEmail, role: 'member' });
void db;

console.log('[ScoutSeed] Seeded the base data');
