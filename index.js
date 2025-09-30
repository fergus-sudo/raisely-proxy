// index.js
const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const RAISELY_API_KEY = process.env.RAISELY_API_KEY;
const CAMPAIGN_UUID  = process.env.CAMPAIGN_UUID;

if (!RAISELY_API_KEY) console.warn("⚠️ Missing RAISELY_API_KEY");
if (!CAMPAIGN_UUID)  console.warn("⚠️ Missing CAMPAIGN_UUID");

const headers = {
  Authorization: `Bearer ${RAISELY_API_KEY}`,
  "Content-Type": "application/json",
};

// allow your preview site
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// ------------ helpers ------------
async function getJson(url) {
  const res = await fetch(url, { headers });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body, url };
}

function isLikelyCommute(a = {}) {
  const type = (a.type || "").trim();
  const source = (a.source || "").toLowerCase();
  const COMMUTE_TYPES = new Set([
    "Run","Walk","Ride","E-Bike Ride","Scooter","Commute","Transit","Bus","Ferry",
  ]);
  const typeIsCommute = COMMUTE_TYPES.has(type);

  const meta = a.meta || a.metadata || {};
  const commuteFlags = ["commute","is_commute","isCommute"];
  const flagged = commuteFlags.some(k => {
    const v = meta[k];
    return v === true || v === "true" || v === 1 || v === "1";
  });

  // Manual entries count if they look like commutes or type missing
  if (source === "manual" && (typeIsCommute || !type)) return true;
  // Strava needs flag or commute-like type
  if (source === "strava" && (flagged || typeIsCommute)) return true;

  return typeIsCommute || flagged;
}

// ---- discover basic wiring & light probe ----
app.get("/peek", async (_req, res) => {
  if (!RAISELY_API_KEY || !CAMPAIGN_UUID) {
    res.status(500).json({ env:{ haveKey:!!RAISELY_API_KEY, haveCampaign:!!CAMPAIGN_UUID }});
    return;
  }

  const checks = {};
  // visible campaign?
  checks['GET /campaigns/{uuid}'] = (await getJson(`https://api.raisely.com/v3/campaigns/${encodeURIComponent(CAMPAIGN_UUID)}`)).status;
  // campaign-profile list?
  checks['GET /campaign-profiles/{uuid}'] = (await getJson(`https://api.raisely.com/v3/campaign-profiles/${encodeURIComponent(CAMPAIGN_UUID)}`)).status;
  // activity shapes
  checks['GET /activities?limit=1']      = (await getJson(`https://api.raisely.com/v3/activities?limit=1`)).status;
  checks['GET /activities?campaign']     = (await getJson(`https://api.raisely.com/v3/activities?campaign=${encodeURIComponent(CAMPAIGN_UUID)}`)).status;
  checks['GET /campaigns/{uuid}/activities'] = (await getJson(`https://api.raisely.com/v3/campaigns/${encodeURIComponent(CAMPAIGN_UUID)}/activities`)).status;
  // profiles in campaign (the one that works for you)
  checks['GET /profiles?campaign'] = (await getJson(`https://api.raisely.com/v3/profiles?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&limit=1`)).status;

  res.json({
    env: { haveKey: !!RAISELY_API_KEY, haveCampaign: !!CAMPAIGN_UUID },
    check: checks,
    notes: "200 means visible; 404 means not wired in this workspace; 401/403 means auth/permission.",
  });
});

// ---- robust activity fetcher with fallbacks ----
async function fetchActivities() {
  // First: try campaign-level (fastest)
  const campaignAttempts = [
    `https://api.raisely.com/v3/campaigns/${encodeURIComponent(CAMPAIGN_UUID)}/activities?order=desc&sort=createdAt&limit=100`,
    `https://api.raisely.com/v3/activities?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&order=desc&sort=createdAt&limit=100`,
  ];

  for (const u of campaignAttempts) {
    const { status, body } = await getJson(u);
    if (status === 200 && body && Array.isArray(body.data)) {
      return { path: "campaign", usedEndpoint: u, items: body.data, status };
    }
  }

  // Fallback: per-profile
  const profList = await getJson(`https://api.raisely.com/v3/profiles?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&limit=200`);
  if (profList.status !== 200 || !profList.body || !Array.isArray(profList.body.data)) {
    return { path: "profiles", usedEndpoint: "list profiles", items: [], status: profList.status };
  }

  const profiles = profList.body.data;
  const all = [];

  // Try every profile with 3 shapes:
  // 1) /profiles/{uuid}/activities
  // 2) /activities?profile={uuid}
  // 3) /activities?campaignProfile={uuid}
  // We stop at the first 200 for each profile.
  for (const p of profiles) {
    const pid = p.uuid || p.profileUuid;
    if (!pid) continue;

    const tries = [
      `https://api.raisely.com/v3/profiles/${encodeURIComponent(pid)}/activities?order=desc&sort=createdAt&limit=100`,
      `https://api.raisely.com/v3/activities?profile=${encodeURIComponent(pid)}&order=desc&sort=createdAt&limit=100`,
      `https://api.raisely.com/v3/activities?campaignProfile=${encodeURIComponent(pid)}&order=desc&sort=createdAt&limit=100`,
    ];

    for (const u of tries) {
      const { status, body } = await getJson(u);
      if (status === 200 && body && Array.isArray(body.data)) {
        all.push(...body.data);
        break; // stop trying shapes for this profile
      }
      if (status === 404) {
        // try next shape
        continue;
      }
      if (status === 401 || status === 403) {
        // permissions — skip this profile
        break;
      }
    }
  }

  return { path: "profiles", usedEndpoint: "per-profile fallback", items: all, status: 200 };
}

// human-readable probe
app.get("/probe", async (_req, res) => {
  try {
    const out = await fetchActivities();
    res.json({
      ok: true,
      path: out.path,
      usedEndpoint: out.usedEndpoint,
      status: out.status,
      total: Array.isArray(out.items) ? out.items.length : 0,
      sample: (out.items || []).slice(0, 2),
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// leaderboard
app.get("/commutes", async (_req, res) => {
  try {
    const out = await fetchActivities();
    const items = out.items || [];

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
    res.status(500).json({ error: String(e.message || e) });
  }
});

// root
app.get("/", (_req, res) => res.send("Raisely commute proxy is running"));

app.listen(PORT, () => console.log(`Proxy running on :${PORT}`));
