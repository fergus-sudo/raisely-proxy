// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();

// ---- ENV -------------------------------------------------
const API_KEY = process.env.RAISELY_API_KEY;          // raisely-sk-...
const CAMPAIGN_UUID = process.env.CAMPAIGN_UUID;      // 57b63970-...572ff
const BASE = "https://api.raisely.com/v3";
const H = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
};

// Utility
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async (url) => {
  const res = await fetch(url, { headers: H });
  if (!res.ok) throw { url, status: res.status, body: await safeJson(res) };
  return res.json();
};
const safeJson = async (res) => {
  try { return await res.json(); } catch { return await res.text(); }
};
const listAll = async (url, limit = 200, max = 1000) => {
  const out = [];
  let next = url.includes("limit=") ? url : `${url}${url.includes("?") ? "&" : "?"}limit=${limit}`;
  while (next && out.length < max) {
    const j = await get(next);
    const items = j?.data || j?.profiles || j?.activities || j?.campaigns || [];
    out.push(...items);
    next = j?.links?.next;
  }
  return out;
};

// ---- Discovery helpers -----------------------------------
const fetchCampaign = async () => get(`${BASE}/campaigns/${CAMPAIGN_UUID}`);

const fetchProfilesByCampaign = async (limit = 200) =>
  listAll(`${BASE}/profiles?campaign=${CAMPAIGN_UUID}&limit=${limit}`);

const fetchProfileActivities = async (profileUuid, limit = 100) =>
  listAll(`${BASE}/profiles/${profileUuid}/activities?order=desc&sort=createdAt&limit=${limit}`);

// Commute heuristics: what “counts”
const COMMUTE_TYPES = new Set([
  "Run", "Running", "Walk", "Walking",
  "Wheelchair", "Wheelchairing", "Ride", "Cycling", "Bike", "E-Bike Ride",
  "Canoe", "Kayak", "Row", "Swim", "Swimmming", "Swimming",
]);

const looksLikeCommute = (a) => {
  const t = (a?.type || a?.sport || "").trim();
  const title = `${a?.name || a?.title || ""}`.toLowerCase();
  const desc  = `${a?.description || ""}`.toLowerCase();

  // Strava commute flag sometimes arrives via custom key
  const commuteFlag = !!(a?.isCommute || a?.metadata?.isCommute || a?.attributes?.commute);

  // Raisely manual form types → map into the set above
  const inSet = COMMUTE_TYPES.has(t);

  // allow keyword match if user tagged it
  const keyword = title.includes("commute") || desc.includes("commute");

  return commuteFlag || inSet || keyword;
};

const distanceKm = (a) => {
  // Raisely activities normally have distance objects; Strava may come in as meters
  const d = a?.distance;
  if (!d) return 0;

  if (typeof d === "number") {
    // assume meters if suspiciously large
    return d > 1000 ? d / 1000 : d;
  }
  if (typeof d?.value === "number") {
    const unit = (d?.unit || "").toLowerCase();
    if (unit === "m" || unit === "meter" || unit === "meters") return d.value / 1000;
    return d.value; // assume km
  }
  return 0;
};

// ---- PROBE (diagnostics) ---------------------------------
app.get("/", (_req, res) => res.type("text").send("Raisely commute proxy is running"));

app.get("/peek", async (_req, res) => {
  try {
    const env = { haveKey: !!API_KEY, haveCampaign: !!CAMPAIGN_UUID };
    const check = {
      "GET /campaigns/{uuid}": (await fetchCampaign(), 200),
      "GET /campaign-profiles/{uuid}": 404, // not wired in this workspace
    };
    const profiles = await fetchProfilesByCampaign(200);
    res.json({
      env, check,
      profilesCount: profiles.length,
      triedProfilesUrls: [`${BASE}/profiles?campaign=${CAMPAIGN_UUID}&limit=200`],
      siteSlug: null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "peek failed", detail: e });
  }
});

// Add-on: show a few profiles *with* their activity counts and a sample
app.get("/peek-activities", async (_req, res) => {
  try {
    const profiles = await fetchProfilesByCampaign(50);
    const sample = [];
    for (const p of profiles.slice(0, 5)) {
      let acts = [];
      try { acts = await fetchProfileActivities(p.uuid, 5); } catch {}
      sample.push({
        profile: { uuid: p.uuid, name: p.public?.preferredName || p.name, type: p.type },
        activityCount: acts.length,
        firstActivity: acts[0] || null,
      });
      await wait(100);
    }
    res.json({ ok: true, countProfilesChecked: sample.length, sample });
  } catch (e) {
    res.status(500).json({ ok: false, error: "peek-activities failed", detail: e });
  }
});

app.get("/probe", async (req, res) => {
  try {
    const profiles = await fetchProfilesByCampaign(200);
    const sampleProfiles = profiles.slice(0, 8);
    let total = 0;
    const sampleActivities = [];

    for (const p of sampleProfiles) {
      let a = [];
      try { a = await fetchProfileActivities(p.uuid, 20); } catch {}
      total += a.length;
      if (req.query.withActivities && a.length) {
        sampleActivities.push({ profileUuid: p.uuid, first: a[0] });
      }
      await wait(60);
    }

    res.json({
      ok: true,
      path: "profiles",
      usedEndpoint: "profiles?campaign",
      status: 200,
      profilesCount: profiles.length,
      total,
      sample: sampleProfiles.map(p => ({
        uuid: p.uuid,
        path: p.path,
        name: p.public?.preferredName || p.name,
        type: p.type,
        authorisations: p?.authorisations || p?.internal?.authorisations || [],
      })),
      sampleActivities,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "probe failed", detail: e });
  }
});

// ---- COMMUTES (leaderboard-ish shape) --------------------
app.get("/commutes", async (_req, res) => {
  try {
    const profiles = await fetchProfilesByCampaign(500);

    const buckets = {
      individuals: [],
      teams: [],
      organisations: [],
    };

    for (const p of profiles) {
      // Pull a reasonable number to keep within free tier limits
      let acts = [];
      try { acts = await fetchProfileActivities(p.uuid, 50); } catch {}

      // Count only “commute-like” entries
      const commuteActs = acts.filter(looksLikeCommute);

      // Sum distance in km
      const km = commuteActs.reduce((s, a) => s + distanceKm(a), 0);

      // Only include profiles with > 0 commute distance
      if (km <= 0) continue;

      const row = {
        uuid: p.uuid,
        name: p.public?.preferredName || p.name,
        path: p.path,
        km: Math.round(km * 100) / 100,
        count: commuteActs.length,
      };

      if (p.type === "GROUP") {
        buckets.teams.push(row);
      } else if (p.type === "ORGANISATION") {
        buckets.organisations.push(row);
      } else {
        buckets.individuals.push(row);
      }

      // small pause to be polite to the API
      await wait(40);
    }

    // Sort descending by distance
    const cmp = (a, b) => b.km - a.km;
    buckets.individuals.sort(cmp);
    buckets.teams.sort(cmp);
    buckets.organisations.sort(cmp);

    res.json(buckets);
  } catch (e) {
    res.status(500).json({ error: "Raisely API did not return 200", detail: e });
  }
});

// ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("listening on", PORT);
});
