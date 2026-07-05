// app.js — Logique principale de l'application admin (index.html).
// Architecture : ce fichier ne fait QUE la coordination UI <-> état <-> Firebase.
// Les calculs de classement/anomalies vivent dans classement.js (module pur, testable,
// partagé avec public.html) afin d'éviter toute duplication de logique métier.

import {
  watchConnection,
  saveEventConfig,
  setPublicVisibility,
  watchEventConfig,
  saveRider,
  saveRidersBulk,
  deleteRider,
  watchRiders,
  watchTiming,
  writeTimingEntry,
  clearTimingEntry,
  resetRiderTiming,
  addHistoryEntry,
  watchHistory
} from "./firebase.js";
import { parseRidersExcel, findExistingDossardConflicts } from "./import.js";
import { exportClassementToExcel } from "./export.js";
import { spKeys, computeClassement, detectAnomalies, sortRows } from "./classement.js";

/* ================================================================== */
/* ÉTAT LOCAL                                                          */
/* ================================================================== */

const CATEGORIES = ["U11", "U13", "U15", "U17"];

const state = {
  config: null,
  riders: {},
  timing: {},
  connection: "offline",
  chrono: { sp: null, poste: "haut", selectedDossard: null },
  classement: { search: "", categorie: "", sexe: "", sortKey: "positionGenerale", sortDir: "asc" },
  detail: { dossard: null, unwatchHistory: null, history: {} }
};

const QUEUE_KEY = "trjv_offline_queue_v2";
const RIDERS_CACHE_KEY = "trjv_riders_cache_v1";
const TIMING_CACHE_KEY = "trjv_timing_cache_v1";

/* ================================================================== */
/* UTILITAIRES DOM / FORMAT                                            */
/* ================================================================== */

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function formatMs(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return "—";
  const sign = ms < 0 ? "-" : "";
  const totalMs = Math.abs(Math.round(ms));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const cs = Math.floor((totalMs % 1000) / 10);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return h > 0 ? `${sign}${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}` : `${sign}${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function formatClock(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("fr-FR", { hour12: false });
}

function formatDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("fr-FR", { hour12: false });
}

/** Convertit un timestamp en "HH:MM:SS" éditable (heure locale). */
function tsToHms(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Convertit "HH:MM" ou "HH:MM:SS" saisi manuellement en timestamp (jour de référence = config.createdAt ou aujourd'hui). */
function hmsToTs(hms, referenceTs) {
  const cleaned = (hms || "").trim();
  if (!cleaned) return null;
  const match = cleaned.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return NaN; // signale une saisie invalide à l'appelant
  const base = new Date(referenceTs || state.config?.createdAt || Date.now());
  base.setHours(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3] || "0", 10), 0);
  return base.getTime();
}

function toast(message, type = "info") {
  const container = $("#toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function statusLabel(statut) {
  return { ATTENTE: "En attente", EN_COURSE: "En course", ARRIVE: "Arrivé" }[statut] || statut;
}

/**
 * Convertit une saisie "mm:ss", "mm:ss.cc" ou "h:mm:ss.cc" en millisecondes.
 * Retourne null pour une saisie vide (= effacer) et NaN pour une saisie invalide.
 * Symétrique de formatMs() ci-dessus.
 */
function parseDurationToMs(str) {
  const cleaned = (str || "").trim();
  if (!cleaned) return null;
  const match = cleaned.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!match) return NaN;
  const h = match[1] ? parseInt(match[1], 10) : 0;
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  const fracStr = (match[4] || "0").padEnd(3, "0").slice(0, 3);
  const fracMs = parseInt(fracStr, 10);
  if (m > 59 || s > 59) return NaN;
  return ((h * 3600) + (m * 60) + s) * 1000 + fracMs;
}

/* ================================================================== */
/* FILE D'ATTENTE HORS-LIGNE (localStorage — survit aux rechargements) */
/* ================================================================== */

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; }
  catch { return []; }
}
function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  updateQueueBadge(queue.length);
}
function enqueue(op) {
  const queue = loadQueue();
  queue.push({ ...op, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}` });
  saveQueue(queue);
  return queue;
}
function updateQueueBadge(count) {
  const badge = $("#queue-badge");
  if (badge) {
    if (count > 0) { badge.textContent = `${count} en attente de synchro`; badge.classList.remove("hidden"); }
    else badge.classList.add("hidden");
  }
  const outilsStatus = $("#outils-queue-status");
  if (outilsStatus) {
    outilsStatus.textContent = count > 0
      ? `${count} action(s) en attente de synchronisation avec Firebase.`
      : "Aucune action en attente : tout est synchronisé.";
  }
}

/** Rejoue la file d'attente locale sur Firebase, dans l'ordre, dès que le réseau revient. */
async function flushQueue() {
  if (state.connection !== "online") return;
  const queue = loadQueue();
  if (!queue.length) return;

  const remaining = [];
  for (const op of queue) {
    try {
      switch (op.type) {
        case "timing": await writeTimingEntry(op.sp, op.dossard, op.patch); break;
        case "timingClear": await clearTimingEntry(op.sp, op.dossard); break;
        case "reset": await resetRiderTiming(op.dossard, op.spList); break;
        case "rider": await saveRider(op.rider); break;
        case "riderDelete": await deleteRider(op.dossard, op.spList); break;
        case "history": await addHistoryEntry(op.dossard, op.entry); break;
      }
    } catch {
      remaining.push(op);
    }
  }
  saveQueue(remaining);
  if (remaining.length === 0 && queue.length > 0) {
    toast("Synchronisation terminée : toutes les actions en attente ont été envoyées.", "success");
  }
}

function cacheRiders(riders) { localStorage.setItem(RIDERS_CACHE_KEY, JSON.stringify(riders)); }
function readRidersCache() {
  try { return JSON.parse(localStorage.getItem(RIDERS_CACHE_KEY)) || {}; } catch { return {}; }
}
function cacheTiming(timing) { localStorage.setItem(TIMING_CACHE_KEY, JSON.stringify(timing)); }
function readTimingCache() {
  try { return JSON.parse(localStorage.getItem(TIMING_CACHE_KEY)) || {}; } catch { return {}; }
}

/** Journalise un événement pour un pilote (création, départ, modification, reset…), même hors ligne. */
async function logHistory(dossard, entry) {
  if (state.connection === "online") {
    try { await addHistoryEntry(dossard, entry); return; } catch { /* tombe en file d'attente */ }
  }
  enqueue({ type: "history", dossard, entry });
}

/* ================================================================== */
/* CONNEXION                                                           */
/* ================================================================== */

function initConnectionWatcher() {
  updateQueueBadge(loadQueue().length);
  watchConnection((status) => {
    state.connection = status;
    const dot = $("#conn-dot");
    const label = $("#conn-label");
    if (dot && label) {
      dot.className = "dot " + (status === "online" ? "online" : "offline");
      label.textContent = status === "online" ? "Connecté" : "Hors ligne — mode dégradé";
    }
    renderDashboard();
    if (status === "online") flushQueue();
    else toast("Connexion perdue : les actions sont enregistrées localement et seront synchronisées au retour du réseau.", "warn");
  });
  window.addEventListener("online", flushQueue);
  setInterval(flushQueue, 8000);
  setInterval(renderDashboard, 30000); // rafraîchit le calcul "en course depuis trop longtemps"
}

/* ================================================================== */
/* NAVIGATION                                                          */
/* ================================================================== */

function switchTab(tabName) {
  $all(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  $all(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tabName}`));
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  closeMobileMenu();
}

function openMobileMenu() {
  $(".tabs")?.classList.add("open");
  $("#nav-backdrop")?.classList.add("open");
}
function closeMobileMenu() {
  $(".tabs")?.classList.remove("open");
  $("#nav-backdrop")?.classList.remove("open");
}

function initTabs() {
  $all(".tab-btn").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  $("#btn-mobile-menu")?.addEventListener("click", openMobileMenu);
  $("#btn-close-drawer")?.addEventListener("click", closeMobileMenu);
  $("#nav-backdrop")?.addEventListener("click", closeMobileMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMobileMenu(); });
  $("#btn-toggle-public")?.addEventListener("click", togglePublicVisibility);
}

/* ================================================================== */
/* TABLEAU DE BORD                                                     */
/* ================================================================== */

function renderDashboard() {
  const root = $("#view-dashboard");
  if (!root) return;

  const config = state.config;
  $("#dash-event-name").textContent = config?.eventName || "Aucune course configurée";
  $("#dash-event-meta").textContent = config
    ? `${config.numSpeciales} spéciale(s)${config.liaisonsEnabled ? " · liaisons chronométrées activées" : ""}`
    : "Rendez-vous dans Paramètres pour créer votre course.";

  renderPublicVisibilityControls();

  const spList = spKeys(config?.numSpeciales || 0);
  const riders = Object.values(state.riders);
  const { rows } = computeClassement(state.riders, state.timing, config || {});
  const counts = { total: riders.length, ATTENTE: 0, EN_COURSE: 0, ARRIVE: 0 };
  rows.forEach((r) => { counts[r.statutGlobal] = (counts[r.statutGlobal] || 0) + 1; });

  $("#dash-count-total").textContent = counts.total;
  $("#dash-count-attente").textContent = counts.ATTENTE || 0;
  $("#dash-count-encourse").textContent = counts.EN_COURSE || 0;
  $("#dash-count-arrive").textContent = counts.ARRIVE || 0;

  // Bannière d'anomalies
  const anomalies = detectAnomalies(state.riders, state.timing, config || {});
  const banner = $("#dash-anomalies-banner");
  if (!anomalies.length) {
    banner.className = "import-banner ok";
    banner.innerHTML = "Aucune anomalie détectée. Tout est en ordre.";
  } else {
    banner.className = "import-banner warn";
    banner.innerHTML = `${anomalies.length} anomalie(s) détectée(s) :<ul>${anomalies.slice(0, 6).map((a) => `<li>${a.message}</li>`).join("")}</ul>${anomalies.length > 6 ? `<div class="dim">… voir l'onglet Outils pour la liste complète.</div>` : ""}`;
  }

  // Accès rapides aux postes de chronométrage
  const quick = $("#dash-quick-links");
  if (!spList.length) {
    quick.innerHTML = `<div class="empty-state">Configurez le nombre de spéciales dans Paramètres pour faire apparaître les postes.</div>`;
  } else {
    quick.innerHTML = spList.map((sp) => `
      <div class="quick-sp-group">
        <div class="quick-sp-label">${sp}</div>
        <div class="quick-sp-buttons">
          <button class="btn btn-secondary quick-link" data-sp="${sp}" data-poste="haut">↑ Haut (Départ)</button>
          <button class="btn btn-secondary quick-link" data-sp="${sp}" data-poste="bas">↓ Bas (Arrivée)</button>
        </div>
      </div>
    `).join("");
    $all(".quick-link", quick).forEach((btn) => btn.addEventListener("click", () => {
      state.chrono.sp = btn.dataset.sp;
      state.chrono.poste = btn.dataset.poste;
      state.chrono.selectedDossard = null;
      switchTab("chrono");
      renderChronoView();
    }));
  }
}

/* ================================================================== */
/* VISIBILITÉ PUBLIQUE — masquer/afficher le classement sur public.html */
/* ================================================================== */

function renderPublicVisibilityControls() {
  const hidden = !!state.config?.publicHidden;
  [$("#btn-toggle-public"), $("#btn-toggle-public-outils")].forEach((btn) => {
    if (!btn) return;
    btn.textContent = hidden ? "👁️ Réafficher le classement public" : "🙈 Masquer le classement public";
    btn.classList.toggle("btn-danger", hidden);
    btn.classList.toggle("btn-secondary", !hidden);
  });
  const status = $("#outils-public-status");
  if (status) {
    status.textContent = hidden
      ? "Le classement public est actuellement MASQUÉ : les visiteurs de public.html voient uniquement un message d'attente."
      : "Le classement public est actuellement VISIBLE en temps réel sur public.html.";
    status.classList.toggle("dim", !hidden);
  }
}

async function togglePublicVisibility() {
  const newValue = !state.config?.publicHidden;
  state.config = { ...(state.config || {}), publicHidden: newValue };
  renderPublicVisibilityControls();
  try {
    await setPublicVisibility(newValue);
    toast(newValue ? "Classement public masqué." : "Classement public réaffiché.", "success");
  } catch {
    toast("Impossible de synchroniser ce changement pour le moment (réseau instable) — réessayez.", "error");
  }
}

/* ================================================================== */
/* PARAMÈTRES (config de la course)                                    */
/* ================================================================== */

function renderLiaisonInputs(numSpeciales, liaisonTimes = {}) {
  const container = $("#liaison-inputs");
  if (!container) return;
  container.innerHTML = "";
  spKeys(numSpeciales).forEach((sp) => {
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.style.minWidth = "140px";
    wrap.innerHTML = `<label for="liaison-${sp}">Liaison ${sp} (min)</label>
      <input type="number" min="0" id="liaison-${sp}" data-sp="${sp}" value="${liaisonTimes[sp] ?? 0}">`;
    container.appendChild(wrap);
  });
}

function initParametresView() {
  const form = $("#form-organisation");
  if (!form) return;

  const numInput = $("#input-num-speciales");
  const liaisonsCheckbox = $("#input-liaisons-enabled");
  const liaisonsBlock = $("#liaisons-block");

  function refreshLiaisonBlock() {
    liaisonsBlock.classList.toggle("hidden", !liaisonsCheckbox.checked);
    renderLiaisonInputs(parseInt(numInput.value || "0", 10), state.config?.liaisonTimes || {});
  }
  numInput.addEventListener("input", refreshLiaisonBlock);
  liaisonsCheckbox.addEventListener("change", refreshLiaisonBlock);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const numSpeciales = parseInt(numInput.value || "0", 10);
    const liaisonTimes = {};
    if (liaisonsCheckbox.checked) {
      $all("#liaison-inputs input").forEach((inp) => { liaisonTimes[inp.dataset.sp] = parseInt(inp.value || "0", 10); });
    }
    const config = {
      eventName: $("#input-event-name").value.trim() || "Course sans nom",
      numSpeciales,
      liaisonsEnabled: liaisonsCheckbox.checked,
      liaisonTimes,
      anomalyThresholdMin: parseInt($("#input-anomaly-threshold").value || "20", 10),
      createdAt: state.config?.createdAt || Date.now()
    };
    try {
      await saveEventConfig(config);
      toast("Configuration de la course enregistrée.", "success");
    } catch {
      toast("Échec de l'enregistrement (hors ligne ?) — réessayez au retour du réseau.", "error");
    }
  });

  refreshLiaisonBlock();
}

function applyConfigToParametresForm(config) {
  if (!config) return;
  const nameInput = $("#input-event-name");
  const numInput = $("#input-num-speciales");
  const liaisonsCheckbox = $("#input-liaisons-enabled");
  const thresholdInput = $("#input-anomaly-threshold");
  if (!nameInput) return;
  if (document.activeElement !== nameInput) nameInput.value = config.eventName || "";
  if (document.activeElement !== numInput) numInput.value = config.numSpeciales || 2;
  liaisonsCheckbox.checked = !!config.liaisonsEnabled;
  if (document.activeElement !== thresholdInput) thresholdInput.value = config.anomalyThresholdMin || 20;
  $("#liaisons-block").classList.toggle("hidden", !config.liaisonsEnabled);
  renderLiaisonInputs(config.numSpeciales || 0, config.liaisonTimes || {});
}

/* ================================================================== */
/* PILOTES                                                             */
/* ================================================================== */

function renderRidersTable() {
  const tbody = $("#riders-tbody");
  if (!tbody) return;
  const search = ($("#riders-search")?.value || "").toLowerCase().trim();

  const rows = Object.values(state.riders)
    .filter((r) => !search || [r.nom, r.prenom, r.dossard, r.club].join(" ").toLowerCase().includes(search))
    .sort((a, b) => Number(a.dossard) - Number(b.dossard));

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Aucun pilote enregistré pour le moment.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td><span class="plate">${r.dossard}</span></td>
      <td>${r.nom}</td>
      <td>${r.prenom}</td>
      <td>${r.sexe}</td>
      <td>${r.categorie}</td>
      <td>${r.club || ""}</td>
      <td class="mono dim">${r.licence || ""}</td>
      <td>
        <button class="btn btn-secondary btn-detail-rider" data-dossard="${r.dossard}">Détails</button>
        <button class="btn btn-danger btn-delete-rider" data-dossard="${r.dossard}">Supprimer</button>
      </td>
    </tr>
  `).join("");

  $all(".btn-detail-rider", tbody).forEach((btn) => btn.addEventListener("click", () => openRiderDetail(btn.dataset.dossard)));
  $all(".btn-delete-rider", tbody).forEach((btn) => btn.addEventListener("click", () => handleDeleteRider(btn.dataset.dossard)));
}

async function handleDeleteRider(dossard) {
  if (!confirm(`Supprimer DÉFINITIVEMENT le pilote #${dossard} ainsi que tous ses temps et son historique ?`)) return;
  const spList = spKeys(state.config?.numSpeciales || 0);

  delete state.riders[dossard];
  cacheRiders(state.riders);
  spList.forEach((sp) => { if (state.timing[sp]) delete state.timing[sp][dossard]; });
  cacheTiming(state.timing);
  renderRidersTable(); renderChronoView(); renderClassementView(); renderDashboard();

  if (state.connection === "online") {
    try { await deleteRider(dossard, spList); toast("Pilote supprimé (fiche + temps + historique).", "success"); return; }
    catch { /* tombe en file d'attente */ }
  }
  enqueue({ type: "riderDelete", dossard, spList });
  toast("Hors ligne : suppression mise en file d'attente.", "warn");
}

function openRiderForm() {
  const modal = $("#rider-modal");
  modal.classList.remove("hidden");
  $("#rf-dossard").value = "";
  $("#rf-dossard").disabled = false;
  $("#rf-nom").value = ""; $("#rf-prenom").value = "";
  $("#rf-sexe").value = "H"; $("#rf-categorie").value = "U11";
  $("#rf-club").value = ""; $("#rf-licence").value = "";
}
function closeRiderForm() { $("#rider-modal").classList.add("hidden"); }

function initRidersView() {
  $("#btn-add-rider")?.addEventListener("click", openRiderForm);
  $("#btn-close-rider-modal")?.addEventListener("click", closeRiderForm);
  $("#riders-search")?.addEventListener("input", renderRidersTable);

  $("#rider-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dossard = $("#rf-dossard").value.trim();
    if (!dossard) { toast("Le numéro de dossard est obligatoire.", "error"); return; }
    if (state.riders[dossard]) { toast(`Le dossard n°${dossard} est déjà attribué.`, "error"); return; }

    const rider = {
      id: dossard, dossard,
      nom: $("#rf-nom").value.trim().toUpperCase(),
      prenom: $("#rf-prenom").value.trim(),
      sexe: $("#rf-sexe").value,
      categorie: $("#rf-categorie").value,
      club: $("#rf-club").value.trim(),
      licence: $("#rf-licence").value.trim()
    };

    state.riders[dossard] = rider;
    cacheRiders(state.riders);
    renderRidersTable(); renderDashboard();

    if (state.connection === "online") {
      try { await saveRider(rider); toast("Pilote enregistré.", "success"); }
      catch { enqueue({ type: "rider", rider }); toast("Réseau instable : pilote mis en file d'attente.", "warn"); }
    } else {
      enqueue({ type: "rider", rider });
      toast("Hors ligne : pilote enregistré localement, sera synchronisé au retour réseau.", "warn");
    }
    logHistory(dossard, { type: "creation", details: `Pilote créé (${rider.nom} ${rider.prenom}, ${rider.categorie}).` });
    closeRiderForm();
  });

  const fileInput = $("#import-file-input");
  $("#btn-import-excel")?.addEventListener("click", () => fileInput.click());
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const { riders, duplicates, errors } = await parseRidersExcel(file);
      const conflicts = findExistingDossardConflicts(riders, state.riders);
      renderImportBanner(riders.length, duplicates, errors, conflicts);
      if (!riders.length) { toast("Aucun pilote valide trouvé dans le fichier.", "error"); return; }

      const byDossard = {};
      riders.forEach((r) => { byDossard[r.dossard] = r; });
      Object.assign(state.riders, byDossard);
      cacheRiders(state.riders);
      renderRidersTable(); renderDashboard();

      if (state.connection === "online") {
        try { await saveRidersBulk(byDossard); toast(`${riders.length} pilote(s) importé(s).`, "success"); }
        catch { riders.forEach((r) => enqueue({ type: "rider", rider: r })); toast("Réseau instable : import mis en file d'attente.", "warn"); }
      } else {
        riders.forEach((r) => enqueue({ type: "rider", rider: r }));
        toast(`Hors ligne : ${riders.length} pilote(s) mis en file d'attente.`, "warn");
      }
      riders.forEach((r) => logHistory(r.dossard, { type: "creation", details: `Pilote importé depuis Excel (${r.nom} ${r.prenom}).` }));
    } catch (err) {
      toast("Échec de l'import : " + err.message, "error");
    }
  });
}

function renderImportBanner(count, duplicates, errors, conflicts) {
  const banner = $("#import-banner");
  if (!banner) return;
  const problems = [];
  if (duplicates.length) problems.push(`Doublons de dossard dans le fichier : ${duplicates.join(", ")}`);
  if (conflicts.length) problems.push(`Dossards déjà existants (écrasés) : ${conflicts.join(", ")}`);
  if (errors.length) problems.push(...errors);

  if (!problems.length) {
    banner.className = "import-banner ok";
    banner.innerHTML = `${count} pilote(s) prêt(s) à être importés, aucun conflit détecté.`;
  } else {
    banner.className = "import-banner warn";
    banner.innerHTML = `${count} pilote(s) traité(s). Points d'attention :<ul>${problems.map((p) => `<li>${p}</li>`).join("")}</ul>`;
  }
  banner.classList.remove("hidden");
}

/* ================================================================== */
/* DÉTAIL PILOTE — profil / temps modifiables / reset / historique     */
/* ================================================================== */

function openRiderDetail(dossard) {
  const rider = state.riders[dossard];
  if (!rider) return;
  state.detail.dossard = dossard;

  $("#rider-detail-modal").classList.remove("hidden");
  $("#rd-title").textContent = `#${dossard} — ${rider.nom} ${rider.prenom}`;
  $("#rd-nom").value = rider.nom;
  $("#rd-prenom").value = rider.prenom;
  $("#rd-sexe").value = rider.sexe;
  $("#rd-categorie").value = rider.categorie;
  $("#rd-club").value = rider.club || "";
  $("#rd-licence").value = rider.licence || "";

  renderRiderDetailTiming();

  if (state.detail.unwatchHistory) state.detail.unwatchHistory();
  state.detail.unwatchHistory = watchHistory(dossard, (history) => {
    state.detail.history = history;
    renderRiderDetailHistory();
  });
}

function closeRiderDetail() {
  $("#rider-detail-modal").classList.add("hidden");
  if (state.detail.unwatchHistory) state.detail.unwatchHistory();
  state.detail = { dossard: null, unwatchHistory: null, history: {} };
}

function renderRiderDetailTiming() {
  const dossard = state.detail.dossard;
  const tbody = $("#rd-timing-tbody");
  if (!dossard || !tbody) return;
  const spList = spKeys(state.config?.numSpeciales || 0);

  if (!spList.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="empty-state">Configurez le nombre de spéciales dans Course.</td></tr>`;
    return;
  }

  tbody.innerHTML = spList.map((sp) => {
    const entry = state.timing?.[sp]?.[dossard] || {};
    const statut = entry.depart && entry.arrivee ? "ARRIVE" : entry.depart ? "EN_COURSE" : "ATTENTE";
    const realise = entry.depart && entry.arrivee ? entry.arrivee - entry.depart : null;
    return `
      <tr data-sp="${sp}">
        <td><strong>${sp}</strong></td>
        <td><span class="status-tag status-${statut === "ATTENTE" ? "attente" : statut === "EN_COURSE" ? "en-course" : "arrive"}">${statusLabel(statut)}</span></td>
        <td><input type="text" class="rd-input" data-field="temps" placeholder="mm:ss.cc" value="${realise !== null ? formatMs(realise) : ""}"></td>
      </tr>
    `;
  }).join("");
}

function renderRiderDetailHistory() {
  const list = $("#rd-history-list");
  if (!list) return;
  const entries = Object.values(state.detail.history || {}).sort((a, b) => b.ts - a.ts);
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state">Aucun événement enregistré pour ce pilote.</div>`;
    return;
  }
  const ICONS = { creation: "🆕", depart: "🏁", arrivee: "✅", modification_temps: "✏️", modification_pilote: "✏️", reset: "♻️" };
  list.innerHTML = entries.map((e) => `
    <div class="history-entry">
      <span class="history-icon">${ICONS[e.type] || "•"}</span>
      <div>
        <div class="history-date mono dim">${formatDateTime(e.ts)}</div>
        <div>${e.details || e.type}</div>
      </div>
    </div>
  `).join("");
}

function initRiderDetailModal() {
  $("#rd-close-btn")?.addEventListener("click", closeRiderDetail);

  $("#rd-profile-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dossard = state.detail.dossard;
    if (!dossard) return;
    const updated = {
      ...state.riders[dossard],
      nom: $("#rd-nom").value.trim().toUpperCase(),
      prenom: $("#rd-prenom").value.trim(),
      sexe: $("#rd-sexe").value,
      categorie: $("#rd-categorie").value,
      club: $("#rd-club").value.trim(),
      licence: $("#rd-licence").value.trim()
    };
    state.riders[dossard] = updated;
    cacheRiders(state.riders);
    renderRidersTable(); renderClassementView();
    $("#rd-title").textContent = `#${dossard} — ${updated.nom} ${updated.prenom}`;

    if (state.connection === "online") {
      try { await saveRider(updated); toast("Fiche pilote mise à jour.", "success"); }
      catch { enqueue({ type: "rider", rider: updated }); toast("Hors ligne : modification mise en file d'attente.", "warn"); }
    } else {
      enqueue({ type: "rider", rider: updated });
      toast("Hors ligne : modification enregistrée localement.", "warn");
    }
    logHistory(dossard, { type: "modification_pilote", details: "Fiche pilote modifiée." });
  });

  $("#rd-timing-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dossard = state.detail.dossard;
    if (!dossard) return;
    const rows = $all("#rd-timing-tbody tr");
    let hasInvalid = false;

    for (const row of rows) {
      const sp = row.dataset.sp;
      const tempsStr = row.querySelector('[data-field="temps"]').value;
      const tempsMs = parseDurationToMs(tempsStr);
      if (Number.isNaN(tempsMs)) { hasInvalid = true; continue; }

      const before = state.timing?.[sp]?.[dossard] || null;
      state.timing[sp] = state.timing[sp] || {};

      if (tempsMs === null) {
        // Champ vidé : on efface complètement le passage sur cette spéciale.
        if (before) {
          delete state.timing[sp][dossard];
          if (state.connection === "online") {
            try { await clearTimingEntry(sp, dossard); } catch { enqueue({ type: "timingClear", sp, dossard }); }
          } else enqueue({ type: "timingClear", sp, dossard });
          logHistory(dossard, { type: "modification_temps", sp, details: `Temps ${sp} effacé manuellement.` });
        }
        continue;
      }

      // Le temps saisi devient le temps réalisé exact : on ancre départ/arrivée à l'instant
      // de l'enregistrement pour obtenir arrivée − départ = temps saisi, sans toucher aux
      // éventuels pénalité/neutralisation déjà stockés.
      const now = Date.now();
      const patch = { depart: now - tempsMs, arrivee: now, statut: "ARRIVE" };
      const previousMs = before && before.depart && before.arrivee ? before.arrivee - before.depart : null;
      state.timing[sp][dossard] = { ...(before || {}), ...patch };

      if (state.connection === "online") {
        try { await writeTimingEntry(sp, dossard, patch); }
        catch { enqueue({ type: "timing", sp, dossard, patch }); }
      } else {
        enqueue({ type: "timing", sp, dossard, patch });
      }

      if (previousMs !== tempsMs) {
        logHistory(dossard, { type: "modification_temps", sp, details: `Temps ${sp} personnalisé : ${formatMs(tempsMs)}.` });
      }
    }

    if (hasInvalid) toast("Certains temps saisis sont invalides (format attendu mm:ss ou h:mm:ss) et ont été ignorés.", "error");
    else toast("Temps mis à jour et classement recalculé.", "success");

    cacheTiming(state.timing);
    renderRiderDetailTiming(); renderChronoView(); renderClassementView(); renderDashboard();
  });

  $("#btn-reset-rider")?.addEventListener("click", async () => {
    const dossard = state.detail.dossard;
    if (!dossard) return;
    if (!confirm(`Réinitialiser le pilote #${dossard} ? Tous ses départs, arrivées et temps seront effacés (la fiche et l'historique sont conservés).`)) return;

    const spList = spKeys(state.config?.numSpeciales || 0);
    spList.forEach((sp) => { if (state.timing[sp]) delete state.timing[sp][dossard]; });
    cacheTiming(state.timing);
    renderRiderDetailTiming(); renderChronoView(); renderClassementView(); renderDashboard();

    if (state.connection === "online") {
      try { await resetRiderTiming(dossard, spList); toast("Pilote réinitialisé : il peut repartir de zéro.", "success"); }
      catch { enqueue({ type: "reset", dossard, spList }); toast("Hors ligne : reset mis en file d'attente.", "warn"); }
    } else {
      enqueue({ type: "reset", dossard, spList });
      toast("Hors ligne : reset enregistré localement.", "warn");
    }
    logHistory(dossard, { type: "reset", details: "Pilote réinitialisé (tous les temps effacés)." });
  });

  $("#btn-delete-rider-detail")?.addEventListener("click", async () => {
    const dossard = state.detail.dossard;
    if (!dossard) return;
    closeRiderDetail();
    await handleDeleteRider(dossard);
  });
}

/* ================================================================== */
/* CHRONOMÉTRAGE                                                       */
/* ================================================================== */

function initChronoView() {
  $("#chrono-sp-select")?.addEventListener("change", (e) => {
    state.chrono.sp = e.target.value; state.chrono.selectedDossard = null; renderChronoView();
  });
  $all(".poste-toggle button").forEach((btn) => btn.addEventListener("click", () => {
    state.chrono.poste = btn.dataset.poste; state.chrono.selectedDossard = null; renderChronoView();
  }));
  $("#chrono-search")?.addEventListener("input", renderChronoView);
  $("#chrono-manual-dossard-btn")?.addEventListener("click", () => {
    const val = $("#chrono-manual-dossard").value.trim();
    if (val) selectRiderForChrono(val);
  });

  // Poste HAUT (départ) : un seul champ, la fiche du pilote s'affiche dès que le
  // dossard tapé correspond à un pilote connu — aucune liste à faire défiler.
  $("#chrono-dossard-haut")?.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    if (val && (state.riders[val] || readRidersCache()[val])) {
      state.chrono.selectedDossard = val;
    } else {
      state.chrono.selectedDossard = null;
    }
    renderChronoConfirmOnly();
  });
  $("#chrono-dossard-haut")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault(); // évite tout submit accidentel ; la fiche est déjà live
  });
}

function riderTimingStatus(dossard, sp) {
  const entry = state.timing?.[sp]?.[dossard];
  if (entry && entry.depart && entry.arrivee) return "ARRIVE";
  if (entry && entry.depart) return "EN_COURSE";
  return "ATTENTE";
}

function selectRiderForChrono(dossard) {
  const rider = state.riders[dossard] || readRidersCache()[dossard];
  if (!rider) { toast(`Aucun pilote trouvé pour le dossard ${dossard} (vérifiez la saisie ou le cache local).`, "error"); return; }
  state.chrono.selectedDossard = dossard;
  renderChronoView();
}

async function recordDepart(dossard) {
  const sp = state.chrono.sp;
  const existing = state.timing?.[sp]?.[dossard];
  if (existing && existing.depart) {
    toast(`Départ déjà enregistré pour le dossard ${dossard} sur ${sp} à ${formatClock(existing.depart)}. Utilisez la fiche pilote (Pilotes > Détails) pour corriger.`, "error");
    return;
  }

  const ts = Date.now();
  const patch = { statut: "EN_COURSE", depart: ts, arrivee: null, tempsSP: null, penalite: existing?.penalite || 0, neutralisation: existing?.neutralisation || 0 };
  state.timing[sp] = state.timing[sp] || {};
  state.timing[sp][dossard] = { ...(existing || {}), ...patch };
  cacheTiming(state.timing);
  renderChronoView(); renderDashboard();

  if (state.connection === "online") {
    try { await writeTimingEntry(sp, dossard, patch); }
    catch { enqueue({ type: "timing", sp, dossard, patch }); toast("Départ mis en file d'attente (réseau instable).", "warn"); }
  } else {
    enqueue({ type: "timing", sp, dossard, patch });
  }
  logHistory(dossard, { type: "depart", sp, details: `Départ ${sp} enregistré à ${formatClock(ts)}.` });
  toast(`Départ enregistré — dossard ${dossard} sur ${sp}.`, "success");
}

async function recordArrivee(dossard) {
  const sp = state.chrono.sp;
  const existing = state.timing?.[sp]?.[dossard];
  if (existing && existing.arrivee) {
    toast(`Arrivée déjà enregistrée pour le dossard ${dossard} sur ${sp} à ${formatClock(existing.arrivee)}. Utilisez la fiche pilote pour corriger.`, "error");
    return;
  }
  if (!existing || !existing.depart) {
    toast(`Aucun départ enregistré pour le dossard ${dossard} sur ${sp} — départ oublié ? Corrigez via la fiche pilote si besoin.`, "error");
    return;
  }

  const ts = Date.now();
  const tempsSP = ts - existing.depart;
  const patch = { statut: "ARRIVE", arrivee: ts, tempsSP };
  state.timing[sp][dossard] = { ...existing, ...patch };
  cacheTiming(state.timing);
  renderChronoView(); renderClassementView(); renderDashboard();

  if (state.connection === "online") {
    try { await writeTimingEntry(sp, dossard, patch); }
    catch { enqueue({ type: "timing", sp, dossard, patch }); toast("Arrivée mise en file d'attente (réseau instable).", "warn"); }
  } else {
    enqueue({ type: "timing", sp, dossard, patch });
  }
  logHistory(dossard, { type: "arrivee", sp, details: `Arrivée ${sp} enregistrée à ${formatClock(ts)} (temps : ${formatMs(tempsSP)}).` });
  toast(`Arrivée enregistrée — dossard ${dossard} sur ${sp} (${formatMs(tempsSP)}).`, "success");
}

function renderChronoView() {
  const spSelect = $("#chrono-sp-select");
  const hautBlock = $("#chrono-haut-block");
  const basBlock = $("#chrono-bas-block");
  const list = $("#chrono-rider-list");
  if (!spSelect || !hautBlock || !basBlock) return;

  const numSpeciales = state.config?.numSpeciales || 0;
  const keys = spKeys(numSpeciales);
  if (spSelect.dataset.rendered !== String(numSpeciales)) {
    spSelect.innerHTML = keys.map((k) => `<option value="${k}">${k}</option>`).join("");
    spSelect.dataset.rendered = String(numSpeciales);
    if (!state.chrono.sp && keys.length) state.chrono.sp = keys[0];
  }
  if (state.chrono.sp) spSelect.value = state.chrono.sp;

  $all(".poste-toggle button").forEach((btn) => btn.classList.toggle("active", btn.dataset.poste === state.chrono.poste));
  $("#chrono-poste-label").textContent = state.chrono.poste === "haut" ? `${state.chrono.sp || "—"} Haut (Départ)` : `${state.chrono.sp || "—"} Bas (Arrivée)`;

  const isHaut = state.chrono.poste === "haut";
  hautBlock.classList.toggle("hidden", !isHaut);
  basBlock.classList.toggle("hidden", isHaut);

  if (isHaut) {
    // Poste simplifié : un seul champ de saisie, focus automatique pour enchaîner les départs vite.
    const hautInput = $("#chrono-dossard-haut");
    if (hautInput && document.activeElement !== hautInput) hautInput.focus({ preventScroll: true });
  } else {
    const search = ($("#chrono-search")?.value || "").toLowerCase().trim();
    const sp = state.chrono.sp;
    const candidates = Object.values(state.riders).filter((r) => {
      const status = riderTimingStatus(r.dossard, sp);
      if (status !== "EN_COURSE") return false;
      return !search || [r.nom, r.prenom, r.dossard].join(" ").toLowerCase().includes(search);
    }).sort((a, b) => Number(a.dossard) - Number(b.dossard));

    if (!candidates.length) {
      list.innerHTML = `<div class="empty-state">Aucun pilote actuellement en course.</div>`;
    } else {
      list.innerHTML = candidates.map((r) => `
        <div class="rider-row" data-dossard="${r.dossard}">
          <span class="plate on-track">${r.dossard}</span>
          <div class="info">
            <div class="name">${r.nom} ${r.prenom}</div>
            <div class="meta">${r.categorie} · ${r.club || "Sans club"}</div>
          </div>
          <span class="status-tag status-en-course blink-orange">En course</span>
        </div>
      `).join("");
      $all(".rider-row", list).forEach((row) => row.addEventListener("click", () => selectRiderForChrono(row.dataset.dossard)));
    }
  }

  renderChronoConfirmOnly();
}

/**
 * Ne (re)construit que le panneau de confirmation (fiche pilote + bouton d'action).
 * Utilisé à chaque frappe dans le champ dossard du poste HAUT pour rester réactif
 * sans reconstruire toute la vue (et sans faire perdre le focus du champ).
 */
function renderChronoConfirmOnly() {
  const confirmPanel = $("#chrono-confirm-panel");
  if (!confirmPanel) return;

  const dossard = state.chrono.selectedDossard;
  const rider = dossard ? (state.riders[dossard] || readRidersCache()[dossard]) : null;
  const sp = state.chrono.sp;
  const isHaut = state.chrono.poste === "haut";

  if (!rider) {
    confirmPanel.innerHTML = `<div class="empty-state">${isHaut ? "Saisissez un dossard pour afficher la fiche du pilote." : "Sélectionnez un pilote dans la liste, ou saisissez son dossard."}</div>`;
    return;
  }

  const status = riderTimingStatus(dossard, sp);
  let warning = "";
  if (isHaut && (status === "EN_COURSE" || status === "ARRIVE")) {
    const existing = state.timing?.[sp]?.[dossard];
    warning = `<div class="chrono-warning-note">⚠ Départ déjà enregistré à ${formatClock(existing?.depart)} sur ${sp}. Valider écrasera l'ancien temps.</div>`;
  } else if (!isHaut && status === "ARRIVE") {
    const existing = state.timing?.[sp]?.[dossard];
    warning = `<div class="chrono-warning-note">⚠ Arrivée déjà enregistrée à ${formatClock(existing?.arrivee)} sur ${sp}. Valider écrasera l'ancien temps.</div>`;
  }

  const actionLabel = isHaut ? "TOP DÉPART" : "VALIDER ARRIVÉE";
  confirmPanel.innerHTML = `
    <div class="confirm-panel">
      ${warning}
      <span class="plate lg">${rider.dossard}</span>
      <div class="name">${rider.nom} ${rider.prenom}</div>
      <div class="meta">${rider.categorie} · ${rider.sexe} · ${rider.club || "Sans club"} · Licence ${rider.licence || "—"}</div>
      <button class="btn ${isHaut ? "btn-primary" : "btn-success"} btn-lg btn-block" id="btn-chrono-action">${actionLabel}</button>
    </div>
  `;
  $("#btn-chrono-action").addEventListener("click", async () => {
    if (isHaut) await recordDepart(rider.dossard);
    else await recordArrivee(rider.dossard);
    state.chrono.selectedDossard = null;
    const manualInput = $("#chrono-manual-dossard");
    if (manualInput) manualInput.value = "";
    const hautInput = $("#chrono-dossard-haut");
    if (hautInput) hautInput.value = "";
    renderChronoView();
  });
}

/* ================================================================== */
/* CLASSEMENT DÉTAILLÉ ET TRIABLE                                      */
/* ================================================================== */

const CLASSEMENT_COLUMNS_BASE = [
  { key: "positionGenerale", label: "Pos. Gén." },
  { key: "positionCategorie", label: "Pos. Cat." },
  { key: "positionSexe", label: "Pos. Sexe" },
  { key: "dossard", label: "Dossard" },
  { key: "nom", label: "Nom" },
  { key: "prenom", label: "Prénom" },
  { key: "categorie", label: "Cat." },
  { key: "club", label: "Club" }
];
const CLASSEMENT_COLUMNS_TOTALS = [
  { key: "totalSP", label: "Total SP" },
  { key: "totalLiaison", label: "Liaison" },
  { key: "tempsFinal", label: "Temps final" },
  { key: "ecartPremier", label: "Écart 1er" },
  { key: "ecartPrecedent", label: "Écart préc." }
];

function initClassementView() {
  $("#classement-search")?.addEventListener("input", (e) => { state.classement.search = e.target.value; renderClassementView(); });
  $("#classement-categorie")?.addEventListener("change", (e) => { state.classement.categorie = e.target.value; renderClassementView(); });
  $("#classement-sexe")?.addEventListener("change", (e) => { state.classement.sexe = e.target.value; renderClassementView(); });
  [...document.querySelectorAll(".btn-export-excel")].forEach((btn) => btn.addEventListener("click", exportCurrentClassement));

  const catSelect = $("#classement-categorie");
  if (catSelect) catSelect.innerHTML = `<option value="">Toutes catégories</option>` + CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");
}

function getFilteredSortedClassement() {
  const config = state.config || {};
  const { rows, spList } = computeClassement(state.riders, state.timing, config);
  let filtered = rows;
  const { search, categorie, sexe, sortKey, sortDir } = state.classement;
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter((r) => [r.nom, r.prenom, r.dossard].join(" ").toLowerCase().includes(s));
  }
  if (categorie) filtered = filtered.filter((r) => r.categorie === categorie);
  if (sexe) filtered = filtered.filter((r) => r.sexe === sexe);
  filtered = sortRows(filtered, sortKey, sortDir);
  return { rows: filtered, spList };
}

function exportCurrentClassement() {
  try {
    const { rows, spList } = getFilteredSortedClassement();
    const filename = exportClassementToExcel(rows, spList, { eventName: state.config?.eventName });
    toast(`Export généré : ${filename}`, "success");
  } catch (err) {
    toast("Échec de l'export : " + err.message, "error");
  }
}

function renderClassementHeader(spList) {
  const groupRow = $("#classement-thead-group");
  const colsRow = $("#classement-thead-cols");
  if (!groupRow || !colsRow) return;

  groupRow.innerHTML = `<th colspan="${CLASSEMENT_COLUMNS_BASE.length}">Identité</th>` +
    spList.map((sp) => `<th colspan="6">${sp}</th>`).join("") +
    `<th colspan="${CLASSEMENT_COLUMNS_TOTALS.length}">Totaux</th>`;

  const sortableTh = (key, label) => {
    const active = state.classement.sortKey === key;
    const arrow = active ? (state.classement.sortDir === "asc" ? "▲" : "▼") : "";
    return `<th class="sortable ${active ? "sorted" : ""}" data-sort-key="${key}">${label} <span class="sort-arrow">${arrow}</span></th>`;
  };

  let cols = CLASSEMENT_COLUMNS_BASE.map((c) => sortableTh(c.key, c.label)).join("");
  spList.forEach((sp) => {
    cols += sortableTh(`sp:${sp}:depart`, "Départ");
    cols += sortableTh(`sp:${sp}:arrivee`, "Arrivée");
    cols += sortableTh(`sp:${sp}:tempsRetenu`, "Temps");
    cols += sortableTh(`sp:${sp}:penalite`, "Pénal.");
    cols += sortableTh(`sp:${sp}:neutralisation`, "Neutral.");
    cols += `<th>Statut</th>`;
  });
  cols += CLASSEMENT_COLUMNS_TOTALS.map((c) => sortableTh(c.key, c.label)).join("");
  colsRow.innerHTML = cols;

  $all(".sortable", colsRow).forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sortKey;
    if (state.classement.sortKey === key) {
      state.classement.sortDir = state.classement.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.classement.sortKey = key; state.classement.sortDir = "asc";
    }
    renderClassementView();
  }));
}

function renderClassementView() {
  const tbody = $("#classement-tbody");
  if (!tbody) return;
  const { rows, spList } = getFilteredSortedClassement();
  renderClassementHeader(spList);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${CLASSEMENT_COLUMNS_BASE.length + spList.length * 6 + CLASSEMENT_COLUMNS_TOTALS.length}" class="empty-state">Aucun résultat pour ces filtres.</td></tr>`;
    return;
  }

  const posClass = (pos) => pos === 1 ? "gold" : pos === 2 ? "silver" : pos === 3 ? "bronze" : "";

  tbody.innerHTML = rows.map((r) => {
    let cells = `
      <td><span class="position-badge ${posClass(r.positionGenerale)}">${r.positionGenerale ?? "—"}</span></td>
      <td>${r.positionCategorie ?? "—"}</td>
      <td>${r.positionSexe ?? "—"}</td>
      <td><span class="plate ${r.statutGlobal === "EN_COURSE" ? "on-track blink-orange" : r.statutGlobal === "ARRIVE" ? "arrived" : ""}">${r.dossard}</span></td>
      <td>${r.nom}</td>
      <td>${r.prenom}</td>
      <td>${r.categorie}</td>
      <td>${r.club || ""}</td>
    `;
    spList.forEach((sp) => {
      const c = r.parSP[sp];
      cells += `
        <td class="mono dim">${formatClock(c.depart)}</td>
        <td class="mono dim">${formatClock(c.arrivee)}</td>
        <td class="mono">${formatMs(c.tempsRetenu)}</td>
        <td class="mono dim">${c.penalite ? "+" + formatMs(c.penalite) : "—"}</td>
        <td class="mono dim">${c.neutralisation ? "−" + formatMs(c.neutralisation) : "—"}</td>
        <td><span class="status-tag status-${c.statut === "ATTENTE" ? "attente" : c.statut === "EN_COURSE" ? "en-course" : "arrive"}">${statusLabel(c.statut)}</span></td>
      `;
    });
    cells += `
      <td class="mono">${formatMs(r.totalSP)}</td>
      <td class="mono dim">${formatMs(r.totalLiaison)}</td>
      <td class="mono" style="font-weight:700;">${formatMs(r.tempsFinal)}</td>
      <td class="mono dim">${r.tempsFinal !== null ? (r.ecartPremier ? "+" + formatMs(r.ecartPremier) : "—") : ""}</td>
      <td class="mono dim">${r.tempsFinal !== null ? (r.ecartPrecedent ? "+" + formatMs(r.ecartPrecedent) : "—") : ""}</td>
    `;
    return `<tr>${cells}</tr>`;
  }).join("");
}

/* ================================================================== */
/* OUTILS                                                              */
/* ================================================================== */

function renderOutilsAnomalies() {
  const list = $("#outils-anomalies-list");
  if (!list) return;
  const anomalies = detectAnomalies(state.riders, state.timing, state.config || {});
  if (!anomalies.length) {
    list.innerHTML = `<div class="empty-state">Aucune anomalie détectée.</div>`;
    return;
  }
  list.innerHTML = anomalies.map((a) => `
    <div class="anomaly-row anomaly-${a.severity}">
      <span class="anomaly-icon">${a.severity === "error" ? "⛔" : "⚠️"}</span>
      <div class="info">
        <div>${a.message}</div>
      </div>
      ${a.dossard && state.riders[a.dossard] ? `<button class="btn btn-secondary btn-sm anomaly-open" data-dossard="${a.dossard}">Ouvrir la fiche</button>` : ""}
    </div>
  `).join("");
  $all(".anomaly-open", list).forEach((btn) => btn.addEventListener("click", () => { switchTab("pilotes"); openRiderDetail(btn.dataset.dossard); }));
}

function initOutilsView() {
  $("#btn-force-sync")?.addEventListener("click", () => {
    toast("Synchronisation forcée…", "info");
    flushQueue();
  });
  $("#btn-toggle-public-outils")?.addEventListener("click", togglePublicVisibility);
  $("#btn-reset-all-timing")?.addEventListener("click", async () => {
    if (!confirm("Réinitialiser TOUS les temps de TOUS les pilotes ? Cette action est irréversible (utile avant un essai à blanc).")) return;
    if (!confirm("Confirmez une seconde fois : tous les départs/arrivées de la course seront effacés.")) return;
    const spList = spKeys(state.config?.numSpeciales || 0);
    for (const dossard of Object.keys(state.riders)) {
      spList.forEach((sp) => { if (state.timing[sp]) delete state.timing[sp][dossard]; });
      if (state.connection === "online") {
        try { await resetRiderTiming(dossard, spList); } catch { enqueue({ type: "reset", dossard, spList }); }
      } else {
        enqueue({ type: "reset", dossard, spList });
      }
    }
    cacheTiming(state.timing);
    renderChronoView(); renderClassementView(); renderDashboard(); renderOutilsAnomalies();
    toast("Tous les temps ont été réinitialisés.", "success");
  });
}

/* ================================================================== */
/* INITIALISATION GÉNÉRALE                                             */
/* ================================================================== */

function initAdminApp() {
  state.riders = readRidersCache();
  state.timing = readTimingCache();

  initConnectionWatcher();
  initTabs();
  initParametresView();
  initRidersView();
  initRiderDetailModal();
  initChronoView();
  initClassementView();
  initOutilsView();

  watchEventConfig((config) => {
    if (config) {
      state.config = config;
      applyConfigToParametresForm(config);
      renderChronoView(); renderClassementView(); renderDashboard(); renderOutilsAnomalies();
    }
  });

  watchRiders((riders) => {
    state.riders = riders;
    cacheRiders(riders);
    renderRidersTable(); renderChronoView(); renderClassementView(); renderDashboard(); renderOutilsAnomalies();
  });

  watchTiming((timing) => {
    state.timing = timing;
    cacheTiming(timing);
    renderChronoView(); renderClassementView(); renderDashboard(); renderOutilsAnomalies();
    if (state.detail.dossard) renderRiderDetailTiming();
  });

  renderRidersTable(); renderChronoView(); renderClassementView(); renderDashboard(); renderOutilsAnomalies();
}

if (document.getElementById("view-dashboard")) {
  document.addEventListener("DOMContentLoaded", initAdminApp);
}
