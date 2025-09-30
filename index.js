const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const RAISELY_API_KEY = process.env.RAISELY_API_KEY;
const CAMPAIGN_UUID  = process.env.CAMPAIGN_UUID;

if (!RAISELY_API_KEY) console.warn("⚠️ Missing RAISELY_API_KEY");
if (!CAMPAIGN_UUID)  console.warn("⚠️ Missing CAMPAIGN_UUID");

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

const COMMUTE_ACTIVITY_TYPES = [
  "Run","Walk","Ride","E-Bike Ride","Scooter","Commute","Transit","Bus","Ferry",
];

function isLikelyCommute(a = {}) {
  const src = (a.source || "").toLowerCase();
  const fromManual = src === "manual";
  const fromStrava = src === "strava";
  const type = (a.type || "").trim();
  const typeIsCommute = COMMUTE_ACTIVITY_TYPES.includes(type);
  const meta = a.meta || a.metadata || {};
  const flagged = ["commute","is_commute","isCommute"]
    .some(k => meta[k] === true || meta[k] === "true" || meta[k] === 1 || meta[k] === "1");

  if (fromManual && (!type || typeIsCommute)) return true;
  if (fromStrava && (flagged || typeIsCommute)) return true;
  return false;
}

const h = () => ({ Authorization: `Bearer ${RAISELY_API_KEY}` });

async function tryJson(url) {
  const res = await fetch(url, { headers: h() });
  let body = null;
  try { body = await res.json(); } catch {}
  return { ok: res.status === 200, status: res.status, url, body };
}

/**
 * Try many activity endpoints (some workspaces wire them differently).
 * If all fail with 404, fall back to fetching activities profile-by-profile.
 */
async function fetchAllActivitiesRobust() {
  if (!RAISELY_API_KEY) throw new Error("Missing RAISELY_API_KEY");
  if (!CAMPAIGN_UUID)  throw new Error("Missing CAMPAIGN_UUID");

  const attempts = [
    // common campaign-scoped routes
    `https://api.raisely.com/v3/campaigns/${encodeURIComponent(CAMPAIGN_UUID)}/activities?order=desc&sort=createdAt&limit=100`,
    `https://api.raisely.com/v3/activities?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&order=desc&sort=createdAt&limit=100`,
    // alternative param names seen in the wild
    `https://api.raisely.com/v3/activities?campaignUuid=${encodeURIComponent(CAMPAIGN_UUID)}&order=desc&sort=createdAt&limit=100`,
    // sometimes the “campaign profile” filter is used; we’ll try both spellings
    `https://api.raisely.com/v3/activities?campaignProfile=${encodeURIComponent(CAMPAIGN_UUID)}&order=desc&sort=createdAt&limit=100`,
    `https://api.raisely.com/v3/activities?campaignProfileUuid=${encodeURIComponent(CAMPAIGN_UUID)}&order=desc&sort=createdAt&limit=100`,
  ];

  const tried = [];
  for (const url of attempts) {
    const r = await tryJson(url);
    tried.push({ url: r.url, status: r.status });
    if (r.ok) return { items: r.body?.data || [], used: r.url, status: r.status, path: "campaign" };
    // 401/403 = auth; 404 = route not wired that way; keep trying
  }

  // ---- Fall back: pull profiles in the campaign, then merge per-profile activities
  const profilesUrl = `https://api.raisely.com/v3/profiles?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&limit=200&order=desc&sort=createdAt`;
  const pr = await tryJson(profilesUrl);
  tried.push({ url: pr.url, status: pr.status });

  if (!pr.ok) {
    const err = new Error("Raisely API did not return 200");
    err.detail = { tried, lastStatus: pr.status, lastBody: pr.body };
    throw err;
  }

  const profiles = pr.body?.data || [];
  const all = [];
  // fetch activities per-profile (batching sequentially is fine for <=200)
  for (const p of profiles) {
    const pid = p.uuid || p.profileUuid;
    if (!pid) continue;
    const url = `https://api.raisely.com/v3/profiles/${encodeURIComponent(pid)}/activities?order=desc&sort=createdAt&limit=100`;
    const r = await tryJson(url);
    tried.push({ url: r.url, status: r.status });
    if (r.ok && Array.isArray(r.body?.data)) {
      all.push(...r.body.data);
    }
  }

  return { items: all, used: "per-profile fallback", status: 200, tried, path: "profiles" };
}

// ---- API routes ----
app.get("/commutes", async (req, res) => {
  try {
    const { items } = await fetchAllActivitiesRobust();

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
    res.status(500).json({ error: String(e.message || e), detail: e.detail || undefined });
  }
});

// quick status check of which core endpoints are visible
app.get("/peek", async (_req, res) => {
  const checks = {};
  const base = encodeURIComponent(CAMPAIGN_UUID);
  for (const [label, url] of Object.entries({
    "GET /campaigns/{uuid}":                   `https://api.raisely.com/v3/campaigns/${base}`,
    "GET /campaign-profiles/{uuid}":           `https://api.raisely.com/v3/campaign-profiles/${base}`,
    "GET /activities?limit=1":                 `https://api.raisely.com/v3/activities?limit=1`,
    "GET /activities?campaign":                `https://api.raisely.com/v3/activities?campaign=${base}&limit=1`,
    "GET /campaigns/{uuid}/activities":        `https://api.raisely.com/v3/campaigns/${base}/activities?limit=1`,
    "GET /profiles?campaign":                  `https://api.raisely.com/v3/profiles?campaign=${base}&limit=1`,
  })) {
    const r = await tryJson(url);
    checks[label] = r.status;
  }
  res.json({
    env: { haveKey: !!RAISELY_API_KEY, haveCampaign: !!CAMPAIGN_UUID },
    check: checks,
    notes: "200 means visible; 404 means not wired in this workspace; 401/403 means auth/permission.",
  });
});

// human-friendly probe of the robust fetch
app.get("/probe", async (_req, res) => {
  try {
    const out = await fetchAllActivitiesRobust();
    res.json({
      ok: true,
      path: out.path,
      usedEndpoint: out.used,
      status: out.status,
      total: out.items.length,
      sample: out.items.slice(0, 2),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

app.get("/", (_req, res) => res.send("Raisely commute proxy is running"));

app.listen(PORT, () => console.log(`Proxy running on :${PORT}`));
