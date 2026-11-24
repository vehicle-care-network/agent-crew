/**
 * Prints the title of every flow in the recorded run that failed only because the app under test wasn't
 * answering (results.mjs, `unreachable`), one per line; nothing when there are none. record.sh reads it
 * to decide whether the run says anything about the code.
 *
 * Env: SCOUT_OUT, SCOUT_BASE_URL.
 */
import { loadTests, unreachable } from './results.mjs';

const out = process.env.SCOUT_OUT || 'scout-out';
for (const row of unreachable(loadTests(out) ?? [], process.env.SCOUT_BASE_URL || '')) console.log(row.title);
