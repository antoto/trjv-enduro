// classement.js — Calcul du classement détaillé et détection d'anomalies.
// Module pur (aucun accès DOM, aucun accès Firebase) : facilement testable et réutilisé
// par app.js (admin) et public.html (lecture seule).

/** Construit la liste ordonnée des clés de spéciales : ["SP1", "SP2", ...] */
export function spKeys(numSpeciales) {
  return Array.from({ length: numSpeciales || 0 }, (_, i) => `SP${i + 1}`);
}

/** Temps de liaison effectif (ms) pour une spéciale donnée : surcharge par pilote sinon valeur globale. */
export function getLiaisonMs(config, sp, timingEntry) {
  if (timingEntry && typeof timingEntry.liaison === "number") return timingEntry.liaison;
  const minutes = config?.liaisonTimes?.[sp] || 0;
  return minutes * 60000;
}

/** Temps retenu sur une spéciale = temps réalisé + pénalité − neutralisation (jamais négatif). */
function tempsRetenu(entry) {
  if (!entry || !entry.depart || !entry.arrivee) return null;
  const realise = entry.arrivee - entry.depart;
  const penalite = entry.penalite || 0;
  const neutralisation = entry.neutralisation || 0;
  return Math.max(0, realise + penalite - neutralisation);
}

/** Attribution de rangs "1-2-2-4" (ex-æquo partagent la même position, la suivante saute). */
function assignRanks(rows, valueFn) {
  let pos = 0;
  let lastVal;
  rows.forEach((r, i) => {
    const val = valueFn(r);
    if (val === null || val === undefined) return;
    if (val !== lastVal) { pos = i + 1; lastVal = val; }
    r.__rank = pos;
  });
}

/**
 * Calcule le classement détaillé.
 * riders: { dossard: riderObj }
 * timing: { SPn: { dossard: { depart, arrivee, penalite, neutralisation, liaison, statut } } }
 * config: { numSpeciales, liaisonsEnabled, liaisonTimes, anomalyThresholdMin }
 *
 * Retourne un tableau de lignes prêtes à afficher / trier / exporter.
 */
export function computeClassement(riders, timing, config) {
  const spList = spKeys(config?.numSpeciales || 0);
  const liaisonsEnabled = !!config?.liaisonsEnabled;

  const rows = Object.values(riders || {}).map((rider) => {
    const parSP = {};
    let totalSP = null;
    let totalLiaison = 0;
    let nbCompletes = 0;
    let statutGlobal = "ATTENTE";

    spList.forEach((sp) => {
      const entry = timing?.[sp]?.[rider.dossard] || null;
      const realise = entry && entry.depart && entry.arrivee ? entry.arrivee - entry.depart : null;
      const retenu = tempsRetenu(entry);
      const liaisonMs = getLiaisonMs(config, sp, entry);

      let statutSP = "ATTENTE";
      if (entry && entry.depart && entry.arrivee) statutSP = "ARRIVE";
      else if (entry && entry.depart) statutSP = "EN_COURSE";

      parSP[sp] = {
        depart: entry?.depart ?? null,
        arrivee: entry?.arrivee ?? null,
        tempsRealise: realise,
        penalite: entry?.penalite || 0,
        neutralisation: entry?.neutralisation || 0,
        tempsRetenu: retenu,
        liaison: liaisonMs,
        statut: statutSP
      };

      if (statutSP === "ARRIVE") {
        nbCompletes++;
        totalSP = (totalSP ?? 0) + retenu;
        totalLiaison += liaisonMs;
      }
      if (statutSP === "EN_COURSE") statutGlobal = "EN_COURSE";
    });

    if (nbCompletes === spList.length && spList.length > 0) statutGlobal = "ARRIVE";
    else if (statutGlobal !== "EN_COURSE" && nbCompletes > 0) statutGlobal = "EN_COURSE";

    const tempsFinal = nbCompletes === spList.length && spList.length > 0
      ? totalSP + (liaisonsEnabled ? totalLiaison : 0)
      : null;

    return {
      dossard: rider.dossard,
      nom: rider.nom,
      prenom: rider.prenom,
      sexe: rider.sexe,
      categorie: rider.categorie,
      club: rider.club,
      parSP,
      nbCompletes,
      totalSP,
      totalLiaison: liaisonsEnabled ? totalLiaison : 0,
      tempsFinal,
      statutGlobal
    };
  });

  // Tri par défaut : temps final croissant, puis nombre de SP complétées (les plus avancés d'abord),
  // puis ordre alphabétique pour les pilotes n'ayant pas encore de temps.
  rows.sort((a, b) => {
    if (a.tempsFinal !== null && b.tempsFinal !== null) return a.tempsFinal - b.tempsFinal;
    if (a.tempsFinal !== null) return -1;
    if (b.tempsFinal !== null) return 1;
    if (a.nbCompletes !== b.nbCompletes) return b.nbCompletes - a.nbCompletes;
    return a.nom.localeCompare(b.nom);
  });

  assignRanks(rows, (r) => r.tempsFinal);
  rows.forEach((r) => { r.positionGenerale = r.__rank ?? null; delete r.__rank; });

  // Positions par catégorie
  ["U11", "U13", "U15", "U17"].forEach((cat) => {
    const subset = rows.filter((r) => r.categorie === cat).sort((a, b) => {
      if (a.tempsFinal !== null && b.tempsFinal !== null) return a.tempsFinal - b.tempsFinal;
      if (a.tempsFinal !== null) return -1;
      if (b.tempsFinal !== null) return 1;
      return 0;
    });
    assignRanks(subset, (r) => r.tempsFinal);
    subset.forEach((r) => { r.positionCategorie = r.__rank ?? null; delete r.__rank; });
  });

  // Positions par sexe
  ["H", "F"].forEach((sexe) => {
    const subset = rows.filter((r) => r.sexe === sexe).sort((a, b) => {
      if (a.tempsFinal !== null && b.tempsFinal !== null) return a.tempsFinal - b.tempsFinal;
      if (a.tempsFinal !== null) return -1;
      if (b.tempsFinal !== null) return 1;
      return 0;
    });
    assignRanks(subset, (r) => r.tempsFinal);
    subset.forEach((r) => { r.positionSexe = r.__rank ?? null; delete r.__rank; });
  });

  // Écarts (uniquement pour les pilotes classés, sur le temps final)
  const classes = rows.filter((r) => r.tempsFinal !== null);
  const leaderTime = classes.length ? classes[0].tempsFinal : null;
  rows.forEach((r, i) => {
    if (r.tempsFinal === null) { r.ecartPremier = null; r.ecartPrecedent = null; return; }
    r.ecartPremier = leaderTime !== null ? r.tempsFinal - leaderTime : null;
    const prevClasse = classes[classes.indexOf(r) - 1];
    r.ecartPrecedent = prevClasse ? r.tempsFinal - prevClasse.tempsFinal : 0;
  });

  return { rows, spList };
}

/**
 * Détecte les anomalies "structurelles" visibles dans les données (indépendamment
 * des tentatives d'action bloquées côté UI, qui sont, elles, notifiées immédiatement).
 */
export function detectAnomalies(riders, timing, config) {
  const spList = spKeys(config?.numSpeciales || 0);
  const thresholdMs = (config?.anomalyThresholdMin || 20) * 60000;
  const now = Date.now();
  const anomalies = [];

  spList.forEach((sp) => {
    const spTiming = timing?.[sp] || {};
    Object.entries(spTiming).forEach(([dossard, entry]) => {
      const rider = riders?.[dossard];
      const label = rider ? `${rider.nom} ${rider.prenom} (#${dossard})` : `Dossard #${dossard} (inconnu)`;

      if (!rider) {
        anomalies.push({ type: "dossard_inconnu", sp, dossard, severity: "warn", message: `${label} a des temps enregistrés sur ${sp} mais n'existe plus dans la liste des pilotes.` });
      }
      if (entry.arrivee && !entry.depart) {
        anomalies.push({ type: "arrivee_sans_depart", sp, dossard, severity: "error", message: `${label} : arrivée enregistrée sur ${sp} sans départ correspondant.` });
      }
      if (entry.depart && !entry.arrivee) {
        const duration = now - entry.depart;
        if (duration > thresholdMs) {
          anomalies.push({ type: "en_course_trop_longtemps", sp, dossard, severity: "warn", message: `${label} est en course sur ${sp} depuis plus de ${Math.round(duration / 60000)} min.` });
        }
      }
    });
  });

  return anomalies;
}

/* ================================================================== */
/* TRI GÉNÉRIQUE DU TABLEAU DE CLASSEMENT                              */
/* ================================================================== */

/** Extrait la valeur triable d'une ligne pour une clé de tri donnée. */
export function getSortValue(row, sortKey) {
  if (sortKey.startsWith("sp:")) {
    const [, sp, field] = sortKey.split(":");
    const cell = row.parSP[sp];
    if (!cell) return null;
    return cell[field];
  }
  return row[sortKey];
}

export function sortRows(rows, sortKey, sortDir) {
  const sorted = [...rows].sort((a, b) => {
    const va = getSortValue(a, sortKey);
    const vb = getSortValue(b, sortKey);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === "string") return va.localeCompare(vb);
    return va - vb;
  });
  if (sortDir === "desc") sorted.reverse();
  return sorted;
}
