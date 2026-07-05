// firebase.js — Initialisation Firebase + couche d'accès aux données (Realtime Database)
// Toutes les fonctions renvoient des Promises ou exposent des listeners temps réel.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
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

/* ------------------------------------------------------------------ */
/* ÉTAT DE CONNEXION                                                   */
/* ------------------------------------------------------------------ */

// callback(state) où state ∈ {"online","offline"}
export function watchConnection(callback) {
  const connectedRef = ref(db, ".info/connected");
  onValue(connectedRef, (snap) => {
    callback(snap.val() === true ? "online" : "offline");
  });
}

/* ------------------------------------------------------------------ */
/* CONFIGURATION DE L'ÉVÉNEMENT                                        */
/* ------------------------------------------------------------------ */

export function saveEventConfig(config) {
  return set(ref(db, "config"), config);
}

/**
 * Affiche / masque le classement en direct sur public.html sans toucher au
 * reste de la configuration (mise à jour partielle, pas un set() complet).
 */
export function setPublicVisibility(hidden) {
  return update(ref(db, "config"), { publicHidden: !!hidden });
}

export function watchEventConfig(callback) {
  onValue(ref(db, "config"), (snap) => callback(snap.val()));
}

/* ------------------------------------------------------------------ */
/* PILOTES                                                             */
/* ------------------------------------------------------------------ */

// Un pilote est stocké sous /riders/{dossard}
export function saveRider(rider) {
  return set(ref(db, `riders/${rider.dossard}`), rider);
}

export function saveRidersBulk(ridersByDossard) {
  // ridersByDossard: { [dossard]: riderObj, ... }
  return update(ref(db, "riders"), ridersByDossard);
}

/**
 * Supprime DÉFINITIVEMENT un pilote : fiche pilote + tous ses temps + son historique.
 * Corrige le bug connu "je supprime puis recrée le même dossard et l'ancien passage réapparaît" :
 * avant, seule la fiche pilote était effacée, les temps de chrono restaient orphelins en base.
 */
export async function deleteRider(dossard, spList) {
  const updates = { [`riders/${dossard}`]: null, [`history/${dossard}`]: null };
  (spList || []).forEach((sp) => { updates[`timing/${sp}/${dossard}`] = null; });
  return update(ref(db), updates);
}

/**
 * "Reset pilote" : efface tous les départs / arrivées / temps / statuts d'un pilote pour
 * TOUTES les spéciales, mais conserve sa fiche (nom, dossard, catégorie…) ET son historique
 * (le reset lui-même est journalisé, il n'efface pas la mémoire des opérations passées).
 * Après un reset, le pilote est traité comme s'il n'avait jamais pris le départ.
 */
export async function resetRiderTiming(dossard, spList) {
  const updates = {};
  (spList || []).forEach((sp) => { updates[`timing/${sp}/${dossard}`] = null; });
  return update(ref(db), updates);
}

export function watchRiders(callback) {
  onValue(ref(db, "riders"), (snap) => callback(snap.val() || {}));
}

export function getRidersOnce() {
  return get(ref(db, "riders")).then((snap) => snap.val() || {});
}

/* ------------------------------------------------------------------ */
/* CHRONOMÉTRAGE                                                       */
/* /timing/{SPKEY}/{dossard} = { statut, depart, arrivee, tempsSP }     */
/* ------------------------------------------------------------------ */

export function watchTiming(callback) {
  onValue(ref(db, "timing"), (snap) => callback(snap.val() || {}));
}

export function writeTimingEntry(spKey, dossard, patch) {
  return update(ref(db, `timing/${spKey}/${dossard}`), patch);
}

/** Efface complètement l'entrée de chrono d'un pilote sur UNE spéciale (retour à "Attente"). */
export function clearTimingEntry(spKey, dossard) {
  return update(ref(db), { [`timing/${spKey}/${dossard}`]: null });
}

export function getTimingOnce() {
  return get(ref(db, "timing")).then((snap) => snap.val() || {});
}

export function resetTiming() {
  return remove(ref(db, "timing"));
}

/* ------------------------------------------------------------------ */
/* HISTORIQUE — journal complet des opérations, par pilote             */
/* /history/{dossard}/{pushId} = { ts, type, sp?, details? }            */
/* ------------------------------------------------------------------ */

export function addHistoryEntry(dossard, entry) {
  const entryRef = push(ref(db, `history/${dossard}`));
  return set(entryRef, { ts: Date.now(), ...entry });
}

export function watchHistory(dossard, callback) {
  const historyRef = ref(db, `history/${dossard}`);
  onValue(historyRef, (snap) => callback(snap.val() || {}));
  return () => off(historyRef);
}

export { ref, set, get, update, remove, push, onValue, off, child };
