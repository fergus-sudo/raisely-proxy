// index.js
// Raisely commute proxy — campaign -> profiles -> per-profile activities (fallback-first)

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const RAISELY_API_KEY = process.env.RAISELY_API_KEY;
const CAMPAIGN_UUID  = process.env.CAMPAIGN_UUID;

// ---- CORS (public API for your frontend) -----------------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ---- Helpers ---------------------------------------------------------------
const H = {
  delay: (ms) => new Promise(r => setTimeout(r, ms)),

  authHeaders: () => ({
    "Content-Type": "application/json",
    "Authorization": `Bearer ${RAISELY_API_KEY}`
  }),

  async getJSON(url) {
    const r = await fetch(url, { headers: H.authHeaders() });
    const body = await r.text();
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch (e) {}
    return { ok: r.ok, status: r.status, json };
  },

  // simple commute classifier – broaden as needed
  isLikelyCommute(activity) {
    const src = (activity.source || "").toLowerCase();
    const fromManual = src === "manual";
    const fromStrava = src === "strava";

    const t = ((activity.type || activity.sport || "") + "").toLowerCase();
    const name = (activity.name || "").toLowerCase();
    const tags = (activity.tags || []).map(x => (x || "").toLowerCase());

    const mentionsCommute =
      tags.includes("commute") ||
      name.includes("commute") ||
      activity.isCommute === true ||
      (activity.public && activity.public.isCommute === true);

    const commuteyTypes = [
      "ride", "e-bike ride", "ebike ride", "mountain bike ride", "gravel ride",
      "cycle", "cycling",
      "run", "running", "walk", "walking",
      "scooter", "wheelchairing", "canoe", "kayak", "row", "swim", "other"
    ];

    const typeLooksRight = commuteyTypes.some(k => t.includes(k));
    return (fromManual || fromStrava) && (mentionsCommute || typeLooksRight);
  },

  kmFromActivity(a) {
    // Raisely activities often include distance in meters; support km too.
    const m = a.distance || a.totalDistance || a.public?.distance || 0;
    const kmField = a.distanceKm || a.public?.distanceKm;
    if (typeof kmField === "number") return kmField;
    if (typeof m === "number") {
      // Heuristic: numbers > 100 are probably meters
      if (m > 100) return m / 1000;
      return m; // already km
    }
    return 0;
  }
};

// ---- Raisely fetchers ------------------------------------------------------
async function fetchProfilesForCampaign(limit=200) {
  const url = `https://api.raisely.com/v3/profiles?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&limit=${limit}`;
  const { ok, status, json } = await H.getJSON(url);
  if (!ok || !json) {
    throw new Error(`Profiles fetch failed (${status})`);
  }
  const profiles = Array.isArray(json?.data) ? json.data : [];
  return { url, profiles };
}

async function fetchActivitiesForProfile(profileUuid, limit=200) {
  const url = `https://api.raisely.com/v3/profiles/${encodeURIComponent(profileUuid)}/activities?order=desc&sort=createdAt&limit=${limit}`;
  const { ok, status, json } = await H.getJSON(url);
  if (!ok) {
    if (status === 404) return []; // no activities for this profile
    throw new Error(`Activities fetch failed for ${profileUuid} (${status})`);
  }
  return Array.isArray(json?.data) ? json.data : [];
}

/**
 * Fetch *all* activities we can see by:
 *  1) listing profiles in the campaign
 *  2) fetching activities for each profile
 *  (This is the robust path Raisely supports)
 */
async function fetchAllActivitiesWithFallback() {
  const tried = [];
  const out = {
    path: "profiles",
    usedEndpoint: "profiles?campaign",
    profilesCount: 0,
    total: 0,
    sample: [],
  };

  // 1) profiles for campaign
  const { url: profilesUrl, profiles } = await fetchProfilesForCampaign(200);
  tried.push(profilesUrl);
  out.profilesCount = profiles.length;

  // 2) activities per profile (batch with tiny delay to be kind)
  const all = [];
  for (const p of profiles) {
    const acts = await fetchActivitiesForProfile(p.uuid, 200).catch(() => []);
    // Attach profile shell for later attribution
    for (const a of acts) {
      all.push({ activity: a, profile: { uuid: p.uuid, name: p.name, path: p.path, type: p.type } });
    }
    await H.delay(40);
  }

  out.total = all.length;
  out.sample = all.slice(0, 5); // for /probe debugging
  out.triedProfilesUrls = [profilesUrl];
  return out;
}

// ---- Routes ----------------------------------------------------------------
app.get("/", (_req, res) => {
  res.type("text/plain").send("Raisely commute proxy is running");
});

app.get("/peek", async (_req, res) => {
  try {
    const env = {
      haveKey: !!RAISELY_API_KEY,
      haveCampaign: !!CAMPAIGN_UUID
    };
    const check = {
      "GET /campaigns/{uuid}": 200,            // we don’t call it here; just a hint
      "GET /campaign-profiles/{uuid}": 404,    // not used; gives 404 for you
    };

    const { url, profiles } = await fetchProfilesForCampaign(200);
    res.json({
      env,
      check,
      triedProfilesUrls: [url],
      siteSlug: null,
      profilesCount: profiles.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "peek failed" });
  }
});

app.get("/probe", async (_req, res) => {
  try {
    const r = await fetchAllActivitiesWithFallback();
    res.json({
      ok: true,
      path: r.path,
      usedEndpoint: r.usedEndpoint,
      status: 200,
      profilesCount: r.profilesCount,
      total: r.total,
      sample: r.sample.map(({ activity, profile }) => ({
        profile: { uuid: profile.uuid, name: profile.name, path: profile.path },
        activity: {
          uuid: activity.uuid,
          source: activity.source,
          type: activity.type || activity.sport || null,
          name: activity.name || null,
          distanceKm: H.kmFromActivity(activity)
        }
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "probe failed" });
  }
});

/**
 * /commutes
 * Returns scored commute-like activities grouped for leaderboard input.
 *  - individuals: [{ name, path, distanceKm, activities, points }]
 *  - teams: []      // can be extended
 *  - organisations: []
 */
app.get("/commutes", async (_req, res) => {
  try {
    const r = await fetchAllActivitiesWithFallback();

    // Filter to commute-like & aggregate by profile
    const byProfile = new Map();
    for (const { activity, profile } of r.sample.length || r.total ? r.sample.concat(r.sample.length ? [] : []) : []) {
      // NOTE: r.sample only contains first 5. We actually need *all*:
    }

    // Correct: rebuild from full set instead of r.sample:
    const { url } = await fetchProfilesForCampaign(200); // just to reuse code shape
    // We already have the full set in fetchAllActivitiesWithFallback; get it again here:
    const full = await (async () => {
      const { url: u, profiles } = await fetchProfilesForCampaign(200);
      const all = [];
      for (const p of profiles) {
        const acts = await fetchActivitiesForProfile(p.uuid, 200).catch(() => []);
        for (const a of acts) all.push({ activity: a, profile: p });
        await H.delay(40);
      }
      return all;
    })();

    for (const { activity, profile } of full) {
      if (!H.isLikelyCommute(activity)) continue;
      const km = H.kmFromActivity(activity);
      if (!km || km <= 0) continue;

      const key = profile.uuid;
      if (!byProfile.has(key)) {
        byProfile.set(key, {
          name: profile.name || "Unnamed",
          path: profile.path || null,
          distanceKm: 0,
          activities: 0,
        });
      }
      const agg = byProfile.get(key);
      agg.distanceKm += km;
      agg.activities += 1;
    }

    // Simple points: 1 point per km (customise if you like)
    const individuals = Array.from(byProfile.values())
      .map(p => ({ ...p, points: Math.round(p.distanceKm) }))
      .sort((a, b) => b.points - a.points);

    res.json({
      individuals,
      teams: [],
      organisations: []
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Raisely API did not return 200" });
  }
});

// ---- Start -----------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Raisely proxy listening on ${PORT}`);
});
