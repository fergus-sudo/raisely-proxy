const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 Set these on Render as environment variables
const RAISELY_API_KEY = process.env.RAISELY_API_KEY; // e.g. raisely-sk-...
const CAMPAIGN_UUID  = process.env.CAMPAIGN_UUID;    // e.g. 90bda370-...

// Allow calls from your Raisely site
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const COMMUTE_ACTIVITY_TYPES = [
  "Run","Walk","Ride","E-Bike Ride","Scooter","Commute","Transit","Bus","Ferry",
];
const STRAVA_COMMUTE_FLAG_KEYS = ["commute","is_commute","isCommute"];

function isLikelyCommute(activity) {
  const src = (activity.source || "").toLowerCase();
  const fromStrava = src.includes("strava");
  const fromManual = src.includes("manual") || src === "" || src === "web";

  const type = (activity.type || "").trim();
  const typeIsCommute = COMMUTE_ACTIVITY_TYPES.includes(type);

  const meta = activity.meta || activity.metadata || {};
  const flagged = STRAVA_COMMUTE_FLAG_KEYS.some(k => {
    const v = meta[k];
    return v === true || v === "true" || v === 1 || v === "1";
  });

  if (fromManual && (typeIsCommute || !type)) return true;
  if (fromStrava && (flagged || typeIsCommute)) return true;
  return false;
}

async function fetchAllActivities() {
  if (!RAISELY_API_KEY) throw new Error("Missing RAISELY_API_KEY");
  if (!CAMPAIGN_UUID) throw new Error("Missing CAMPAIGN_UUID");
  let page = 1;
  const limit = 100;
  const all = [];

  while (true) {
    const url = `https://api.raisely.com/v3/activities?campaign=${encodeURIComponent(
      CAMPAIGN_UUID
    )}&status=APPROVED&private=0&page=${page}&limit=${limit}&order=desc&sort=createdAt`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${RAISELY_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Raisely API ${res.status}`);
    const json = await res.json();
    const items = json?.data || [];
    all.push(...items);
    if (items.length < limit) break;
    page += 1;
    if (page > 50) break; // safety cap
  }
  return all;
}

// GET /commutes  ->  [{uuid,name,avatar,points}, ...] sorted desc
app.get("/commutes", async (req, res) => {
  try {
    const activities = await fetchAllActivities();

    const individuals = new Map();
    const teams       = new Map();
    const orgs        = new Map();

    for (const a of activities) {
      if (!isLikelyCommute(a)) continue;

      const p = a.profile || {};
      const pid = p.uuid || a.profileUuid;
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
      const tid = t.uuid || a.teamUuid;
      if (tid) {
        const cur = teams.get(tid) || { uuid: tid, name: t.name || "Team", points: 0 };
        cur.points += 1;
        teams.set(tid, cur);
      }

      const o = a.organisation || {};
      const oid = o.uuid || a.organisationUuid;
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
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/", (_req, res) => res.send("Raisely commute proxy is running"));
app.listen(PORT, () => console.log(`Proxy running on :${PORT}`));
