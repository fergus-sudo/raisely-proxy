const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 Render env vars
const RAISELY_API_KEY = process.env.RAISELY_API_KEY;
const CAMPAIGN_UUID   = process.env.CAMPAIGN_UUID; // can be Campaign *or* Campaign Profile UUID

// CORS for Raisely component preview
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// Activity types we’ll treat as commutes
const COMMUTE_ACTIVITY_TYPES = [
  "Run","Walk","Ride","E-Bike Ride","Scooter","Commute","Transit","Bus","Ferry",
];

// Heuristic: is an activity a commute?
function isLikelyCommute(a = {}) {
  const source = (a.source || "").toLowerCase();
  const fromManual = source === "manual";
  const fromStrava = source === "strava";

  const type = (a.type || "").trim();
  const typeIsCommute = COMMUTE_ACTIVITY_TYPES.includes(type);

  const meta = a.meta || a.metadata || {};
  const STRAVA_COMMUTE_FLAG_KEYS = ["commute","is_commute","isCommute"];
  const flagged = STRAVA_COMMUTE_FLAG_KEYS.some(k => {
    const v = meta[k];
    return v === true || v === "true" || v === 1 || v === "1";
  });

  if (fromManual && (!type || typeIsCommute)) return true;
  if (fromStrava && (flagged || typeIsCommute)) return true;

  return false;
}

// ---- Try multiple Raisely endpoints until one returns 200 ----
async function fetchAllActivitiesWithFallback() {
  if (!RAISELY_API_KEY) throw new Error("Missing RAISELY_API_KEY");
  if (!CAMPAIGN_UUID)  throw new Error("Missing CAMPAIGN_UUID");

  const headers = { Authorization: `Bearer ${RAISELY_API_KEY}` };

  // We’ll try all reasonable permutations
  const qs = "order=desc&sort=createdAt&limit=100";

  const candidates = [
    // Campaign UUID path + query param versions
    `https://api.raisely.com/v3/campaigns/${encodeURIComponent(CAMPAIGN_UUID)}/activities?${qs}`,
    `https://api.raisely.com/v3/activities?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&${qs}`,

    // Campaign Profile UUID path + query param versions
    `https://api.raisely.com/v3/campaign-profiles/${encodeURIComponent(CAMPAIGN_UUID)}/activities?${qs}`,
    `https://api.raisely.com/v3/activities?campaignProfile=${encodeURIComponent(CAMPAIGN_UUID)}&${qs}`,
  ];

  const tried = [];
  for (const url of candidates) {
    tried.push(url);
    const res = await fetch(url, { headers });
    let body = null;
    try { body = await res.json(); } catch (_) {}

    if (res.status === 200) {
      return {
        items: body?.data || [],
        used: url,
        status: res.status,
        tried,
      };
    }

    // 401/403/404 etc — move on to next candidate
    // But if it’s a hard auth error, you’ll see it in /probe detail
    if (res.status >= 500) {
      // transient errors: keep trying next, but include in detail
    }
  }

  const err = new Error("Raisely API did not return 200");
  err.detail = { tried, lastStatus: 404, lastBody: null };
  throw err;
}

// Leaderboard endpoint
app.get("/commutes", async (_req, res) => {
  try {
    const { items } = await fetchAllActivitiesWithFallback();

    const individuals = new Map();
    const teams = new Map();
    const orgs = new Map();

    for (const a of items) {
      if (!isLikelyCommute(a)) continue;

      const p = a.profile || {};
      const pid = p.uuid || p.profileUuid;
      if (pid) {
        const cur = individuals.get(pid) || {
          uuid: pid,
          name: p.fullName || p.name || "Anonymous",
          avatar: p.avatar?.thumb || null,
          points: 0,
        };
        cur.points += 1;
        individuals.set(pid, cur);
      }

      const t = a.team || {};
      const tid = t.uuid || t.teamUuid;
      if (tid) {
        const cur = teams.get(tid) || { uuid: tid, name: t.name || "Team", points: 0 };
        cur.points += 1;
        teams.set(tid, cur);
      }

      const o = a.organisation || {};
      const oid = o.uuid || o.organisationUuid;
      if (oid) {
        const cur = orgs.get(oid) || { uuid: oid, name: o.name || "Organisation", points: 0 };
        cur.points += 1;
        orgs.set(oid, cur);
      }
    }

    const sortDesc = (a, b) => b.points - a.points;
    res.json({
      individuals: Array.from(individuals.values()).sort(sortDesc),
      teams: Array.from(teams.values()).sort(sortDesc),
      organisations: Array.from(orgs.values()).sort(sortDesc),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e), detail: e.detail || null });
  }
});

// 🔎 Human-friendly probe
app.get("/probe", async (_req, res) => {
  try {
    const out = await fetchAllActivitiesWithFallback();
    res.json({
      ok: true,
      usedEndpoint: out.used,
      status: out.status,
      count: out.items.length,
      tried: out.tried,
      env: {
        haveKey: !!RAISELY_API_KEY,
        haveCampaign: !!CAMPAIGN_UUID,
      },
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      detail: e.detail || null,
      env: {
        haveKey: !!RAISELY_API_KEY,
        haveCampaign: !!CAMPAIGN_UUID,
      },
    });
  }
});

// Root
app.get("/", (_req, res) => res.send("Raisely commute proxy is running"));

app.listen(PORT, () => console.log(`Proxy running on :${PORT}`));
