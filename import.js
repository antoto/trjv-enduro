// import.js — Import de fichiers Excel (FFC .xls / .xlsx) avec mapping automatique des colonnes.
// Utilise SheetJS (chargé en global "XLSX" via CDN dans index.html).

// Alias possibles trouvés dans les exports FFC / fichiers de licences.
const COLUMN_ALIASES = {
  nom: ["nom", "name", "nom pilote", "last name", "lastname"],
  prenom: ["prenom", "prénom", "first name", "firstname"],
  sexe: ["sexe", "sex", "genre"],
  categorie: ["categorie", "catégorie", "cat", "category", "classe"],
  club: ["club", "club nom", "structure"],
  licence: ["licence", "license", "num licence", "numero licence", "n° licence", "n licence"],
  dossard: ["dossard", "num dossard", "numero dossard", "n° dossard", "bib", "plaque"]
};

function normalizeHeader(h) {
  return String(h || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // enlève les accents
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildColumnMap(headerRow) {
  const map = {}; // fieldName -> column index
  const normalizedHeaders = headerRow.map(normalizeHeader);

  Object.entries(COLUMN_ALIASES).forEach(([field, aliases]) => {
    const normalizedAliases = aliases.map(normalizeHeader);
    const idx = normalizedHeaders.findIndex((h) => normalizedAliases.includes(h));
    if (idx !== -1) map[field] = idx;
  });

  return map;
}

function normalizeSexe(val) {
  const v = String(val || "").trim().toUpperCase();
  if (["H", "M", "MASCULIN", "HOMME"].includes(v)) return "H";
  if (["F", "FEMININ", "FÉMININ", "FEMME"].includes(v)) return "F";
  return v.charAt(0) || "";
}

function normalizeCategorie(val) {
  const v = String(val || "").trim().toUpperCase().replace(/\s+/g, "");
  const match = v.match(/U(11|13|15|17)/);
  return match ? `U${match[1]}` : v;
}

/**
 * Lit un fichier Excel (File) et retourne { riders, duplicates, errors, columnMap }
 * riders: tableau d'objets pilotes prêts à être enregistrés
 * duplicates: liste des numéros de dossard en doublon dans le fichier importé
 * errors: lignes ignorées faute de dossard
 */
export function parseRidersExcel(file) {
  return new Promise((resolve, reject) => {
    if (typeof XLSX === "undefined") {
      reject(new Error("La bibliothèque SheetJS (XLSX) n'est pas chargée."));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Impossible de lire le fichier."));
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

        if (!rows.length) {
          resolve({ riders: [], duplicates: [], errors: ["Fichier vide."], columnMap: {} });
          return;
        }

        const headerRow = rows[0];
        const columnMap = buildColumnMap(headerRow);
        const dataRows = rows.slice(1).filter((r) => r.some((cell) => String(cell).trim() !== ""));

        const riders = [];
        const errors = [];
        const seenInFile = new Set();
        const duplicates = new Set();

        dataRows.forEach((row, i) => {
          const get = (field) => (columnMap[field] !== undefined ? row[columnMap[field]] : "");
          const dossardRaw = get("dossard");
          const dossard = String(dossardRaw).trim();

          if (!dossard) {
            errors.push(`Ligne ${i + 2} ignorée : dossard manquant.`);
            return;
          }

          if (seenInFile.has(dossard)) {
            duplicates.add(dossard);
          }
          seenInFile.add(dossard);

          riders.push({
            id: dossard,
            dossard,
            nom: String(get("nom")).trim().toUpperCase(),
            prenom: String(get("prenom")).trim(),
            sexe: normalizeSexe(get("sexe")),
            categorie: normalizeCategorie(get("categorie")),
            club: String(get("club")).trim(),
            licence: String(get("licence")).trim()
          });
        });

        resolve({ riders, duplicates: Array.from(duplicates), errors, columnMap });
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Compare les dossards importés à ceux déjà présents en base.
 * Retourne la liste des dossards qui existent déjà côté serveur.
 */
export function findExistingDossardConflicts(importedRiders, existingRidersByDossard) {
  return importedRiders
    .map((r) => r.dossard)
    .filter((d) => existingRidersByDossard && existingRidersByDossard[d]);
}
