# Tickety API

Fastify REST API: the server side of Tickety, for all four clients — the
customer app (`ticketycustomer`), the door scanner (`ticketyscanner`), the
admin panel (`ticketyadmin`) and the organiser dashboard (`ticketydash`).

It holds two different kinds of operation, and they are guarded differently.

**What a client cannot be trusted to do itself** — listing customers, managing
the catalogue, minting door and organiser accounts, granting roles, stopping a
ticket, reporting on sales and attendance. Guarded by `requireRole`: the `role`
claim on the token decides.

**What a client may only do to its own account** — read your profile, your
orders, the seats you hold and the QR payload each one encodes. Everything
under `/v1/me`, guarded by nothing but a valid token, because the uid inside it
*is* the scope. No path under `/me` takes a user id, so there is no parameter
to tamper with.

The two Flutter apps still call the `placeOrder`, `redeemTicket`, `gateStats`
and `closeAccount` Cloud Functions for every write. Reads are what moved here
first; see [Migrating the Flutter clients](#migrating-the-flutter-clients).

## Why these live on a server

Firestore rules deliberately deny things a browser might want to do:

| Operation | Why a client cannot do it |
|---|---|
| List all customers | Rules let a customer read only their own `Users` document. The admin panel's `getDocs(collection(db,'Users'))` was denied, so its table silently rendered empty. |
| Read the guest list | `IssuedTickets` is denied to every client, because each document holds the ticket `secret` and a leaked secret is a working ticket. The API strips it. |
| Create a scanner account | Setting a custom claim requires the Admin SDK. The old browser flow could not, so every account it created was unable to scan. |
| Grant or revoke a role | Same — and a client that could set its own claims would have no security model at all. |
| Look up any order | Orders live at `Users/{uid}/Orders/{id}`, and rules let a customer read only their own. Reading across customers is a collection-group query no client is allowed to make, so support had no way to find the order behind a payment complaint. |
| Stop a single ticket | Writing `IssuedTickets` is denied to every client. Marking one `void` is what takes a stolen or charged-back ticket out of circulation — every door refuses anything whose status is not `valid`. |

## Roles

One `role` custom claim, set only by this API.

| Role | Can |
|---|---|
| `admin` | Everything, including granting roles and deleting accounts. |
| `organiser` | Manage their own events, their own scanners, and see their own sales. Scoped by `orgId`. |
| `scanner` | List events, read attendance, look up one scanned ticket. Redemption itself goes through the `redeemTicket` Cloud Function. |
| _(none)_ | An ordinary customer. The catalogue, and their own account under `/v1/me`. |

A customer has no role, which is why `requireRole` is not the only guard in the
API. Two groups of routes ask for a token and no claim at all: `/v1/me/*`, and
reading the catalogue — `firestore.rules` already grants every signed-in
account `read` on `Tickets`, because that is the shop window.

A legacy `staff: true` claim is emitted alongside `role` so that the deployed
Cloud Functions and current `firestore.rules` — which both test `staff === true`
— keep working during the migration. A token carrying only `staff` is read as
`scanner`: the least-privileged role, so an old token keeps doors working
without granting catalogue access.

## The one place a ticket secret is served

Every response schema in this API exists partly to stop the ticket `secret`
escaping: Fastify serialises only declared properties, and no staff route
declares it. `GET /v1/me/tickets` and `GET /v1/me/tickets/{id}` are the single
exception, and they serve it as `qrPayload` — `TKT1:<ticketId>:<secret>`, ready
to draw — to the account named on the ticket itself.

That is not a new exposure. `firestore.rules` already lets a customer read
their own `IssuedTickets` documents, because without the secret there is no QR
to show at the door. What changes is who owns the *format*: the payload is
assembled server-side, so a `TKT2` can ship without an app release. A ticket
belonging to another account answers `404`, never `403` — a `403` would confirm
the id exists, and the id is the half of the payload that can be read off a
screen.

Staff never get it. `GET /v1/tickets/{id}` returns status and the admission
trail with no secret in it at all, which is what a door needs to explain a
refused scan ("admitted at 20:14") to the person standing in front of it. The
guest list at `/v1/reports/events/{id}/attendees` stays off the scanner role:
one ticket in answer to a scan is not a list of who is coming.

## Migrating the Flutter clients

Reads moved first, writes have not moved at all. The apps are shipped binaries
that cannot be force-updated, so both paths stay live until the installed base
turns over.

| Client call today | Replacement | Status |
|---|---|---|
| `Users/{uid}/Orders` query | `GET /v1/me/orders` | Available |
| `IssuedTickets where userId ==` | `GET /v1/me/tickets` | Available |
| `Users/{uid}` read | `GET /v1/me` | Available |
| `Users/{uid}` write | — | Not ported; rules already allow a customer to edit their own profile |
| `Tickets` collection read | `GET /v1/events` | Available |
| `gateStats` callable | `GET /v1/reports/events/{id}/attendance` | Available |
| `placeOrder` callable | — | Still the only writer of orders, tickets and stock |
| `redeemTicket` callable | — | Still the only thing that admits a seat |
| `closeAccount` callable | — | Not ported |

Nothing here is blocked by security rules the way the admin panel's customer
list was: a customer can already read all of their own data from the device.
What the `/me` routes buy is that the storage layout — `Users/{uid}/Orders`,
`IssuedTickets where userId ==`, `TKT1:$id:$secret` — stops being compiled into
a phone. The next change to any of it ships from the server.

The three write callables are deliberately untouched. They hold the money and
the turnstile: pricing, tax by region, idempotency keys, 32-byte secret
minting, and a Firestore transaction that decrements stock and mints seats
together. Porting them is its own piece of work, with the old callables left
deployed throughout.

## Running it

Credentials come from Application Default Credentials. There is no key file.

```bash
gcloud auth application-default login
```

```bash
cp .env.example .env && npm install && npm run dev
```

Interactive docs, generated from the route schemas rather than a hand-written
spec: <http://localhost:3002/docs>

```bash
npm test
```

## Conventions

- **Versioned**: everything lives under `/v1`. The mobile clients cannot be
  force-updated, so two versions will eventually be live at once.
- **Errors** are RFC 9457 `application/problem+json` with a stable `type` URI,
  so clients branch on a machine-readable value rather than on a sentence.
  5xx responses never carry their message; the `requestId` is quotable instead.
- **Pagination** is cursor-based. An offset re-reads every skipped document and
  shifts under you when a row is inserted.
- **Response schemas** are declared on every route. Fastify serialises only
  declared properties, which is the last line of defence against a field like
  `secret` escaping.
- **Auth runs in `onRequest`**, before body parsing, so an anonymous caller gets
  `401` rather than a `400` that reveals the schema.
- **Hook order is deliberate.** Three things run before any handler, in this
  order: the auth plugin identifies the caller if it can and refuses nobody;
  the rate limiter counts the request; then the route's own guard decides
  whether to allow it. Identification has to come first so the limiter can key
  on an account rather than an address, and the limiter has to come before the
  guard or the traffic a guard rejects would never be counted. Both are
  application-level hooks for that reason — route-level hooks, which is how
  every guard is attached, run last.

## Deploying

```bash
gcloud run deploy tickety-api --source . --region us-central1 --no-allow-unauthenticated
```

The runtime service account needs `roles/datastore.user` and
`roles/firebaseauth.admin`. Set `CORS_ORIGINS` to the deployed web origins —
the server refuses to start in production without it.

## Outstanding

- `firebase-admin.json` is still present and should be **deleted and its key
  rotated**. It sat in an un-gitignored folder and grants full admin access.
- The `Orders` collection-group index is written (`CustomerApp/ticketycustomer/firestore.indexes.json`,
  as a `fieldOverrides` entry giving `orderDate` COLLECTION_GROUP scope) but is
  **not yet deployed**. `/v1/orders` and a `since`-filtered `/v1/reports/sales`
  fail until it is: `firebase deploy --only firestore:indexes`.
- `firestore.rules` still tests `staff`; it should move to `role` once every
  client is issuing new tokens.
- The write path is still split. `placeOrder`, `redeemTicket` and
  `closeAccount` speak the callable protocol (`{data: …}`, `HttpsError`) while
  everything here speaks `problem+json`, so the Flutter apps handle two error
  shapes. See [Migrating the Flutter clients](#migrating-the-flutter-clients).
- `CORS_ORIGINS` covers the two React apps only. The Flutter clients are
  native and send no `Origin`, so they are unaffected — but a Flutter **web**
  build would need its origin added.
- Everything shares one limit: 300 requests per minute, per account or per
  address. A door scanning a queue and an anonymous prober are held to the
  same figure, which is generous for the second. Splitting them is easy — the
  limiter takes a function for `max` — but worth measuring real traffic first.
