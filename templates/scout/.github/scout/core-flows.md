# Core flows

The journeys this product cannot ship broken. Scout tests any of these that a PR's diff touches, and its
regression runs test all of them. When a flow has a committed spec under `e2e/scout/core/`, Scout runs
that spec instead of writing a new one. Keep the list short: five to fifteen rows.

| Flow | Where | Happy path | Committed spec |
| --- | --- | --- | --- |
| The app loads | `/` | The home page answers and shows its heading | `core/smoke.spec.ts` |
| Sign in | `/login` | TODO: the seeded user signs in and sees what a signed-in person sees | `core/smoke.spec.ts` |
| TODO: your most important journey | TODO | TODO: what a user does and what they should see | |
