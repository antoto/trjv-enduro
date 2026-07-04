// export.js — Génération d'un fichier Excel (XLSX) du classement détaillé,
// en respectant les filtres actifs. Utilise SheetJS (global "XLSX").

function formatMs(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return "";
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
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("fr-FR", { hour12: false });
}

/**
 * rows: sortie de computeClassement() (classement.js) — déjà filtrée/triée.
 * spList: ["SP1","SP2",...]
 */
export function exportClassementToExcel(rows, spList, meta = {}) {
  if (typeof XLSX === "undefined") {
    throw new Error("La bibliothèque SheetJS (XLSX) n'est pas chargée.");
  }

  const header = [
    "Pos. Gén.", "Pos. Cat.", "Pos. Sexe", "Dossard", "Nom", "Prénom", "Sexe", "Catégorie", "Club"
  ];
  spList.forEach((sp) => {
    header.push(`${sp} Départ`, `${sp} Arrivée`, `${sp} Temps`, `${sp} Pénal.`, `${sp} Neutral.`, `${sp} Statut`);
  });
  header.push("Total spéciales", "Liaison", "Temps final", "Écart 1er", "Écart préc.");

  const dataRows = rows.map((r) => {
    const row = [
      r.positionGenerale ?? "", r.positionCategorie ?? "", r.positionSexe ?? "",
      r.dossard, r.nom, r.prenom, r.sexe, r.categorie, r.club || ""
    ];
    spList.forEach((sp) => {
      const c = r.parSP[sp] || {};
      row.push(
        formatClock(c.depart),
        formatClock(c.arrivee),
        formatMs(c.tempsRetenu),
        c.penalite ? formatMs(c.penalite) : "",
        c.neutralisation ? formatMs(c.neutralisation) : "",
        c.statut
      );
    });
    row.push(
      formatMs(r.totalSP),
      formatMs(r.totalLiaison),
      formatMs(r.tempsFinal),
      r.ecartPremier ? "+" + formatMs(r.ecartPremier) : (r.tempsFinal !== null ? "—" : ""),
      r.ecartPrecedent ? "+" + formatMs(r.ecartPrecedent) : (r.tempsFinal !== null ? "—" : "")
    );
    return row;
  });

  const worksheet = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  worksheet["!cols"] = header.map(() => ({ wch: 12 }));

  const workbook = XLSX.utils.book_new();
  const sheetName = (meta.eventName || "Classement").substring(0, 28) || "Classement";
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  const filenameBase = (meta.eventName || "classement")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_");
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${filenameBase}_classement_${dateStr}.xlsx`;

  XLSX.writeFile(workbook, filename);
  return filename;
}
