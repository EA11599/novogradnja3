// Dnevni pipeline za praćenje izdanih dozvola preko eDozvola oglasne ploče.
//
// PROMJENA U ODNOSU NA PRVU VERZIJU: umjesto ručnih fetch() poziva iz Node-a,
// koristimo Puppeteer (pravi Chrome u pozadini, "headless"). Razlog: otkriveno
// je da case-acts/search zahtijeva Bearer token koji edozvola.gov.hr
// dodjeljuje kroz Keycloak "silent SSO" mehanizam (skriveni iframe +
// postMessage + kolačići) prilikom normalnog učitavanja stranice u
// pregledniku — taj tok je prekompliciran/lomljiv za ručno oponašanje.
// Puppeteer to zaobilazi jednostavno: otvori pravu stranicu, pričekaj da se
// autentificira sama, pa iz TE iste (već prijavljene) stranice pozove naše
// fetch()-ove — oni onda automatski nose ispravan token/kolačiće.
//
// STATUS DIJELOVA (30.07.2026):
//   ✅ POTVRĐENO RADI:  regex ekstrakcija adrese/tipa iz teksta PDF-a
//   ✅ RIJEŠENO:        case-acts/search 401 problem (Puppeteer pristup)
//   ⚠️  I DALJE NEPOTVRĐENO: hoće li dohvat SADRŽAJA PDF-a (preview-file →
//       document-preview) uspjeti i iz autentificirane sesije, ili je taj
//       dio ipak vezan uz osobnu (ne anonimnu) prijavu. Skripta i dalje ima
//       fallback ako ne uspije — vidi fetchDocumentText.

const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const puppeteer = require("puppeteer");

const API_BASE = "https://edozvola.gov.hr/api";
const NOTICE_BOARD_URL = "https://edozvola.gov.hr/notice-board";
const DATA_DIR = path.join(__dirname, "..", "data", "dozvole");
const DNEVNIK_PATH = path.join(DATA_DIR, "dnevnik.json");
const MANIFEST_PATH = path.join(DATA_DIR, "manifest.json");

const RELEVANT_ACT_TYPES = new Set([
  "Građevinska dozvola",
  "Lokacijska dozvola",
  "Uporabna dozvola",
]);

const LOCATION_PATTERN =
  /na k\.č\.br\.\s*([\d/]+),\s*K\.O\.\s*([A-ZŠĐČĆŽ ]+)\s*[–-]\s*lokacija;\s*(.+?)(?:,\s*u skladu\b|\.\s|\n|$)/is;
const BUILDING_TYPE_PATTERN =
  /–\s*(izgradnja|rekonstrukcija)[^,]*,\s*([\d.]+[a-z]?)\s*skupine/i;

// Nominatim NIJE iza edozvola autentifikacije — ide direktno preko Node-a,
// ne treba Puppeteer za ovaj poziv.
const NOMINATIM_USER_AGENT = "dozvole-pipeline/1.0 (ealeksic11@gmail.com)";

function isCompany(name) {
  return /d\.o\.o\.|j\.d\.o\.o\.|d\.d\.|obrt|j\.t\.d\./i.test(name || "");
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function geocodeAddress(addressText) {
  try {
    const query = encodeURIComponent(`${addressText}, Hrvatska`);
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=hr&q=${query}`;
    const res = await fetch(url, { headers: { "User-Agent": NOMINATIM_USER_AGENT } });
    if (!res.ok) return null;
    const results = await res.json();
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
  } catch {
    return null;
  }
}

function extractFromPdfText(pdfText) {
  const locMatch = pdfText.match(LOCATION_PATTERN);
  const typeMatch = pdfText.match(BUILDING_TYPE_PATTERN);
  if (!locMatch) return null;
  const [, cadastralParcel, cadastralMunicipality, addressText] = locMatch;
  return {
    cadastralParcel: cadastralParcel.trim(),
    cadastralMunicipality: cadastralMunicipality.trim(),
    address: addressText.trim(),
    buildingType: typeMatch ? `${typeMatch[1]}, skupina ${typeMatch[2]}` : null,
  };
}

// --- Pozivi koji se izvršavaju UNUTAR autentificirane stranice preko page.evaluate ---

async function fetchCaseActsPage(page, pageNum, size = 50) {
  const url =
    `${API_BASE}/cases/case-acts/search?page=${pageNum}&size=${size}` +
    `&column=createdDate&direction=desc&searchParam=`;
  return page.evaluate(async (u) => {
    const res = await fetch(u, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`case-acts/search vratio status ${res.status}`);
    return res.json();
  }, url);
}

async function fetchNewCaseActs(page, seenIds, maxPages = 20) {
  const collected = [];
  for (let p = 0; p < maxPages; p++) {
    const data = await fetchCaseActsPage(page, p);
    if (!data.content || data.content.length === 0) break;

    let hitKnown = false;
    for (const item of data.content) {
      if (seenIds.has(item.idCaseAct)) {
        hitKnown = true;
        continue;
      }
      if (RELEVANT_ACT_TYPES.has(item.name)) collected.push(item);
    }
    if (hitKnown || data.last) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return collected;
}

// Dohvat sadržaja PDF-a iz autentificirane stranice. Binarni sadržaj se
// unutar page.evaluate pretvori u base64 (jer page.evaluate može vratiti
// samo serijalizirljive podatke Node-u), pa se u Node-u dekodira natrag.
async function fetchDocumentText(page, idCaseAct) {
  try {
    const preview = await page.evaluate(async (url) => {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) return { error: `preview-file status ${res.status}` };
      return res.json();
    }, `${API_BASE}/cases/case-acts/${idCaseAct}/preview-file`);

    if (preview.error) return { text: null, reason: preview.error };
    if (!preview.url) return { text: null, reason: "preview-file nema 'url' polje" };

    const docResult = await page.evaluate(async (relUrl) => {
      const res = await fetch(`https://edozvola.gov.hr${relUrl}`);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/pdf")) {
        return { ok: false, contentType, status: res.status };
      }
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { ok: true, base64: btoa(binary) };
    }, preview.url);

    if (!docResult.ok) {
      return {
        text: null,
        reason: `document-preview nije vratio PDF (status ${docResult.status}, content-type: ${docResult.contentType})`,
      };
    }

    const buf = Buffer.from(docResult.base64, "base64");
    const parsed = await pdfParse(buf);
    return { text: parsed.text, reason: null };
  } catch (err) {
    return { text: null, reason: `greška: ${err.message}` };
  }
}

// --- Glavni tijek ---
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const dnevnik = loadJson(DNEVNIK_PATH, []);
  const manifest = loadJson(MANIFEST_PATH, { lastRun: null, totalEntries: 0 });
  const seenIds = new Set(dnevnik.map((d) => d.idCaseAct));

  console.log(`Postojeći dnevnik: ${dnevnik.length} zapisa.`);
  console.log("Pokrećem headless preglednik i učitavam oglasnu ploču...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let newActs = [];

  try {
    const page = await browser.newPage();
    await page.goto(NOTICE_BOARD_URL, { waitUntil: "networkidle2", timeout: 60000 });

    console.log("Stranica učitana, čekam da se Keycloak silent SSO dovrši...");
    // Umjesto fiksne pauze, pokušavaj pravi API poziv dok ne prođe (do 401
    // nestane) ili dok ne isteknemo pokušaje - SSO vrijeme varira i fiksna
    // pauza je nepouzdana.
    let ssoSpreman = false;
    let zadnjaGreska = null;
    for (let pokusaj = 1; pokusaj <= 8; pokusaj++) {
      try {
        await fetchCaseActsPage(page, 0, 1); // probni poziv, samo 1 zapis
        ssoSpreman = true;
        console.log(`SSO spreman nakon pokušaja ${pokusaj}.`);
        break;
      } catch (err) {
        zadnjaGreska = err;
        console.log(`  Pokušaj ${pokusaj}/8 neuspio (${err.message}), čekam 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!ssoSpreman) {
      throw new Error(`SSO se nije dovršio nakon 8 pokušaja: ${zadnjaGreska?.message}`);
    }

    console.log("Tražim nove akte...");
    newActs = await fetchNewCaseActs(page, seenIds);
    console.log(`Pronađeno ${newActs.length} novih relevantnih akata.`);

    for (const act of newActs) {
      const { text, reason } = await fetchDocumentText(page, act.idCaseAct);
      const extracted = text ? extractFromPdfText(text) : null;

      let coordinates = null;
      if (extracted?.address) {
        await new Promise((r) => setTimeout(r, 1100)); // Nominatim: 1 zahtjev/s
        coordinates = await geocodeAddress(extracted.address);
        if (!coordinates) console.warn(`  ⚠ Geokodiranje nije uspjelo za: ${extracted.address}`);
      }

      const entry = {
        idCaseAct: act.idCaseAct,
        classification: act.classification,
        actType: act.name,
        createdDate: act.createdDate,
        roughLocation: act.locations || null,
        applicant: isCompany(act.applicantName) ? act.applicantName : "Privatni investitor",
        address: extracted?.address || null,
        buildingType: extracted?.buildingType || null,
        cadastralParcel: extracted?.cadastralParcel || null,
        cadastralMunicipality: extracted?.cadastralMunicipality || null,
        coordinates,
        documentStatus: text ? (extracted ? "ok" : "pdf_bez_prepoznatog_obrasca") : "pdf_nedostupan",
        documentIssue: reason,
        noticeBoardUrl: NOTICE_BOARD_URL,
      };

      dnevnik.push(entry);
      seenIds.add(act.idCaseAct);

      if (!text) console.warn(`  ⚠ ${act.classification}: ${reason}`);

      await new Promise((r) => setTimeout(r, 800));
    }
  } finally {
    await browser.close();
  }

  dnevnik.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));

  saveJson(DNEVNIK_PATH, dnevnik);
  saveJson(MANIFEST_PATH, {
    lastRun: new Date().toISOString(),
    totalEntries: dnevnik.length,
    newThisRun: newActs.length,
  });

  console.log(`Gotovo. Dnevnik sad ima ${dnevnik.length} zapisa (+${newActs.length} novih).`);
}

main().catch((err) => {
  console.error("Pipeline pao s greškom:", err);
  process.exit(1);
});
