// firebase.js — Initialisation Firebase + couche d'accès aux données (Realtime Database)
// + Authentification + gestion multi-épreuves.
// Toutes les fonctions "données de course" (riders/timing/config/history) opèrent
// désormais SOUS L'ÉPREUVE ACTIVE : events/{activeEventId}/... au lieu de la racine.
// Toutes les fonctions renvoient des Promises ou exposent des listeners temps réel.

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  push,
  onValue,
  off,
  child
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  createUserWithEmailAndPassword,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDnTfXUTYUMi7Kv6hFV3h0o798oNlbBK8M",
  authDomain: "trjv-enduro-2026.firebaseapp.com",
  databaseURL: "https://trjv-enduro-2026-default-rtdb.firebaseio.com",
  projectId: "trjv-enduro-2026",
  storageBucket: "trjv-enduro-2026.firebasestorage.app",
  messagingSenderId: "700796765446",
  appId: "1:700796765446:web:2cda8aaeba4b501f9cca87"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

/* ------------------------------------------------------------------ */
/* ÉPREUVE ACTIVE — tout le reste de ce fichier travaille dans son contexte */
/* ------------------------------------------------------------------ */

const ACTIVE_EVENT_KEY = "trjv_active_event_id";
let activeEventId = localStorage.getItem(ACTIVE_EVENT_KEY) || null;

export function getActiveEvent() {
  return activeEventId;
}

export function setActiveEvent(eventId) {
  activeEventId = eventId || null;
  if (activeEventId) localStorage.setItem(ACTIVE_EVENT_KEY, activeEventId);
  else localStorage.removeItem(ACTIVE_EVENT_KEY);
}

/** Préfixe un chemin par l'épreuve active. Lève une erreur explicite si aucune épreuve n'est sélectionnée. */
function p(path) {
  if (!activeEventId) throw new Error("Aucune épreuve active sélectionnée.");
  return `events/${activeEventId}/${path}`;
}

/* ------------------------------------------------------------------ */
/* AUTHENTIFICATION                                                     */
/* ------------------------------------------------------------------ */

// callback(user | null)
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function logout() {
  setActiveEvent(null);
  return signOut(auth);
}

export function loginAnonymously() {
  return signInAnonymously(auth);
}

/**
 * Crée un compte opérateur (email + mot de passe) SANS déconnecter l'administrateur
 * actuellement connecté : on utilise une seconde instance Firebase temporaire, isolée
 * de la session principale, uniquement le temps de la création du compte.
 * Retourne l'UID du nouvel utilisateur.
 */
export async function createOperatorAccount(email, password) {
  const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;
    await signOut(secondaryAuth);
    return uid;
  } finally {
    await deleteApp(secondaryApp);
  }
}

/* ------------------------------------------------------------------ */
/* UTILISATEURS / DROITS                                               */
/* /users/{uid} = { email, isGlobalAdmin, events: { [eventId]: role } } */
/* ------------------------------------------------------------------ */

export function watchMyProfile(uid, callback) {
  return onValue(ref(db, `users/${uid}`), (snap) => callback(snap.val()));
}

export function getMyProfileOnce(uid) {
  return get(ref(db, `users/${uid}`)).then((snap) => snap.val());
}

export function createUserProfile(uid, profile) {
  return set(ref(db, `users/${uid}`), profile);
}

/** Ajoute (ou change le rôle d') un membre à une épreuve, et met à jour l'index chez l'utilisateur. */
export function setEventMember(eventId, uid, email, role) {
  const updates = {};
  updates[`events/${eventId}/members/${uid}`] = { email, role };
  updates[`users/${uid}/events/${eventId}`] = role;
  updates[`users/${uid}/email`] = email;
  return update(ref(db), updates);
}

export function removeEventMember(eventId, uid) {
  const updates = {};
  updates[`events/${eventId}/members/${uid}`] = null;
  updates[`users/${uid}/events/${eventId}`] = null;
  return update(ref(db), updates);
}

export function watchEventMembers(eventId, callback) {
  return onValue(ref(db, `events/${eventId}/members`), (snap) => callback(snap.val() || {}));
}

/* ------------------------------------------------------------------ */
/* ÉPREUVES (admin global uniquement pour la création/liste globale)   */
/* /events/{eventId}/meta = { name, date, createdAt }                  */
/* ------------------------------------------------------------------ */

export function createEvent(eventId, meta) {
  return set(ref(db, `events/${eventId}/meta`), meta);
}

export function saveEventMeta(eventId, meta) {
  return update(ref(db, `events/${eventId}/meta`), meta);
}

/** Admin global uniquement (règles de sécurité) : liste toutes les épreuves existantes. */
export function watchAllEvents(callback) {
  return onValue(ref(db, "events"), (snap) => {
    const val = snap.val() || {};
    const list = Object.entries(val).map(([id, e]) => ({ id, meta: e.meta || {} }));
    callback(list);
  });
}

/** Pour un utilisateur non admin-global : lit les métadonnées d'UNE épreuve à laquelle il a accès. */
export function watchEventMeta(eventId, callback) {
  return onValue(ref(db, `events/${eventId}/meta`), (snap) => callback(snap.val() || {}));
}

/* ------------------------------------------------------------------ */
/* ÉTAT DE CONNEXION                                                   */
/* ------------------------------------------------------------------ */

// callback(state) où state ∈ {"online","offline"}
export function watchConnection(callback) {
  const connectedRef = ref(db, ".info/connected");
  return onValue(connectedRef, (snap) => {
    callback(snap.val() === true ? "online" : "offline");
  });
}

/* ------------------------------------------------------------------ */
/* CONFIGURATION DE L'ÉVÉNEMENT (dans l'épreuve active)                 */
/* ------------------------------------------------------------------ */

export function saveEventConfig(config) {
  return set(ref(db, p("config")), config);
}

/**
 * Affiche / masque le classement en direct sur public.html sans toucher au
 * reste de la configuration (mise à jour partielle, pas un set() complet).
 */
export function setPublicVisibility(hidden) {
  return update(ref(db, p("config")), { publicHidden: !!hidden });
}

export function watchEventConfig(callback) {
  return onValue(ref(db, p("config")), (snap) => callback(snap.val()));
}

/* ------------------------------------------------------------------ */
/* PILOTES                                                             */
/* ------------------------------------------------------------------ */

// Un pilote est stocké sous events/{eventId}/riders/{dossard}
export function saveRider(rider) {
  return set(ref(db, `${p("riders")}/${rider.dossard}`), rider);
}

export function saveRidersBulk(ridersByDossard) {
  // ridersByDossard: { [dossard]: riderObj, ... }
  return update(ref(db, p("riders")), ridersByDossard);
}

/**
 * Supprime DÉFINITIVEMENT un pilote : fiche pilote + tous ses temps + son historique.
 */
export async function deleteRider(dossard, spList) {
  const updates = { [`${p("riders")}/${dossard}`]: null, [`${p("history")}/${dossard}`]: null };
  (spList || []).forEach((sp) => { updates[`${p("timing")}/${sp}/${dossard}`] = null; });
  return update(ref(db), updates);
}

/**
 * "Reset pilote" : efface tous les départs / arrivées / temps / statuts d'un pilote pour
 * TOUTES les spéciales, mais conserve sa fiche ET son historique.
 */
export async function resetRiderTiming(dossard, spList) {
  const updates = {};
  (spList || []).forEach((sp) => { updates[`${p("timing")}/${sp}/${dossard}`] = null; });
  return update(ref(db), updates);
}

export function watchRiders(callback) {
  return onValue(ref(db, p("riders")), (snap) => callback(snap.val() || {}));
}

export function getRidersOnce() {
  return get(ref(db, p("riders"))).then((snap) => snap.val() || {});
}

/* ------------------------------------------------------------------ */
/* CHRONOMÉTRAGE                                                       */
/* events/{eventId}/timing/{SPKEY}/{dossard} = { statut, depart, arrivee, tempsSP } */
/* ------------------------------------------------------------------ */

export function watchTiming(callback) {
  return onValue(ref(db, p("timing")), (snap) => callback(snap.val() || {}));
}

export function writeTimingEntry(spKey, dossard, patch) {
  return update(ref(db, `${p("timing")}/${spKey}/${dossard}`), patch);
}

/** Efface complètement l'entrée de chrono d'un pilote sur UNE spéciale (retour à "Attente"). */
export function clearTimingEntry(spKey, dossard) {
  return update(ref(db), { [`${p("timing")}/${spKey}/${dossard}`]: null });
}

export function getTimingOnce() {
  return get(ref(db, p("timing"))).then((snap) => snap.val() || {});
}

export function resetTiming() {
  return remove(ref(db, p("timing")));
}

/* ------------------------------------------------------------------ */
/* HISTORIQUE — journal complet des opérations, par pilote             */
/* events/{eventId}/history/{dossard}/{pushId} = { ts, type, sp?, details? } */
/* ------------------------------------------------------------------ */

export function addHistoryEntry(dossard, entry) {
  const entryRef = push(ref(db, `${p("history")}/${dossard}`));
  return set(entryRef, { ts: Date.now(), ...entry });
}

export function watchHistory(dossard, callback) {
  const historyRef = ref(db, `${p("history")}/${dossard}`);
  onValue(historyRef, (snap) => callback(snap.val() || {}));
  return () => off(historyRef);
}

export { ref, set, get, update, remove, push, onValue, off, child };
