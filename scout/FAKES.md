# Fake services

A fake stands in for a third party the app calls (Nylas, Stripe, Twilio, a partner's API) while Scout
tests it. The app is started with the fake's address and dummy keys in its environment, calls the fake
the way it would call the real service, and gets answers shaped like the real ones. No real key is
involved and the real hosts are blocked, so nothing is booked, charged or sent.

One generic server (`.crew/scripts/scout/fakes.mjs`) runs every fake, each on its own local port. A fake
is one JSON definition and nothing else: there is no code to add to the crew for a new service.

## Where a definition lives

- **Agent HQ, the Fakes page.** Radar drafts it from how the code calls the service; a person can change
  anything there. Scout's run pulls the repo's fakes before it starts the app.
- **The repo, `.github/scout/fakes/<name>.json`.** Replaces HQ's whole definition of that name on the
  branch that has it, so a pull request that changes how the app calls a service changes its fake in the
  same PR. `"enabled": false` in such a file switches that fake off on the branch. A repo with no HQ uses
  only these files.

## The definition

```json
{
  "name": "nylas",
  "title": "Nylas",
  "about": "Booking and rescheduling appointments on a shop's calendar.",
  "hosts": ["api.us.nylas.com"],
  "env": {
    "NYLAS_API_URL": "${URL}",
    "NEXT_PUBLIC_NYLAS_API_URL": "${URL}",
    "NYLAS_ACCESS_TOKEN": "fake-nylas-key",
    "NYLAS_GRANT_ID": "fake-grant"
  },
  "state": { "bookings": {} },
  "routes": [
    {
      "method": "GET",
      "path": "/v3/grants/:grantId/calendars",
      "note": "src/services/calendar.ts: the calendar picker",
      "status": 200,
      "body": { "request_id": "{{uuid}}", "data": [{ "id": "primary", "grant_id": "{{params.grantId}}", "name": "Shop" }] }
    },
    {
      "method": "POST",
      "path": "/v3/scheduling/bookings",
      "note": "the booking form's submit",
      "handler": "const id = util.id(); state.bookings[id] = { booking_id: id, event_id: 'evt_' + id, status: 'booked', ...req.body }; util.webhook('booking.created', state.bookings[id]); return { status: 200, body: { request_id: util.uuid(), data: state.bookings[id] } };"
    },
    {
      "method": "GET",
      "path": "/v3/scheduling/bookings/:id",
      "handler": "const b = state.bookings[req.params.id]; return b ? { body: { data: b } } : { status: 404, body: { error: { type: 'not_found_error', message: 'Booking not found' } } };"
    }
  ],
  "webhooks": [
    { "name": "booking.created", "path": "/api/webhooks/nylas", "headers": { "x-nylas-signature": "fake" }, "body": { "type": "booking.created", "data": { "object": "{{payload}}" } } }
  ],
  "needs": [
    { "file": "src/app/api/nylas/events/route.ts", "line": 4, "change": "Read the API address from NYLAS_API_URL (default https://api.us.nylas.com) instead of the constant." }
  ]
}
```

| Field | What it is |
| --- | --- |
| `name` | A slug: lower-case letters, digits, dashes. The file name and the fake's identity. |
| `title`, `about` | For people: the service's name and what the app uses it for. |
| `hosts` | The real hostnames the fake replaces. They are blocked on CI, so a call that slips past the fake fails instead of reaching the service. Hostnames only. |
| `env` | Variables set for the app, after the repo's own `scout.env`. `${URL}` is the fake's address (`http://localhost:4600`), `${HOST}` is `localhost:4600`, `${PORT}` the port, `${APP_URL}` the app under test. Values are plain characters: no spaces or quotes. Keys are dummies, never real ones. |
| `state` | What the fake remembers, at the start of a run. Handlers read and change it. |
| `routes` | What the fake answers, first match wins. |
| `webhooks` | Calls the fake can make to the app: a webhook, a callback. |
| `needs` | Changes the app needs before it can use the fake at all, usually an address read from the environment instead of a constant. Each names a file and the change. Empty when the app is ready. |

### Routes

`method` is `GET`, `POST`, `PUT`, `PATCH`, `DELETE` or `ANY`. `path` starts with `/`; `:name` matches
one segment and `*` at the end matches the rest (`params["*"]`). A route answers in one of two ways:

- **A template**: `status` (200 when left out), `headers` and `body`. Any string may hold `{{…}}`:

  | In a template | Becomes |
  | --- | --- |
  | `{{params.id}}`, `{{query.limit}}`, `{{body.customer.email}}`, `{{headers.authorization}}` | Parts of the request. JSON and form-encoded bodies are parsed. |
  | `{{state.bookings}}` | The fake's state. |
  | `{{uuid}}`, `{{id}}` | A new UUID; a new 12-character id. |
  | `{{now}}`, `{{unix}}`, `{{unixms}}`, `{{date}}` | The time, as ISO text, seconds, milliseconds, or `YYYY-MM-DD`. Add offsets: `{{now+1d}}`, `{{unix+2h-30m}}` (`s`, `m`, `h`, `d`). |
  | `{{env.URL}}`, `{{env.APP_URL}}` | The fake's address and the app's. |

  A string that is one whole expression keeps its type (`"{{unix}}"` is a number). A redirect is a
  template too: `"status": 302, "headers": { "location": "{{query.redirect_uri}}?code=fake-code&state={{query.state}}" }`.

- **A handler**: JavaScript, the body of an async function with `req`, `state` and `util`. Use it when
  the answer depends on what came before (create, then read back) or on the clock (slots for the next
  seven days). It returns `{ status?, headers?, body? }`.
  - `req`: `{ method, path, params, query, headers, body }`.
  - `state`: the fake's memory; change it in place.
  - `util.uuid()`, `util.id()`, `util.time('unix+1d')` (the template words), `util.hmac('sha256', secret, text)`,
    `util.webhook(name, payload)` (sends one of the fake's webhooks after this response),
    `util.callApp(path, init)` (any other call to the app), `util.url`, `util.appUrl`.

A call that matches no route gets `501` and `{ "error": "The nylas fake has no route for GET /v3/x" }`.
That is on purpose: it is how you learn what the fake still needs.

### Webhooks

`name`, `path` (on the app, starting with `/`), optional `method` (POST), `headers` and `body`, which are
templates with `{{payload…}}` (what the sender passed) and `{{state…}}`. With no `body`, the payload is
sent as it is. When the app checks a signature, give the webhook a `handler` instead (`req.payload`,
`state`, `util`), returning `{ headers, body }`, and sign with `util.hmac` and a dummy secret set in `env`.

## Using a fake from a test

Each fake has controls under `/__fake/` on its own address (the addresses are in
`scout-out/fakes/plan.json`):

| Call | Does |
| --- | --- |
| `GET /__fake/requests` | Every call the app made to this fake, and every webhook it sent, with status. |
| `POST /__fake/webhooks/<name>` with a JSON payload | Sends that webhook to the app now; answers with the app's status. |
| `GET /__fake/state`, `PUT /__fake/state` | Reads or replaces what the fake remembers (seed a booking before a flow). |
| `POST /__fake/reset` | Back to the definition's `state`, with the request list emptied. |

The same calls, for every fake, are appended to `scout-out/fakes/requests.ndjson`.

## Checking a definition

`node .crew/scripts/scout/fakes.mjs check <file>` says what is wrong with one, or what it holds.
