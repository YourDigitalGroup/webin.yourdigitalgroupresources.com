// =========================================================
// config.js — Supabase connection + shared game config
//
// The anon key is safe to expose publicly — that's what it's
// designed for. It's protected by Row Level Security in the DB.
// NEVER put the service_role key in this file.
// =========================================================

const SUPABASE_URL = "https://chockxzervwwtqqcontc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNob2NreHplcnZ3d3RxcWNvbnRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyOTk1OTQsImV4cCI6MjA5OTg3NTU5NH0.dm-LqWPENbkbiPK9HqYppNGrpVHTBGuhwr2rVORamTo";

// Shared game definitions, used by both setup and scoring.
const GAME_CONFIG = {
  "3p9": { label: "3-Man / 9-Point", players: 3, points: 9, table: [5, 3, 1] },
  "4p12": { label: "4-Man / 12-Point", players: 4, points: 12, table: [5, 4, 2, 1] },
  "5p15": { label: "5-Man / 15-Point", players: 5, points: 15, table: [5, 4, 3, 2, 1] },
};

const MATCH_LENGTH_CONFIG = {
  6: { label: "6-Hole Matches", matchCount: 3 },
  9: { label: "9-Hole Matches", matchCount: 2 },
  18: { label: "18-Hole Match", matchCount: 1 },
};

// Given a hole number (1-18) and a match length, which match is it in?
function matchNumberForHole(holeNumber, matchLength) {
  return Math.ceil(holeNumber / matchLength);
}

// List of { matchNumber, startHole, endHole } for a given match length.
function getMatchRanges(matchLength) {
  const { matchCount } = MATCH_LENGTH_CONFIG[matchLength];
  const ranges = [];
  for (let i = 0; i < matchCount; i++) {
    ranges.push({
      matchNumber: i + 1,
      startHole: i * matchLength + 1,
      endHole: (i + 1) * matchLength,
    });
  }
  return ranges;
}


// ---- Seeded courses (par + stroke index per hole, read off real cards) ----
// par[i] and si[i] are for hole i+1. Stroke index (si) drives handicap
// stroke allocation: a player's strokes land on the lowest-si holes first.
const COURSES = {
  minnehaha: {
    name: "Minnehaha Country Club",
    location: "Sioux Falls, SD",
    par: [4, 3, 4, 5, 4, 3, 5, 3, 4, 3, 4, 5, 4, 4, 4, 5, 3, 4],
    si:  [11, 7, 1, 5, 3, 17, 13, 15, 9, 16, 10, 12, 6, 4, 14, 2, 18, 8],
  },
  bighorn_mountains: {
    name: "BIGHORN — Mountains (Gold)",
    location: "Palm Desert, CA",
    par: [5, 4, 5, 3, 4, 4, 4, 3, 4, 4, 3, 5, 4, 4, 5, 4, 3, 4],
    si:  [15, 9, 1, 11, 17, 3, 7, 13, 5, 6, 16, 14, 10, 12, 18, 4, 8, 2],
  },
  bighorn_canyons: {
    name: "BIGHORN — Canyons (Gold)",
    location: "Palm Desert, CA",
    par: [4, 4, 5, 3, 4, 5, 3, 4, 4, 4, 4, 5, 4, 4, 3, 5, 3, 4],
    si:  [13, 1, 15, 5, 11, 9, 7, 3, 17, 6, 2, 14, 10, 16, 18, 12, 8, 4],
  },
  classics: {
    name: "The Classics at Lely Resort",
    location: "Naples, FL",
    par: [4, 4, 5, 3, 4, 3, 5, 4, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4],
    si:  [13, 9, 1, 11, 7, 17, 5, 15, 3, 6, 8, 16, 18, 4, 12, 14, 10, 2],
  },
};

// Default wager suggestions per game type (dollars). Editable at setup.
// 3-man: one tier. 4/5-man: two tiers (tier1 = biggest, top<->bottom).
const WAGER_DEFAULTS = {
  "3p9": { tier1: 20, tier2: 0 },
  "4p12": { tier1: 20, tier2: 10 },
  "5p15": { tier1: 20, tier2: 10 },
};

// Expose to other scripts (they load as plain scripts / modules).
window.APP = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  GAME_CONFIG,
  MATCH_LENGTH_CONFIG,
  COURSES,
  WAGER_DEFAULTS,
  matchNumberForHole,
  getMatchRanges,
};
