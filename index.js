// index.js
// Minimal proxy for Raisely activities (campaign UUID only)

const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 Render environment variables
const RAISELY_API_KEY = process.env.RAISELY_API_KEY; // e.g. raisely-sk-...
const CAMPAIGN_UUID  = process.env.CAMPAIGN_UUID;    // e.g. 57b63970-...

// --- Basic CORS so your site can call this proxy ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Commute heuristics (tweak if you like) ---
const COMMUTE_ACTIVITY_TYPES = [
  "Run","Walk","Ride","E-Bike Ride","Scooter","Commute","Transit","Bus","Ferry",
];
const STRAVA_COMMUTE_FLAG_KEYS = ["commute","is_commute","isCommute"];

function isLikelyCommute(a = {}) {
  const source = (a.source || "").toLowerCase();  // "manual" | "strava" | etc
  const type = (a.type || "").trim();
  const meta = a.meta || a.metadata || {};

  const typeIsCommute = COMMUTE_ACTIVITY_TYPES.includes(type);
  const flagged = STRAVA_COMMUTE_FLAG_KEYS.some(k => {
    const v = meta[k];
    return v === true || v === "true" || v === 1 || v === "1";
  });

  // Manual entries: accept if no type OR a commute-y type
  if (source === "manual" && (!type || typeIsCommute)) return true;
  // Strava: require flag OR commute-y type
  if (source === "strava" && (flagged || typeIsCommute)) return true;

  return false;
}

// --- Fetch all activities for a campaign (pagination aware) ---
async function fetchAllActivities() {
  if (!RAISELY_API_KEY) throw new Error("Missing RAISELY_API_KEY");
  if (!CAMPAIGN_UUID)  throw new Error("Missing CAMPAIGN_UUID");

  const headers = { Authorization: `Bearer ${RAISELY_API_KEY}` };
  let page = 1;
  const limit = 100;
  const all = [];

  // Uses ONLY the campaign form (works whether draft or live if your key can see it)
  while (true) {
    const url =
      `https://api.raisely.com/v3/campaigns/${encodeURIComponent(CAMPAIGN_UUID)}` +
      `/activities?order=desc&sort=createdAt&page=${page}&limit=${limit}`;

    const res = await fetch(url, { headers });
    // If you see 404 here, the activities collection is not visible in this workspace
    if (!res.ok) throw new Error(`Raisely API ${res.status}`);
    const json = await res.json();
    const items = json?.data || [];
    all.push(...items);

    if (items.length < limit) break;   // last page
    page += 1;
    if (page > 50) break;              // safety cap
  }
  return all;
}

// --- Leaderboard endpoint ---
app.get("/commutes", async (_req, res) => {
  try {
    const activities = await fetchAllActivities();

    const individuals = new Map();
    const teams = new Map();
    const orgs = new Map();

    for (const a of activities) {
      if (!isLikelyCommute(a)) continue;

      const p = a.profile || {};
      const
