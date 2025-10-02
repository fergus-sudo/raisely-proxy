const express = require("express");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

const RAISELY_API_KEY = process.env.RAISELY_API_KEY;
const CAMPAIGN_UUID  = process.env.CAMPAIGN_UUID;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

const COMMUTE_ACTIVITY_TYPES = ["Run","Walk","Ride","E-Bike Ride","Scooter","Commute","Transit","Bus","Ferry"];

function isLikelyCommute(a = {}) {
  const src = (a.source || "").toLowerCase();
  const fromManual = src === "manual";
  const fromStrava = src === "strava";
  const type = (a.type || "").trim();
  const typeIsCommute = COMMUTE_ACTIVITY_TYPES.includes(type);
  const meta = a.meta || a.metadata || {};
  const flagged = ["commute","is_commute","isCommute"].some(k => {
    const v = meta[k]; return v === true || v === "true" || v === 1 || v === "1";
  });
  if (fromManual && (!type || typeIsCommute)) return true;
  if (fromStrava && (flagged || typeIsCommute)) return true;
  return false;
}

function authHeaders() {
  if (!RAISELY_API_KEY) throw new Error("Missing RAISELY_API_KEY");
  if (!CAMPAIGN_UUID)  throw new Error("Missing CAMPAIGN_UUID");
  return { Authorization: `Bearer ${RAISELY_API_KEY}` };
}

async function getJson(url) {
  const res = await fetch(url, { headers: authHeaders() });
  let body = null; try { body = await res.json(); } catch {}
  return { res, body };
}

async function getCampaignMeta() {
  const url = `https://api.raisely.com/v3/campaigns/${encodeURIComponent(CAMPAIGN_UUID)}`;
  const { res, body } = await getJson(url);
  return { status: res.status, data: body?.data || {}, url };
}

// --- Profile discovery (tries 4 selectors, returns first non-empty) ---
async function listProfilesSmart() {
  const tried = [];
  // 1) by campaign
  const u1 = `https://api.raisely.com/v3/profiles?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&limit=200`;
  tried.push(u1);
  let { res, body } = await getJson(u1);
  if (res.status === 200 && Array.isArray(body?.data) && body.data.length > 0)
    return { list: body.data, path: "profiles?campaign", status: 200, tried };

  // 2) by campaignProfile
  const u2 = `https://api.raisely.com/v3/profiles?campaignProfile=${encodeURIComponent(CAMPAIGN_UUID)}&limit=200`;
  tried.push(u2);
  ({ res, body } = await getJson(u2));
  if (res.status === 200 && Array.isArray(body?.data) && body.data.length > 0)
    return { list: body.data, path: "profiles?campaignProfile", status: 200, tried };

  // 3) by site slug (from campaign)
  const meta = await getCampaignMeta();
  const siteSlug = meta.data?.site?.slug;
  if (siteSlug) {
    const u3 = `https://api.raisely.com/v3/profiles?site=${encodeURIComponent(siteSlug)}&limit=200`;
    tried.push(u3);
    ({ res, body } = await getJson(u3));
    if (res.status === 200 && Array.isArray(body?.data) && body.data.length > 0)
      return { list: body.data, path: `profiles?site=${siteSlug}`, status: 200, tried };
  }

  // 4) campaign + active (some setups)
  const u4 = `https://api.raisely.com/v3/profiles?campaign=${encodeURIComponent(CAMPAIGN_UUID)}&status=active&limit=200`;
  tried.push(u4);
  ({ res, body } = await getJson(u4));
  if (res.status === 200 && Array.isArray(body?.data) && body.data.length > 0)
    return { list: body.data, path: "profiles?campaign&status=active", status: 200, tried };

  return {
    list: Array.isArray(body?.data) ? body.data : [],
    path: "profiles (empty)",
    status: res.status,
    tried,
  };
}

async function listActivitiesForProfile(profileUuid) {
  const url = `https://api.raisely.com/v3/profiles/${encodeURIComponent(profileUuid)}/activities?order=desc&sort=createdAt&limit=100`;
  const { res, body } = await getJson(url);
  if (res.status === 200) return body?.data || [];
  return [];
}

// --- Routes ---
app.get("/peek", async (_req, res) => {
  try {
    const c = await getCampaignMeta();
    const cp = await getJson(`https://api.raisely.com/v3/campaign-profiles/${encodeURIComponent(CAMPAIGN_UUID)}`);
    const profiles = await listProfilesSmart();
    res.json({
      env: { haveKey: !!RAISELY_API_KEY, haveCampaign: !!CAMPAIGN_UUID },
      check: {
        "GET /campaigns/{uuid}": c.status,
        "GET /campaign-profiles/{uuid}": cp.res.status,
        [`GET ${profiles.path}`]: profiles.status
      },
      siteSlug: c.data?.site?.slug || null,
      profilesCount: profiles.list.length,
      triedProfilesUrls: profiles.tried
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.get("/probe", async (_req, res) => {
  try {
    const profiles = await listProfilesSmart();

    // Count activities quickly across a few profiles (don’t hammer API)
    let total = 0;
    for (const p of profiles.list.slice(0, 10)) {
      const pid = p.uuid || p.profileUuid;
      if (!pid) continue;
      const acts = await listActivitiesForProfile(pid);
      total += acts.length;
    }

    res.json({
      ok: true,
      path: profiles.path.includes("profiles") ? "profiles" : "unknown",
      usedEndpoint: profiles.path,
      status: profiles.status,
      profilesCount: profiles.list.length,
      total,
      sample: profiles.list.slice(0, 2)
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.get("/commutes", async (_req, res) => {
  try {
    const profiles = await listProfilesSmart();
    const activities = [];
    for (const p of profiles.list) {
      const pid = p.uuid || p.profileUuid;
      if (!pid) continue;
      const acts = await listActivitiesForProfile(pid);
      for (const a of acts) activities.push(a);
    }

    const individuals = new Map(), teams = new Map(), orgs = new Map();
    for (const a of activities) {
      if (!isLikelyCommute(a)) continue;

      const p = a.profile || {};
      const pid = p.uuid || p.profileUuid;
      if (pid) {
        const cur = individuals.get(pid) || {
          uuid: pid, name: p.fullName || p.name || "Anonymous", avatar: p.avatar?.thumb || null, points: 0
        };
        cur.points += 1; individuals.set(pid, cur);
      }
      const t = a.team || {};
      const tid = t.uuid || t.teamUuid;
      if (tid) {
        const cur = teams.get(tid) || { uuid: tid, name: t.name || "Team", points: 0 };
        cur.points += 1; teams.set(tid, cur);
      }
      const o = a.organisation || {};
      const oid = o.uuid || o.organisationUuid;
      if (oid) {
        const cur = orgs.get(oid) || { uuid: oid, name: o.name || "Organisation", points: 0 };
        cur.points += 1; orgs.set(oid, cur);
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

app.get("/", (_req, res) => res.send("Raisely commute proxy is running"));
app.listen(PORT, () => console.log(`Proxy running on :${PORT}`));
