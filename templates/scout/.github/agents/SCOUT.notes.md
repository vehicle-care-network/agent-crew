<!-- This repo's additions to Scout's brief. Short and concrete: Scout reads this on every run. -->

- **Accounts.** The base seed (`scripts/scout/seed.mjs`) creates `user@scout.test` (password in `SCOUT.password`).
  Sign in with `loginAs(page)` from `e2e/scout/_support/scout.ts`. TODO: list every seeded account and what it can see.
- **Seeded data.** TODO: what the base seed creates, with the ids and titles specs can rely on.
- **What can't be tested here.** No third-party keys exist, so TODO: name the integrations that fail (payments,
  email, SMS) and what a spec should assert instead (the request was made, the error is shown).
