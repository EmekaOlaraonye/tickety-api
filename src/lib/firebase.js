import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import config from '../config.js';

/**
 * Firebase Admin, initialised from Application Default Credentials.
 *
 * The previous version imported `firebase-admin.json` — a service-account
 * private key — straight off disk with an import assertion. That key granted
 * full admin access to the project, sat in a folder with no `.gitignore`, and
 * had to be copied to every machine and into any image that ran the API.
 *
 * ADC removes the file entirely:
 *
 *   * On Cloud Run the runtime service account is used automatically, with no
 *     secret to leak, rotate, or forget to rotate.
 *   * Locally, `gcloud auth application-default login` supplies your own
 *     credentials, so a developer's access is their own and is revoked when
 *     their account is.
 *
 * The Admin SDK bypasses Firestore security rules by design, which is exactly
 * why this process must be the only thing holding these credentials, and why
 * every route checks authorisation itself.
 */
function initialise() {
  if (getApps().length > 0) return;

  initializeApp({
    credential: applicationDefault(),
    projectId: config.projectId,
  });
}

initialise();

export const auth = getAuth();

export const db = getFirestore();

/** Collection names, in one place, matching what the apps already write. */
export const COLLECTIONS = Object.freeze({
  users: 'Users',
  /** Events. Named `Tickets` historically; the apps all still use that name. */
  events: 'Tickets',
  issuedTickets: 'IssuedTickets',
  categories: 'Categories',
  /** Per-user subcollection: Users/{uid}/Orders/{orderId}. */
  orders: 'Orders',
});

/** Firestore rejects a write of `undefined`; callers build patches with this. */
export function stripUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  );
}
