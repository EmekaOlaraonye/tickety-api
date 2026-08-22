# Tickety API

Fastify REST API holding every operation the Tickety clients cannot be trusted
to do themselves: listing customers, managing the event catalogue, minting door
and organiser accounts, granting roles, and reporting on sales and attendance.

It backs the two React apps — **AdminPanel** (`ticketyadmin`) and
**EventDashboard** (`ticketydash`). The two Flutter apps continue to reach
Firebase directly and to call the `placeOrder`, `redeemTicket` and `gateStats`
Cloud Functions.

## Why these live on a server

Firestore rules deliberately deny things a browser might want to do:

| Operation | Why a client cannot do it |
|---|---|
| List all customers | Rules let a customer read only their own `Users` document. The admin panel's `getDocs(collection(db,'Users'))` was denied, so its table silently rendered empty. |
| Read the guest list | `IssuedTickets` is denied to every client, because each document holds the ticket `secret` and a leaked secret is a working ticket. The API strips it. |
| Create a scanner account | Setting a custom claim requires the Admin SDK. The old browser flow could not, so every account it created was unable to scan. |
| Grant or revoke a role | Same — and a client that could set its own claims would have no security model at all. |

## Roles

One `role` custom claim, set only by this API.

| Role | Can |
|---|---|
| `admin` | Everything, including granting roles and deleting accounts. |
| `organiser` | Manage their own events, their own scanners, and see their own sales. Scoped by `orgId`. |
| `scanner` | List events, read attendance. Redemption itself goes through the `redeemTicket` Cloud Function. |
| _(none)_ | An ordinary customer. No access to this API. |

A legacy `staff: true` claim is emitted alongside `role` so that the deployed
Cloud Functions and current `firestore.rules` — which both test `staff === true`
— keep working during the migration. A token carrying only `staff` is read as
`scanner`: the least-privileged role, so an old token keeps doors working
without granting catalogue access.

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
- The `Orders` collection-group index must be deployed for `/v1/reports/sales`.
- `firestore.rules` still tests `staff`; it should move to `role` once every
  client is issuing new tokens.
