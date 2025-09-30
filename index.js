const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 Env vars on Render
const RAISELY_API_KEY = process.env.RAISELY_API_KEY;
const CAMPAIGN_UUID   = process.env.CAMPAIGN_UUID; // campaign OR campaign-profile uuid

// CORS (so you can call from preview sites, etc.)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// Optional commute classifier
const COMMUTE_ACTIVITY_TYPES = [
  "Run","Walk","Ride","E-Bike Ride","Scooter","Commute","Transit","Bus","Ferry",
];
function isLikelyCommute(a = {}) {
  const fromManual = (a.source || "").toLowerCase() === "manual";
  const fromStrava = (a.source || "").toLowerCase() === "strava";
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

// ---- Fetch activities with endpoint fallback (and profile variants) ----
async function fetchAllActivitiesWithFallback() {
  if (!RAISELY_API_KEY) throw new Error("Missing RAISELY_API_KEY");
  if (!CAMPAIGN_UUID)  throw new Error("Missing CAMPAIGN_UUID");

  const headers = { Authorization: `Bearer ${RAISELY_API_KEY}` };
  const tried = [];

  // 1) /campaigns/{uuid}/activities
  const urlA = `https://api.raisely.com/v3/campaigns/${encodeURIComponent(CAMPAIGN_UUID)}/activities?order=desc&sort=createdAt&limit=100`;
  tried.push(urlA);
  let res = await fetch(urlA, { headers });
  if (res.status === 200) {
    const json = await res.json();
    return { items: json?.data || [], used: urlA, status: res.status };
  }

  // 2) /activities?campaign={uuid}
  const urlB = `https://api.raisely.com/v3/activities?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&order=desc&sort=createdAt&limit=100`;
  tried.push(urlB);
  res = await fetch(urlB, { headers });
  if (res.status === 200) {
    const json = await res.json();
    return { items: json?.data || [], used: urlB, status: res.status };
  }

  // 3) /campaign-profiles/{uuid}/activities
  const urlC = `https://api.raisely.com/v3/campaign-profiles/${encodeURIComponent(CAMPAIGN_UUID)}/activities?order=desc&sort=createdAt&limit=100`;
  tried.push(urlC);
  res = await fetch(urlC, { headers });
  if (res.status === 200) {
    const json = await res.json();
    return { items: json?.data || [], used: urlC, status: res.status };
  }

  // 4) /activities?campaignProfile={uuid}
  const urlD = `https://api.raisely.com/v3/activities?campaignProfile=${encodeURIComponent(CAMPAIGN_UUID)}&order=desc&sort=createdAt&limit=100`;
  tried.push(urlD);
  res = await fetch(urlD, { headers });
  const lastJson = await (async () => { try { return await res.json(); } catch { return null; } })();

  if (res.status === 200) {
    return { items: lastJson?.data || [], used: urlD, status: res.status };
  }

  const err = new Error("Raisely API did not return 200");
  err.detail = { tried, lastStatus: res.status, lastBody: lastJson };
  throw err;
}

// ---- Helper to call Raisely with header
async function raisely(path) {
  if (!RAISELY_API_KEY) throw new Error("Missing RAISELY_API_KEY");
  const headers = { Authorization: `Bearer ${RAISELY_API_KEY}` };
  const url = `https://api.raisely.com${path}`;
  const res = await fetch(url, { headers });
  const body = await (async () => { try { return await res.json(); } catch { return null; } })();
  return { status: res.status, body };
}

// Leaderboard
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
    res.status(500).json({ error: String(e
