import { randomBytes } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';

import { auth, db, COLLECTIONS, stripUndefined } from '../lib/firebase.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { ROLES, claimsFor, customerClaims, roleFromToken } from '../lib/roles.js';

/**
 * Creating and managing privileged accounts.
 *
 * This exists because the browser cannot do any of it safely, and the version
 * that tried is worth spelling out. `AddScanners.js`:
 *
 *   1. Derived the new account's password from its email — `username +
 *      'Tickety123*'` — so knowing a door account's address was knowing its
 *      password.
 *   2. Signed the *administrator* out, because the client SDK's
 *      `createUserWithEmailAndPassword` signs in as whoever it just created.
 *   3. Tried to sign the admin back in from two variables that were never
 *      assigned, leaving them logged out with no route back.
 *   4. Could not set a custom claim at all, so every account it made was
 *      unable to actually scan anything.
 *
 * Server-side, all four problems disappear: the Admin SDK creates a user
 * without touching the caller's session, the password is never chosen by us,
 * and the role claim is set in the same operation.
 */

/** Collection holding a privileged account's profile, keyed by uid. */
const PROFILES = 'StaffAccounts';

const profiles = () => db.collection(PROFILES);

/**
 * A password nobody knows.
 *
 * The account is created with random bytes and the value is discarded — it is
 * never logged, stored, or returned. The holder sets their own password
 * through the reset link, so no password ever passes through this API, the
 * admin panel, or an email we compose.
 */
function throwawayPassword() {
  return `${randomBytes(24).toString('base64url')}A1!`;
}

function toResource(record, profile = {}) {
  return {
    uid: record.uid,
    email: record.email ?? null,
    displayName: record.displayName ?? null,
    role: roleFromToken(record.customClaims ?? {}),
    orgId: record.customClaims?.orgId ?? null,
    disabled: record.disabled === true,
    lastSignInAt: record.metadata?.lastSignInTime
      ? new Date(record.metadata.lastSignInTime).toISOString()
      : null,
    createdAt: record.metadata?.creationTime
      ? new Date(record.metadata.creationTime).toISOString()
      : null,
    phoneNumber: profile.phoneNumber ?? null,
    notes: profile.notes ?? null,
  };
}

/**
 * Creates a privileged account and returns a link for the holder to set their
 * own password.
 *
 * The link is returned to the caller rather than emailed from here so the admin
 * panel can show it, copy it, or hand it over in person — a door supervisor
 * setting up ten scanner phones at 7pm should not be waiting on inboxes.
 */
export async function createAccount({
  email,
  displayName,
  role,
  orgId = null,
  phoneNumber = null,
  notes = null,
}) {
  if (role === ROLES.ADMIN) {
    // Deliberately not creatable through the API. An admin is created by
    // promoting an existing account, which requires an existing admin — so
    // there is no path that mints platform-level access from nothing.
    throw badRequest('Admin accounts are granted by promotion, not created.');
  }
  if (role === ROLES.ORGANISER && !orgId) {
    throw badRequest('An organiser needs an orgId to scope their events.');
  }

  let record;
  try {
    record = await auth.createUser({
      email,
      displayName: displayName || undefined,
      password: throwawayPassword(),
      emailVerified: false,
      disabled: false,
    });
  } catch (error) {
    if (error?.code === 'auth/email-already-exists') {
      throw conflict(
        'That email already has an account. Change its role instead of ' +
          'creating a second one.'
      );
    }
    throw error;
  }

  await auth.setCustomUserClaims(record.uid, claimsFor(role, { orgId }));

  await profiles().doc(record.uid).set(
    stripUndefined({
      email,
      displayName: displayName ?? null,
      role,
      orgId: role === ROLES.ORGANISER ? orgId : null,
      phoneNumber,
      notes,
      createdAt: FieldValue.serverTimestamp(),
    })
  );

  const setPasswordLink = await auth.generatePasswordResetLink(email);
  const fresh = await auth.getUser(record.uid);

  return { account: toResource(fresh), setPasswordLink };
}

/** Lists accounts holding a given role. */
export async function listAccounts({ role, orgId = null, limit = 100 } = {}) {
  // `listUsers` pages at 1000 and has no server-side claim filter, so the role
  // test happens here. Fine at the scale of staff accounts; if this ever grows
  // past a few thousand, the profile collection becomes the index instead.
  const items = [];
  let pageToken;

  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const record of page.users) {
      const claims = record.customClaims ?? {};
      if (roleFromToken(claims) !== role) continue;
      if (orgId && claims.orgId !== orgId) continue;
      items.push(toResource(record));
      if (items.length >= limit) break;
    }
    pageToken = items.length >= limit ? undefined : page.pageToken;
  } while (pageToken);

  return { items, nextCursor: null, total: items.length };
}

export async function getAccount(uid) {
  let record;
  try {
    record = await auth.getUser(uid);
  } catch (error) {
    if (error?.code === 'auth/user-not-found') throw notFound('No such account.');
    throw error;
  }

  const profile = await profiles().doc(uid).get();
  return toResource(record, profile.data() ?? {});
}

/**
 * Changes an account's role.
 *
 * Revoking refresh tokens is the important half. A custom claim is baked into
 * the ID token at issue time, so without this a demoted organiser keeps full
 * access for up to an hour — the exact window in which you are demoting them
 * because you no longer trust them.
 */
export async function setRole(uid, { role, orgId = null }) {
  await getAccount(uid);

  const claims = role === null ? customerClaims() : claimsFor(role, { orgId });
  await auth.setCustomUserClaims(uid, claims);
  await auth.revokeRefreshTokens(uid);

  await profiles()
    .doc(uid)
    .set(
      { role, orgId: claims.orgId ?? null, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

  return getAccount(uid);
}

/**
 * Suspends or restores an account.
 *
 * Preferred over deletion for a door account that has gone missing: disabling
 * stops it immediately and keeps the audit trail of what it admitted, whereas
 * deleting the user leaves `redeemedBy` pointing at a uid nobody can resolve.
 */
export async function setDisabled(uid, disabled) {
  await getAccount(uid);
  await auth.updateUser(uid, { disabled });
  if (disabled) await auth.revokeRefreshTokens(uid);
  return getAccount(uid);
}

export async function deleteAccount(uid) {
  await getAccount(uid);
  await auth.deleteUser(uid);
  await profiles().doc(uid).delete();
}

/** A one-time link letting the holder set their own password. */
export async function passwordResetLink(uid) {
  const account = await getAccount(uid);
  if (!account.email) throw badRequest('That account has no email address.');
  return auth.generatePasswordResetLink(account.email);
}

/**
 * Customer accounts.
 *
 * Read from `Users`, which the Admin SDK can list. The admin panel tried this
 * from the browser with `getDocs(collection(db, 'Users'))`; rules allow a
 * customer to read only their own document, so that call was denied and the
 * table silently rendered empty.
 */
export async function listCustomers({ limit = 25, cursor = null } = {}) {
  let query = db.collection(COLLECTIONS.users).orderBy('__name__').limit(limit + 1);
  if (cursor) query = query.startAfter(cursor);

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, limit);

  return {
    items: docs.map((doc) => {
      const data = doc.data() ?? {};
      return {
        id: doc.id,
        firstName: data.FirstName ?? '',
        lastName: data.LastName ?? '',
        email: data.Email ?? '',
        phoneNumber: data.PhoneNumber ?? '',
        profilePicture: data.ProfilePicture ?? '',
      };
    }),
    nextCursor: snapshot.docs.length > limit ? docs[docs.length - 1].id : null,
    total: null,
  };
}
