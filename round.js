// round.js — live leaderboard + scorekeeper score entry.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  GAME_CONFIG,
  getMatchRanges,
} = window.APP;
const { computeMatchLeaderboard, computeWager } = window.SCORING;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Delete-on-load cleanup: remove any round finalized more than 24h ago.
// Non-fatal if it fails (e.g. offline) — never blocks the page.
async function purgeStaleRounds() {
  const cutoff24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cutoff48 = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  try {
    // Finished rounds: cleared 24h after the final hole.
    await supabase
      .from("rounds")
      .delete()
      .not("finalized_at", "is", null)
      .lt("finalized_at", cutoff24);
    // Abandoned rounds (never finished 18): cleared 48h after creation.
    await supabase
      .from("rounds")
      .delete()
      .is("finalized_at", null)
      .lt("created_at", cutoff48);
  } catch (e) {
    console.warn("purge skipped:", e);
  }
}

// ---- Which round + am I the scorekeeper? ----
const params = new URLSearchParams(window.location.search);
const roomCode = (params.get("code") || "").toUpperCase();
const isScorekeeper = localStorage.getItem(`scorekeeper:${roomCode}`) === "1";

// ---- Elements ----
const codeEl = document.getElementById("round-code");
const metaEl = document.getElementById("round-meta");
const stackEl = document.getElementById("plaque-stack");
const loadingMsg = document.getElementById("loading-msg");
const shareBtn = document.getElementById("share-btn");
const scoreEntryEl = document.getElementById("score-entry");
const holeSection = document.getElementById("hole-section");
const holeSectionTitle = document.getElementById("hole-section-title");
const holeTable = document.getElementById("hole-table");

// ---- In-memory state ----
let round = null;
let config = null;
let players = [];
let holes = [];
let scoresByHole = {}; // { holeId: [{playerId, strokes}] }
let strokesByMatch = {}; // { matchNumber: { playerId: strokeCount } }
let viewHoleNumber = null; // which hole the scorekeeper is currently viewing/editing

// ---- Load everything ----
async function loadRound() {
  const { data: r, error } = await supabase
    .from("rounds")
    .select("*")
    .eq("room_code", roomCode)
    .maybeSingle();

  if (error || !r) {
    loadingMsg.textContent = "Couldn't find that round. Check the code and try again.";
    return false;
  }
  round = r;

  const [{ data: cfg }, { data: pl }, { data: hl }] = await Promise.all([
    supabase.from("round_configs").select("*").eq("round_id", round.id).single(),
    supabase.from("players").select("*").eq("round_id", round.id).order("seat_order"),
    supabase.from("holes").select("*").eq("round_id", round.id).order("hole_number"),
  ]);
  config = cfg;
  players = pl || [];
  holes = hl || [];

  const holeIds = holes.map((h) => h.id);
  const { data: scoreRows } = await supabase
    .from("scores")
    .select("*")
    .in("hole_id", holeIds.length ? holeIds : ["none"]);

  scoresByHole = {};
  for (const s of scoreRows || []) {
    (scoresByHole[s.hole_id] ||= []).push({
      playerId: s.player_id,
      strokes: s.gross_strokes,
    });
  }

  await loadStrokes();
  return true;
}

// Load the scorekeeper-entered handicap strokes, keyed by match then player.
async function loadStrokes() {
  const { data: rows } = await supabase
    .from("match_strokes")
    .select("*")
    .eq("round_id", round.id);
  strokesByMatch = {};
  for (const r of rows || []) {
    (strokesByMatch[r.match_number] ||= {})[r.player_id] = r.strokes;
  }
}

// ---- Render leaderboard: one plaque per match ----
function currentMatchNumber() {
  // The first match that still has an unscored hole is "live".
  const ranges = getMatchRanges(round.match_length);
  for (const m of ranges) {
    const matchHoles = holes.filter(
      (h) => h.hole_number >= m.startHole && h.hole_number <= m.endHole
    );
    const allDone = matchHoles.every((h) => {
      const rows = scoresByHole[h.id] || [];
      return rows.length === players.length;
    });
    if (!allDone) return m.matchNumber;
  }
  return ranges[ranges.length - 1].matchNumber; // all done -> last match
}

function matchStatus(m, liveMatchNo) {
  const matchHoles = holes.filter(
    (h) => h.hole_number >= m.startHole && h.hole_number <= m.endHole
  );
  const anyScored = matchHoles.some((h) => (scoresByHole[h.id] || []).length > 0);
  const allDone =
    matchHoles.length > 0 &&
    matchHoles.every((h) => (scoresByHole[h.id] || []).length === players.length);

  if (allDone) return "final";
  if (m.matchNumber === liveMatchNo && anyScored) return "live";
  if (m.matchNumber === liveMatchNo) return "live";
  if (anyScored) return "live";
  return "upcoming";
}

function renderLeaderboard() {
  const gameLabel = GAME_CONFIG[round.game_type].label;
  const ranges = getMatchRanges(round.match_length);
  codeEl.textContent = round.room_code;
  const coursePart = round.course_name ? `${round.course_name} · ` : "";
  metaEl.textContent =
    ranges.length === 1
      ? `${coursePart}${gameLabel} · 18-hole match`
      : `${coursePart}${gameLabel} · ${ranges.length} matches`;

  const liveMatchNo = currentMatchNumber();
  stackEl.innerHTML = "";

  const wagerOn = Number(round.wager_tier1) > 0 || Number(round.wager_tier2) > 0;
  const runningMoney = {};
  players.forEach((p) => (runningMoney[p.id] = 0));

  for (const m of ranges) {
    const rows = computeMatchLeaderboard(
      players,
      holes,
      scoresByHole,
      config,
      m.startHole,
      m.endHole,
      strokesByMatch[m.matchNumber] || {}
    );
    const status = matchStatus(m, liveMatchNo);

    // Wager settles only once a match is final; accumulate the running line.
    let money = null;
    if (wagerOn && status === "final") {
      money = computeWager(
        rows,
        round.game_type,
        Number(round.wager_tier1),
        Number(round.wager_tier2)
      );
      players.forEach((p) => (runningMoney[p.id] += money[p.id] || 0));
    }

    stackEl.appendChild(renderPlaque(m, rows, status, money));
  }

  renderRunningMoney(wagerOn, runningMoney, liveMatchNo);
  renderStrokesEditor(liveMatchNo);
  renderHoleTable(liveMatchNo);
}

function renderPlaque(match, rows, status, money) {
  const plaque = document.createElement("div");
  plaque.className = "plaque" + (status === "upcoming" ? " is-upcoming" : "");

  let statusHtml = "";
  if (status === "live") {
    statusHtml = `<span class="status status-live"><span class="live-dot"></span>Live</span>`;
  } else if (status === "final") {
    statusHtml = `<span class="status status-final">Final</span>`;
  } else {
    statusHtml = `<span class="status status-upcoming">Upcoming</span>`;
  }

  const head = `
    <div class="plaque-head">
      <div>
        <div class="plaque-title">Match ${match.matchNumber}</div>
        <div class="plaque-sub">Holes ${match.startHole}-${match.endHole}</div>
      </div>
      ${statusHtml}
    </div>
  `;

  const body = rows
    .map((row) => {
      const meta =
        status === "upcoming"
          ? "Not started"
          : `Thru ${row.thru} · +${row.lastHolePoints} last hole`;
      const leader = row.rank === 1 && row.total > 0 ? " is-leader" : "";
      const m = money ? money[row.playerId] || 0 : null;
      const moneyHtml =
        m === null
          ? ""
          : `<div class="plaque-money ${m > 0 ? "money-up" : m < 0 ? "money-down" : "money-even"}">${formatMoney(m)}</div>`;
      return `
        <div class="plaque-row">
          <div class="rank-badge${leader}">${row.rank}</div>
          <div class="plaque-name">
            <div class="plaque-player">${escapeHtml(row.name)}</div>
            <div class="plaque-meta">${meta}</div>
          </div>
          ${moneyHtml}
          <div class="plaque-total tabular">${formatPts(row.total)}</div>
        </div>
      `;
    })
    .join("");

  plaque.innerHTML = head + body;
  return plaque;
}

// Running money summary across all completed matches.
function renderRunningMoney(wagerOn, runningMoney, liveMatchNo) {
  const existing = document.getElementById("money-summary");
  if (existing) existing.remove();
  if (!wagerOn) return;

  const anySettled = Object.values(runningMoney).some((v) => v !== 0);
  if (!anySettled) return;

  const sorted = players
    .map((p) => ({ name: p.name, net: runningMoney[p.id] || 0 }))
    .sort((a, b) => b.net - a.net);

  const el = document.createElement("div");
  el.id = "money-summary";
  el.className = "money-summary";
  el.innerHTML = `
    <div class="money-summary-head">Money — Round to Date</div>
    ${sorted
      .map(
        (r) => `
      <div class="money-line">
        <span class="money-name">${escapeHtml(r.name)}</span>
        <span class="money-amt ${r.net > 0 ? "money-up" : r.net < 0 ? "money-down" : "money-even"}">${formatMoney(r.net)}</span>
      </div>`
      )
      .join("")}
  `;
  stackEl.appendChild(el);
}

// Scorekeeper-only editor for handicap strokes in the current match.
function renderStrokesEditor(liveMatchNo) {
  const existing = document.getElementById("strokes-editor");
  if (existing) existing.remove();
  if (!isScorekeeper) return;

  const current = strokesByMatch[liveMatchNo] || {};
  const el = document.createElement("div");
  el.id = "strokes-editor";
  el.className = "strokes-editor";
  el.innerHTML = `
    <details>
      <summary class="strokes-summary">
        Handicap strokes · Match ${liveMatchNo}
        <span class="strokes-hint">tap to set</span>
      </summary>
      <div class="strokes-body">
        <p class="strokes-note">
          Strokes for this match go on the hardest holes by stroke index.
          Net score is used for points and money.
        </p>
        ${players
          .map(
            (p) => `
          <div class="strokes-row">
            <span class="strokes-name">${escapeHtml(p.name)}</span>
            <div class="stepper stepper-sm">
              <button type="button" class="step-btn step-minus" data-player="${p.id}" aria-label="Fewer">&minus;</button>
              <input type="number" inputmode="numeric" min="0" max="18"
                class="step-value strokes-value" data-player="${p.id}"
                value="${current[p.id] || 0}" />
              <button type="button" class="step-btn step-plus" data-player="${p.id}" aria-label="More">+</button>
            </div>
          </div>`
          )
          .join("")}
        <p class="form-error" id="strokes-error" hidden></p>
        <button type="button" class="btn btn-navy btn-block" id="save-strokes">
          Save Strokes
        </button>
      </div>
    </details>
  `;
  // Insert the editor just above the leaderboard stack.
  stackEl.parentNode.insertBefore(el, stackEl);

  el.querySelectorAll(".step-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.player;
      const input = el.querySelector(`.strokes-value[data-player="${id}"]`);
      let v = parseInt(input.value, 10) || 0;
      v += btn.classList.contains("step-plus") ? 1 : -1;
      if (v < 0) v = 0;
      if (v > 18) v = 18;
      input.value = v;
    });
  });

  el.querySelector("#save-strokes").addEventListener("click", () =>
    saveStrokes(liveMatchNo)
  );
}

async function saveStrokes(matchNumber) {
  const errEl = document.getElementById("strokes-error");
  errEl.hidden = true;
  const rows = [...document.querySelectorAll(".strokes-value")].map((el) => ({
    round_id: round.id,
    player_id: el.dataset.player,
    match_number: matchNumber,
    strokes: parseInt(el.value, 10) || 0,
  }));

  const btn = document.getElementById("save-strokes");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const { error } = await supabase
      .from("match_strokes")
      .upsert(rows, { onConflict: "round_id,player_id,match_number" });
    if (error) throw error;
    await loadStrokes();
    renderLeaderboard();
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message || "Couldn't save strokes.";
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = "Save Strokes";
  }
}

// ---- Hole-by-hole table for the live match ----
function renderHoleTable(liveMatchNo) {
  const ranges = getMatchRanges(round.match_length);
  const m = ranges.find((r) => r.matchNumber === liveMatchNo);
  if (!m) return;

  const matchHoles = holes
    .filter((h) => h.hole_number >= m.startHole && h.hole_number <= m.endHole)
    .sort((a, b) => a.hole_number - b.hole_number);

  const scoredHoles = matchHoles.filter(
    (h) => (scoresByHole[h.id] || []).length === players.length
  );
  if (scoredHoles.length === 0) {
    holeSection.hidden = true;
    return;
  }
  holeSection.hidden = false;
  holeSectionTitle.textContent = `Hole by Hole — Match ${liveMatchNo}`;

  // Apply the same handicap-stroke allocation the leaderboard uses, so the
  // per-hole points match the net totals shown above.
  const matchStrokes = strokesByMatch[liveMatchNo] || {};
  const allocByPlayer = {};
  for (const p of players) {
    allocByPlayer[p.id] = window.SCORING.allocateStrokes(
      matchHoles,
      matchStrokes[p.id] || 0
    );
  }

  const anyStrokes = players.some((p) => (matchStrokes[p.id] || 0) > 0);
  const header =
    `<tr><th>Hole</th><th>Par</th>` +
    players.map((p) => `<th class="num">${escapeHtml(shortName(p.name))}</th>`).join("") +
    `</tr>`;

  const bodyRows = scoredHoles
    .map((h) => {
      const holeScores = players.map((p) => {
        const rows = scoresByHole[h.id] || [];
        const f = rows.find((r) => r.playerId === p.id);
        if (!f || f.strokes == null) return { playerId: p.id, strokes: null };
        const taken = allocByPlayer[p.id][h.id] || 0;
        return { playerId: p.id, strokes: Math.max(1, f.strokes - taken) };
      });
      const pts = window.SCORING.computeHolePoints(holeScores, config, h.par);
      const byId = {};
      pts.forEach((r) => (byId[r.playerId] = r.total));
      // Mark holes where a player received a stroke with a small dot.
      const cells = players
        .map((p) => {
          const got = (allocByPlayer[p.id][h.id] || 0) > 0;
          return `<td class="num">${formatPts(byId[p.id] ?? 0)}${got ? '<span class="stroke-dot" title="handicap stroke">•</span>' : ""}</td>`;
        })
        .join("");
      return `<tr><td>${h.hole_number}</td><td>${h.par}</td>${cells}</tr>`;
    })
    .join("");

  const caption = anyStrokes
    ? `<caption class="hole-caption">Net points shown · <span class="stroke-dot">•</span> = handicap stroke</caption>`
    : "";
  holeTable.innerHTML = `${caption}<thead>${header}</thead><tbody>${bodyRows}</tbody>`;
}

// ---- Scorekeeper entry ----
function renderScoreEntry() {
  if (!isScorekeeper) return;

  const firstUnscored = holes.find(
    (h) => (scoresByHole[h.id] || []).length < players.length
  );

  // Default the viewed hole to the first unscored one; clamp if out of range.
  if (viewHoleNumber == null) {
    viewHoleNumber = firstUnscored ? firstUnscored.hole_number : 18;
  }
  viewHoleNumber = Math.min(18, Math.max(1, viewHoleNumber));

  const hole = holes.find((h) => h.hole_number === viewHoleNumber);
  if (!hole) return;

  const existing = scoresByHole[hole.id] || [];
  const isComplete = existing.length === players.length;
  const scoreFor = (pid) => {
    const f = existing.find((r) => r.playerId === pid);
    return f ? f.strokes : null;
  };

  const statusChip = isComplete
    ? `<span class="entry-status entry-status-done">Saved · tap to edit</span>`
    : `<span class="entry-status entry-status-open">Not yet scored</span>`;

  scoreEntryEl.innerHTML = `
    <div class="entry-card">
      <div class="entry-nav">
        <button type="button" class="entry-arrow" id="hole-prev"
          aria-label="Previous hole" ${viewHoleNumber === 1 ? "disabled" : ""}>&larr;</button>
        <select id="hole-jump" class="hole-jump" aria-label="Jump to hole">
          ${holes
            .map((h) => {
              const done = (scoresByHole[h.id] || []).length === players.length;
              return `<option value="${h.hole_number}" ${
                h.hole_number === viewHoleNumber ? "selected" : ""
              }>Hole ${h.hole_number}${done ? " ✓" : ""}</option>`;
            })
            .join("")}
        </select>
        <button type="button" class="entry-arrow" id="hole-next"
          aria-label="Next hole" ${viewHoleNumber === 18 ? "disabled" : ""}>&rarr;</button>
      </div>

      <div class="entry-head">
        <div class="entry-hole">
          <span class="entry-hole-label">${isComplete ? "Editing" : "Now Scoring"}</span>
          <span class="entry-hole-num">Hole ${hole.hole_number}</span>
          ${statusChip}
        </div>
        <label class="entry-par">
          Par
          <input type="number" id="par-input" class="entry-par-input"
            min="3" max="6" value="${hole.par}" inputmode="numeric" />
        </label>
      </div>

      <div class="entry-players">
        ${players
          .map((p) => {
            const v = scoreFor(p.id);
            return `
          <div class="entry-row">
            <span class="entry-name">${escapeHtml(p.name)}</span>
            <div class="stepper">
              <button type="button" class="step-btn step-minus"
                data-player="${p.id}" aria-label="Fewer strokes">&minus;</button>
              <input type="number" inputmode="numeric" min="1" max="20"
                class="step-value entry-strokes" data-player="${p.id}"
                value="${v == null ? "" : v}" placeholder="—" />
              <button type="button" class="step-btn step-plus"
                data-player="${p.id}" aria-label="More strokes">+</button>
            </div>
          </div>`;
          })
          .join("")}
      </div>

      <p class="form-error" id="entry-error" hidden></p>

      <button type="button" class="btn btn-crimson btn-block btn-lg entry-save"
        id="save-hole">
        ${isComplete ? "Update" : "Save"} Hole ${hole.hole_number}
      </button>
    </div>
  `;

  // Stepper +/- buttons adjust the adjacent value.
  scoreEntryEl.querySelectorAll(".step-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.player;
      const input = scoreEntryEl.querySelector(
        `.entry-strokes[data-player="${id}"]`
      );
      let v = parseInt(input.value, 10);
      if (Number.isNaN(v)) v = hole.par; // first tap seeds from par
      v += btn.classList.contains("step-plus") ? 1 : -1;
      if (v < 1) v = 1;
      if (v > 20) v = 20;
      input.value = v;
    });
  });

  // Hole navigation.
  const prevBtn = document.getElementById("hole-prev");
  const nextBtn = document.getElementById("hole-next");
  if (prevBtn)
    prevBtn.addEventListener("click", () => {
      viewHoleNumber -= 1;
      renderScoreEntry();
    });
  if (nextBtn)
    nextBtn.addEventListener("click", () => {
      viewHoleNumber += 1;
      renderScoreEntry();
    });
  document.getElementById("hole-jump").addEventListener("change", (e) => {
    viewHoleNumber = Number(e.target.value);
    renderScoreEntry();
  });

  document.getElementById("save-hole").addEventListener("click", () =>
    saveHole(hole)
  );
}

async function saveHole(hole) {
  const errEl = document.getElementById("entry-error");
  errEl.hidden = true;

  const inputs = [...document.querySelectorAll(".entry-strokes")];
  const par = Number(document.getElementById("par-input").value) || hole.par;

  const entries = inputs.map((el) => ({
    player_id: el.dataset.player,
    strokes: Number(el.value),
  }));

  if (entries.some((e) => !e.strokes || e.strokes < 1)) {
    errEl.textContent = "Enter strokes for every player before saving.";
    errEl.hidden = false;
    return;
  }

  const btn = document.getElementById("save-hole");
  if (btn.disabled) return; // guard against double-tap
  const wasComplete = (scoresByHole[hole.id] || []).length === players.length;
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    // Update par if the scorekeeper changed it.
    if (par !== hole.par) {
      await supabase.from("holes").update({ par }).eq("id", hole.id);
      hole.par = par;
      const local = holes.find((h) => h.id === hole.id);
      if (local) local.par = par;
    }
    const rows = entries.map((e) => ({
      hole_id: hole.id,
      player_id: e.player_id,
      gross_strokes: e.strokes,
    }));
    // Upsert (not insert) so a double-tap, retry, or edit can't throw a
    // duplicate-key error on the (hole_id, player_id) unique constraint.
    const { error } = await supabase
      .from("scores")
      .upsert(rows, { onConflict: "hole_id,player_id" });
    if (error) throw error;

    // Update local state immediately so our own view is correct without
    // waiting on the Realtime round-trip.
    scoresByHole[hole.id] = entries.map((e) => ({
      playerId: e.player_id,
      strokes: e.strokes,
    }));

    // If every hole now has every player's score, the round is complete —
    // stamp finalized_at to start the 24-hour cleanup clock (once only).
    const allComplete = holes.every(
      (h) => (scoresByHole[h.id] || []).length === players.length
    );
    if (allComplete && !round.finalized_at) {
      const nowIso = new Date().toISOString();
      try {
        await supabase
          .from("rounds")
          .update({ status: "complete", finalized_at: nowIso })
          .eq("id", round.id);
        round.finalized_at = nowIso;
        round.status = "complete";
      } catch (e) {
        console.warn("finalize failed:", e);
      }
    }

    // Scoring a fresh hole advances to the next unscored one; editing an
    // existing hole stays put so the scorekeeper can confirm the change.
    if (!wasComplete) {
      const next = holes.find(
        (h) => (scoresByHole[h.id] || []).length < players.length
      );
      viewHoleNumber = next ? next.hole_number : hole.hole_number;
    }

    renderLeaderboard();
    renderScoreEntry();
  } catch (err) {
    console.error(err);
    errEl.textContent = err.message || "Couldn't save. Try again.";
    errEl.hidden = false;
    btn.disabled = false;
    btn.textContent = `${wasComplete ? "Update" : "Save"} Hole ${hole.hole_number}`;
  }
}

// ---- Realtime: refetch on any change to this round ----
function subscribeRealtime() {
  supabase
    .channel(`round-${round.id}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "scores" },
      async () => {
        await refreshScores();
        renderLeaderboard();
        // Don't clobber the scorekeeper's in-progress typing: only re-render
        // the entry form if they aren't currently focused in a score field.
        if (!isEntryFocused()) renderScoreEntry();
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "match_strokes" },
      async () => {
        await loadStrokes();
        renderLeaderboard();
      }
    )
    .subscribe();
}

// True if the scorekeeper currently has a score/par input focused.
function isEntryFocused() {
  const el = document.activeElement;
  return (
    el &&
    (el.classList.contains("entry-strokes") ||
      el.id === "par-input" ||
      el.classList.contains("strokes-value"))
  );
}

async function refreshScores() {
  const holeIds = holes.map((h) => h.id);
  const { data: scoreRows } = await supabase
    .from("scores")
    .select("*")
    .in("hole_id", holeIds.length ? holeIds : ["none"]);
  scoresByHole = {};
  for (const s of scoreRows || []) {
    (scoresByHole[s.hole_id] ||= []).push({
      playerId: s.player_id,
      strokes: s.gross_strokes,
    });
  }
}

// ---- Share button ----
shareBtn.addEventListener("click", async () => {
  const url = window.location.href;
  const text = `Join my round on 9 Point Game — code ${roomCode}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "9 Point Game", text, url });
    } catch {}
  } else {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    shareBtn.textContent = "Copied";
    setTimeout(() => (shareBtn.textContent = "Share"), 1500);
  }
});

// ---- Small helpers ----
function shortName(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : name;
}
function formatPts(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function formatMoney(n) {
  const rounded = Math.round(n * 100) / 100;
  const abs = Math.abs(rounded);
  const str = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  if (rounded > 0) return `+$${str}`;
  if (rounded < 0) return `−$${str}`;
  return "even";
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---- Boot ----
(async function init() {
  if (!roomCode) {
    loadingMsg.textContent = "No round code in the link.";
    return;
  }
  await purgeStaleRounds(); // clean up rounds finalized 24h+ ago
  const ok = await loadRound();
  if (!ok) return;

  // If this round is itself past its 24-hour window, purge it and stop.
  if (round.finalized_at) {
    const ageMs = Date.now() - new Date(round.finalized_at).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      try {
        await supabase.from("rounds").delete().eq("id", round.id);
      } catch (e) {
        console.warn(e);
      }
      showEnded();
      return;
    }
  }

  renderLeaderboard();
  renderScoreEntry();
  subscribeRealtime();
})();

function showEnded() {
  codeEl.textContent = roomCode;
  metaEl.textContent = "";
  stackEl.innerHTML = `
    <div class="ended-card">
      <h2 class="ended-title">This round has ended</h2>
      <p class="ended-copy">
        Completed rounds are cleared 24 hours after the final hole.
        Start a new round to play again.
      </p>
      <a class="btn btn-crimson btn-lg" href="new.html">Start a Round</a>
    </div>`;
  if (scoreEntryEl) scoreEntryEl.innerHTML = "";
  if (holeSection) holeSection.hidden = true;
}
