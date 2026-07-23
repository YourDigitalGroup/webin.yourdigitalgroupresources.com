const BUILD = "2026-07-23b";
console.log("intake portal build", BUILD);

/* ---------- upload helpers (shared by team form + client page) ----------
   safeStoragePath: storage keys reject some characters (spaces, &, etc.) —
   store under a cleaned key, keep the real filename for display.
   tusErrorText: pull the actual server response out of a TUS failure so the
   page reports WHY instead of a bare "try again".
   plainUpload: non-resumable fallback — when the resumable endpoint fails,
   this often succeeds, and when it doesn't, it returns a readable error.  */
function safeStoragePath(intakeId, category, filename) {
  const clean = String(filename).normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")           // strip accents
    .replace(/[^A-Za-z0-9._-]+/g, "_")          // spaces, &, quotes, etc. → _
    .replace(/_+/g, "_").replace(/^[_\.]+/, "") // tidy
    .slice(-140) || "file";
  return `${intakeId}/${category}/${Date.now()}-${clean}`;
}
function tusErrorText(err) {
  try {
    const res = err?.originalResponse;
    const status = res?.getStatus ? res.getStatus() : "";
    let body = res?.getBody ? String(res.getBody()).slice(0, 300) : "";
    try { const j = JSON.parse(body); body = j.message || j.error || body; } catch (_) {}
    return [status && `HTTP ${status}`, body || (err?.message || String(err)).slice(0, 300)]
      .filter(Boolean).join(" — ");
  } catch (_) { return String(err).slice(0, 300); }
}
async function plainUpload(path, file) {
  const { error } = await db.storage.from(CONFIG.BUCKET)
    .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: true });
  return error ? (error.message || String(error)) : null;
}

/* 44i intake portal — plain JS, no build step.
   Views: #/ (list) · #/intake/{id} (record) · #/intake/{id}/edit (form)
   State lives in JS variables; the DOM is rendered once per view and
   patched in place (never re-rendered per keystroke, so focus is kept). */

const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const app = document.getElementById("app");

let session = null;
let profile = null;

/* ---------- tiny helpers ---------- */
const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmtBytes = (b) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
const pkgLabel = (v) => (PACKAGES.find((p) => p.value === v) || {}).label || "Package TBD";
const initials = (n) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const statusLabel = { draft: "Draft", submitted: "Submitted", designer_ready: "Designer-ready" };
const busy = (b, label) => { b.disabled = true; b.classList.add("working"); b.textContent = label; };
const idle = (b, label) => { b.disabled = false; b.classList.remove("working"); b.textContent = label; };

async function logActivity(intakeId, action) {
  await db.from("intake_activity").insert({ intake_id: intakeId, actor: session?.user?.id, action });
}

/* ---------- boot + router ---------- */
(async function boot() {
  const { data } = await db.auth.getSession();
  session = data.session;
  const isUploadRoute = () => location.hash.includes("/upload/");
  if (!session && (!CONFIG.REQUIRE_LOGIN || isUploadRoute())) {
    // Client upload pages work without login via a scoped anonymous session;
    // database rules confine anonymous users to uploading only.
    const { data: anon } = await db.auth.signInAnonymously();
    session = anon?.session ?? null;
  }
  // A team page opened with a leftover anonymous session still needs the
  // gate — destroy the stored session so nothing can restore it.
  if (CONFIG.REQUIRE_LOGIN && session?.user?.is_anonymous && !isUploadRoute()) {
    await db.auth.signOut();
    session = null;
  }
  if (session) await loadProfile();
  db.auth.onAuthStateChange(async (_e, s) => {
    session = (CONFIG.REQUIRE_LOGIN && s?.user?.is_anonymous && !isUploadRoute()) ? null : s;
    if (session) await loadProfile();
    route();
  });
  window.addEventListener("hashchange", route);
  route();
})();

async function loadProfile() {
  const { data } = await db.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  profile = data;
  if (!profile && !session.user.is_anonymous) {
    const full_name = (session.user.email || "44i Team").split("@")[0];
    const { data: created } = await db.from("profiles")
      .insert({ id: session.user.id, full_name }).select().maybeSingle();
    profile = created ?? { id: session.user.id, full_name };
  }
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const up = parts.indexOf("upload");
  const onUpload = up > -1 && !!parts[up + 1];
  if (onUpload) {
    // Client upload pages NEVER show the team login. No session? Create the
    // invisible anonymous one right here; if that fails, explain WHY.
    let anonErr = null;
    if (!session) {
      const { data: anon, error } = await db.auth.signInAnonymously();
      session = anon?.session ?? null;
      anonErr = error?.message ?? null;
    }
    if (!session) {
      const hint = /disabled|not allowed|not enabled/i.test(anonErr || "")
        ? "Fix: Supabase → Authentication → Sign In / Up → turn ON anonymous sign-ins."
        : /rate|too many/i.test(anonErr || "")
          ? "Anonymous sign-ins are rate-limited per IP (~30/hour) — heavy testing from one network hits this. Clients on their own connections are unaffected; wait an hour or test from another network."
          : "Run the System check from the portal for a full diagnosis.";
      app.innerHTML = `<div class="login-wrap"><div class="card login-card">
        <h1 style="font-size:18px">Uploads are temporarily unavailable</h1>
        <p class="subhead">Please try again in a few minutes, or reply to the person who sent you this link — they can collect your files directly.</p>
        <p class="hint" style="font-size:11.5px;color:var(--danger)">${h(anonErr || "no session")}</p>
        <p class="hint" style="font-size:11.5px;color:var(--ink-soft)">${h(hint)}</p>
        <p class="hint" style="font-size:10.5px;color:var(--ink-faint)">build ${BUILD}</p>
      </div></div>`;
      return;
    }
    return viewClientUpload(parts[up + 1]);
  }
  if (CONFIG.REQUIRE_LOGIN && session?.user?.is_anonymous) return viewLogin();
  if (!session) return viewLogin();
  if (parts[0] === "intake" && parts[1] && parts[2] === "edit") return viewForm(parts[1]);
  if (parts[0] === "intake" && parts[1]) return viewDetail(parts[1]);
  return viewList();
}

function shell(inner) {
  app.innerHTML = `
    <div class="shell">
      <div class="topbar no-print">
        <a href="#/" style="text-decoration:none;color:inherit"><span class="wordmark">44i Digital Web Intake Form</span></a>
        <div style="display:flex;align-items:center;gap:12px">
          ${session.user.is_anonymous
            ? ``
            : `<span class="who">${h(profile?.full_name || session.user.email)}${profile?.role ? " · " + h(profile.role) : ""}</span>
               <button class="btn small" id="signout">Sign out</button>`}
        </div>
      </div>
      <div id="view">${inner}</div>
    </div>`;
  const so = $("#signout");
  if (so) so.onclick = async () => { await db.auth.signOut(); location.hash = "#/"; };
}

/* ================= LOGIN ================= */
function viewLogin() {
  app.innerHTML = `
    <div class="login-wrap"><div class="card login-card">
      <h1 style="font-size:19px;margin-bottom:2px">Website intake portal</h1>
      <p class="subhead">Team access only.</p>
      <p class="hint" style="font-size:10.5px;color:var(--ink-faint)">build ${BUILD}</p>
      <form id="loginform">
        <div class="fld"><label for="email">Email</label>
          <input id="email" type="email" autocomplete="username" required /></div>
        <div class="fld"><label for="password">Password</label>
          <input id="password" type="password" autocomplete="current-password" required /></div>
        <p class="error" id="loginerr" hidden></p>
        <button class="btn primary" style="width:100%">Sign in</button>
      </form>
    </div></div>`;
  $("#loginform").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await db.auth.signInWithPassword({
      email: $("#email").value, password: $("#password").value,
    });
    if (error) {
      const el = $("#loginerr");
      el.hidden = false;
      el.textContent = "That email and password combination didn't work. Check with an admin if you need an invite.";
    }
  };
}

/* ================= LIST ================= */
async function viewList() {
  shell(`
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <input type="text" id="q" placeholder="Search by client name" style="flex:1;min-width:200px" />
      <div class="seg" id="statusseg">
        <button data-s="all" class="on">All</button>
        <button data-s="draft">Drafts</button>
        <button data-s="submitted">Submitted</button>
        <button data-s="designer_ready">Designer-ready</button>
      </div>
      <select id="amfilter" style="width:auto;min-width:150px"><option value="">All AMs</option></select>
      <button class="btn small" id="syscheck" title="Verify Trello, AI, and client-link configuration">System check</button>
      <button class="btn primary" id="newintake">New intake</button>
    </div>
    <div class="rowlist" id="list"><div class="row" style="cursor:default"><span class="meta">Loading…</span></div></div>`);

  let rows = [];
  let status = "all";
  let amSel = "";

  db.from("team_members").select("name").eq("role", "am").eq("active", true).order("name")
    .then(({ data: ams }) => {
      const sel = $("#amfilter");
      if (sel && ams?.length) {
        sel.innerHTML = `<option value="">All AMs</option>` + ams.map((x) => `<option>${h(x.name)}</option>`).join("");
        sel.onchange = () => { amSel = sel.value; render(); };
      }
    });

  async function load() {
    let q = db.from("intakes")
      .select("id, client_name, status, package, req_missing, updated_at, handed_off_at, data, profiles:created_by(full_name), partners:partner_id(name)")
      .order("updated_at", { ascending: false });
    if (status !== "all") q = q.eq("status", status);
    const { data } = await q;
    rows = data || [];
    render();
  }

  function render() {
    const term = ($("#q").value || "").toLowerCase();
    const visible = rows.filter((r) => r.client_name !== "⚙ System Check" &&
      r.client_name.toLowerCase().includes(term) &&
      (!amSel || (r.data?.am_name || "") === amSel));
    $("#list").innerHTML = visible.length ? visible.map((r) => `
      <a class="row" href="#/intake/${r.id}">
        <div class="avatar">${h(initials(r.client_name))}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px">${h(r.client_name)}</div>
          <div class="meta">${h(r.partners?.name || "No partner set")} · ${h(pkgLabel(r.package))} · ${h(r.profiles?.full_name || "—")} ·
            updated ${new Date(r.updated_at).toLocaleDateString()}${
              r.status !== "designer_ready" && r.req_missing > 0 && r.req_missing < 999
                ? ` · ${r.req_missing} REQ missing` : ""}${
              r.handed_off_at && new Date(r.updated_at) > new Date(r.handed_off_at)
                ? " · updated after handoff" : ""}</div>
        </div>
        <span class="pill ${r.status}">${statusLabel[r.status]}</span>
      </a>`).join("")
      : `<div class="row" style="cursor:default"><span class="meta">No intakes match. Start one with "New intake".</span></div>`;
  }

  $("#q").oninput = render;
  $("#statusseg").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("#statusseg button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    status = b.dataset.s;
    load();
  };
  $("#syscheck").onclick = async () => {
    const b = $("#syscheck");
    busy(b, "Checking…");
    const local = [];
    local.push({ name: "App build", ok: true, detail: "running " + BUILD });

    // THE ELLIPSE TEST: a real anonymous sign-in, exactly as a client's
    // browser performs it on an upload link.
    try {
      const probe = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      const { data: an, error } = await probe.auth.signInAnonymously();
      local.push({ name: "Client upload links (anonymous sign-in)", ok: !!an?.session && !error,
        detail: an?.session ? "clients land straight on the upload page — no login prompt"
          : (error?.message || "failed") + " → Authentication › Sign In / Up › turn ON anonymous sign-ins" });
      if (an?.session) await probe.auth.signOut();
    } catch (e) { local.push({ name: "Client upload links (anonymous sign-in)", ok: false, detail: String(e) }); }

    // server-side checks ride the webhook like everything else
    let server = null;
    try {
      let { data: rows } = await db.from("intakes").select("id, data").eq("client_name", "⚙ System Check").limit(1);
      let di = rows?.[0];
      let cErr = null;
      if (!di) {
        const { data: created, error } = await db.from("intakes")
          .insert({ client_name: "⚙ System Check", status: "draft", data: {}, created_by: profile?.id ?? session.user.id }).select().single();
        di = created; cErr = error;
      }
      local.push({ name: "Database write (team permissions)", ok: !!di,
        detail: di ? "ok" : (cErr?.message || "insert failed") + " → if this mentions row-level security, your login isn't on the team allowlist (team_logins table)" });
      if (di) {
        await db.from("intakes").update({ data: { ...(di.data || {}), diag_run: true, diag_results: null } }).eq("id", di.id);
        try { await db.rpc("get_upload_info", { iid: di.id }); local.push({ name: "Upload page lookup (RPC)", ok: true, detail: "ok" }); }
        catch (e) { local.push({ name: "Upload page lookup (RPC)", ok: false, detail: "get_upload_info missing — rerun the gate SQL" }); }
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const { data: row } = await db.from("intakes").select("data").eq("id", di.id).single();
          if (row && row.data.diag_run !== true) { server = row.data.diag_results; break; }
        }
      }
    } catch (e) { local.push({ name: "Database write", ok: false, detail: String(e).slice(0, 140) }); }

    const checks = [...local, ...(server?.checks ??
      [{ name: "Server checks (Trello, AI)", ok: false, detail: "no response — is the latest handoff function deployed, and the handoff_webhook trigger alive?" }])];
    idle(b, "System check");
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = `<div class="modal" style="max-width:560px">
      <h2 style="margin:0 0 10px">System check ${checks.every((c) => c.ok) ? "— all clear ✅" : "— action needed"}</h2>
      ${checks.map((c) => `<p style="font-size:13.5px;margin:0 0 8px">${c.ok ? "✅" : "❌"} <strong>${h(c.name)}</strong><br />
        <span style="color:var(--ink-soft);font-size:12.5px">${h(c.detail)}</span></p>`).join("")}
      <div style="display:flex;justify-content:flex-end"><button class="btn" id="sysclose">Close</button></div></div>`;
    document.body.appendChild(ov);
    ov.querySelector("#sysclose").onclick = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
  };
  $("#newintake").onclick = async () => {
    const { data, error } = await db.from("intakes")
      .insert({ client_name: "New client", created_by: profile.id }).select().single();
    if (!error) location.hash = `#/intake/${data.id}/edit`;
  };

  load();
}

/* ================= FORM ================= */
async function viewForm(id) {
  const [{ data: intake }, { data: partners }, { data: ams }] = await Promise.all([
    db.from("intakes").select("*, partners:partner_id(name)").eq("id", id).single(),
    db.from("partners").select("id, name, slug").eq("active", true).order("name"),
    db.from("team_members").select("name").eq("role", "am").eq("active", true).order("name"),
  ]);
  if (!intake) { location.hash = "#/"; return; }
  let partnerId = intake.partner_id || "";
  let data = intake.data || {};
  let saveTimer = null;
  let changed = new Set();

  const fieldHtml = (f) => {
    const hidden = f.cond && !f.cond(data.package, data);
    const badges = `${f.req ? '<span class="badge req">REQ</span>' : ""}${f.rec ? '<span class="badge rec">REC</span>' : ""}${f.tag ? `<span class="badge cond">${h(f.tag)}</span>` : ""}`;
    const v = data[f.id] ?? "";
    let control;
    if (f.id === "am_name" && (ams || []).length) {
      const names = [...new Set([...ams.map((x) => x.name), ...(v ? [v] : [])])];
      control = `<select data-fid="am_name"><option value="">Choose…</option>${
        names.map((n) => `<option ${v === n ? "selected" : ""}>${h(n)}</option>`).join("")}</select>`;
    } else if (f.type === "hours") {
      const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
      control = days.map((dy) => {
        const k = "hours_" + dy.toLowerCase().slice(0, 3);
        const st = data[k] || "Open";
        return `<div class="dayrow">
          <span>${dy}</span>
          <div class="seg" data-fid="${k}">${["Open", "Closed"].map((o) =>
            `<button type="button" data-val="${o}" class="${st === o ? "on" : ""}">${o}</button>`).join("")}</div>
          <input type="text" data-fid="${k}_time" value="${h(data[k + "_time"] ?? "")}" placeholder="8:00 AM – 5:00 PM" style="flex:1;max-width:220px" />
        </div>`;
      }).join("") + `<div style="margin-top:8px"><label style="font-size:13px;font-weight:600">What do you do for holidays?</label>
        <input type="text" data-fid="hours_holidays" value="${h(data.hours_holidays ?? "")}" placeholder="Closed major holidays; on-call emergency service" /></div>`;
    } else if (f.type === "textarea") control = `<textarea rows="2" data-fid="${f.id}">${h(v)}</textarea>`;
    else if (f.type === "select") control = `<select data-fid="${f.id}"><option value="">Choose…</option>${
      f.options.map((o) => `<option value="${o.value}" ${v === o.value ? "selected" : ""}>${h(o.label)}</option>`).join("")}</select>`;
    else if (f.type === "segmented") control = `<div class="seg" data-fid="${f.id}">${
      f.options.map((o) => `<button type="button" data-val="${h(o)}" class="${v === o ? "on" : ""}">${h(o)}</button>`).join("")}</div>`;
    else control = `<input type="${f.type === "date" ? "date" : f.type === "email" ? "email" : "text"}" data-fid="${f.id}" value="${h(v)}" />`;
    return `<div class="fld" data-wrap="${f.id}" style="${f.half ? "" : "grid-column:1/-1;"}${hidden ? "display:none" : ""}">
      <label>${h(f.label)}${badges}</label>${control}${f.hint ? `<span class="hint">${h(f.hint)}</span>` : ""}</div>`;
  };

  shell(`
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      <div><h1 id="title">${h(data.company?.trim() || intake.client_name)}</h1>
        <p class="subhead" style="margin:0">Filled live during the KOC · <a href="#/intake/${id}">back to record</a></p></div>
      <span class="savestate" id="savestate">All changes saved</span>
    </div>
    <div class="card">
      <p class="secnum">SECTION 00</p><h2>White-label partner</h2>
      <p class="subhead">Brands the client upload page and attributes the build. Required.</p>
      <div class="fld" style="max-width:300px">
        <label>Partner<span class="badge req">REQ</span></label>
        <select id="partnersel">
          <option value="">Choose partner…</option>
          ${(partners || []).map((p) => `<option value="${p.id}" ${p.id === partnerId ? "selected" : ""}>${h(p.name)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="card no-print">
      <p class="secnum">AI COPY ASSISTANT</p>
      <h2>Draft suggested copy</h2>
      <p class="subhead">For brand-new clients: drafts the discovery sections (03–06) from the company name and their current website. Only fills empty fields — nothing you've typed is touched — and tags assumed facts with [confirm on call].</p>
      <button class="btn small" id="copygen" type="button">Draft suggested copy</button>
    </div>
    ${SECTIONS.map((sec) => `
      <div class="card ${sec.sensitive ? "sensitive" : ""}">
        <p class="secnum">SECTION ${sec.num}</p><h2>${h(sec.title)}</h2><p class="subhead">${h(sec.sub)}</p>
        ${sec.uploads ? `<div id="uploader"></div>` : ""}
        ${sec.checklist ? `<div id="contentzone"></div>` : ""}
        ${sec.faqs ? `<div id="faqzone"></div>` : ""}
        ${sec.checklist ? "" : `<div class="grid2">${sec.fields.map(fieldHtml).join("")}</div>`}
      </div>${sec.checklist ? `
      <div class="card" id="chatbotcard" style="display:none">
        <p class="secnum">AI CHATBOT</p>
        <h2>Chatbot conversations</h2>
        <p class="subhead">Built after the site copy so the AI writes with full context. Appears because the chatbot add-on is sold in Section 02.</p>
        <div id="chatbotzone"></div>
      </div>` : ""}`).join("")}
    <div class="footerbar no-print">
      <div class="reqbar-wrap">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
          <strong>Required fields</strong><span id="reqcount"></span></div>
        <div class="reqbar"><div id="reqbar"></div></div>
        <p id="reqmissing" style="font-size:12px;color:var(--ink-faint);margin:5px 0 0"></p>
      </div>
      <span id="handoffzone"></span>
    </div>`);

  /* --- state + save --- */
  function setField(fid, value, label) {
    data[fid] = value;
    changed.add(label || fid);
    if (fid === "company") $("#title").textContent = value.trim() || intake.client_name;
    if (fid === "package") { applyConditions(); renderContent(); }
    if (/^page_\d+_name$/.test(fid) || fid.startsWith("page_owner_") || fid.startsWith("content_owner_")) renderContent();
    if (fid === "photo_source") applyConditions();
    if (fid === "chatbot") renderChatbot();
    if (fid === "address_zip") {
      const el = $(`[data-fid="address_zip"]`);
      if (el) el.classList.toggle("invalid", !!value.trim() && !/^\d{5}(-\d{4})?$/.test(value.trim()));
    }
    updateReqBar();
    markDirty();
  }
  function markDirty() {
    $("#savestate").textContent = "Unsaved changes";
    $("#savestate").classList.add("dirty");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1200);
  }
  async function save() {
    $("#savestate").textContent = "Saving…";
    const missing = missingRequired(data).length;
    await db.from("intakes").update({
      data, req_missing: missing,
      client_name: (data.company || "").trim() || intake.client_name,
      package: data.package || null,
    }).eq("id", id);
    if (intake.status === "designer_ready" && changed.size) {
      // The database webhook sees this save and comments on the Trello card.
      const summary = [...changed].slice(0, 4).join(", ");
      await logActivity(id, `Updated: ${summary}`);
    }
    changed.clear();
    $("#savestate").textContent = "All changes saved";
    $("#savestate").classList.remove("dirty");
  }

  function applyConditions() {
    for (const sec of SECTIONS) for (const f of sec.fields) {
      if (!f.cond) continue;
      const wrap = $(`[data-wrap="${f.id}"]`);
      if (wrap) wrap.style.display = f.cond(data.package, data) ? "" : "none";
    }
    for (const c of CONTENT_ITEMS) {
      if (!c.cond) continue;
      const wrap = $(`[data-checkwrap="${c.label}"]`);
      if (wrap) wrap.style.display = c.cond(data.package, data) ? "" : "none";
    }
  }
  function updateReqBar() {
    const all = allRequiredFields(data);
    const missing = missingRequired(data);
    const done = all.length - missing.length;
    $("#reqcount").textContent = `${done} of ${all.length}`;
    $("#reqbar").style.width = `${Math.round((done / Math.max(all.length, 1)) * 100)}%`;
    const gaps = [...(!partnerId ? ["White-label partner"] : []), ...missing.map((f) => f.label)];
    $("#reqmissing").textContent = gaps.length
      ? `Missing: ${gaps.slice(0, 4).join(", ")}${gaps.length > 4 ? ` +${gaps.length - 4} more` : ""}`
      : "All required fields complete — ready for designer handoff";
    renderHandoff(gaps.length);
  }
  function renderHandoff(missingCount) {
    const zone = $("#handoffzone");
    if (intake.status === "designer_ready") {
      zone.innerHTML = `<span class="pill designer_ready">Designer-ready — edits notify the Trello card</span>`;
      return;
    }
    zone.innerHTML = `<button class="btn primary" id="handoff" ${missingCount ? "disabled" : ""}>Submit for handoff</button>`;
    const b = $("#handoff");
    if (b) b.onclick = async () => {
      b.disabled = true; b.textContent = "Handing off…";
      data.build_checklist = buildChecklist(data);
      changed.add("build checklist");
      clearTimeout(saveTimer); await save();
      await logActivity(id, "Submitted for designer handoff");
      // Flipping the status triggers the database webhook, which creates the
      // Trello card server-side. Poll briefly for the card link to confirm.
      await db.from("intakes").update({ status: "designer_ready" }).eq("id", id);
      let cardUrl = null;
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await db.from("intakes").select("trello_card_url, data").eq("id", id).single();
        if (row?.data?.trello_error) {
          alert("Handoff saved, but the Trello card failed:\n\n" + row.data.trello_error + "\n\nFix the issue, then edit any field on the intake to retry automatically.");
          break;
        }
        if (row?.trello_card_url) { cardUrl = row.trello_card_url; break; }
        b.textContent = "Creating Trello card…";
      }
      if (cardUrl === null && !$(".modal-overlay")) { /* error already alerted or still pending */ }
      location.hash = `#/intake/${id}`;
    };
  }

  $("#partnersel").onchange = async (e) => {
    partnerId = e.target.value;
    await db.from("intakes").update({ partner_id: partnerId || null }).eq("id", id);
    updateReqBar();
    if ($("#uploader")) renderUploader();  // client link carries the partner slug
  };

  $("#copygen").onclick = async () => {
    const b = $("#copygen");
    busy(b, "Drafting copy…");
    data.copy_generate = true;
    changed.add("AI copy draft");
    clearTimeout(saveTimer); await save();
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data: row } = await db.from("intakes").select("data").eq("id", id).single();
      if (row && row.data.copy_generate !== true) {
        if (row.data.ai_error) {
          data.copy_generate = false;
          idle(b, "Draft suggested copy");
          alert("Copy drafting failed:\n\n" + row.data.ai_error);
          return;
        }
        viewForm(id);  // re-render the whole form with the drafted fields
        return;
      }
    }
    data.copy_generate = false;          // unstick so retry works
    clearTimeout(saveTimer); await save();
    idle(b, "Draft suggested copy");
    alert("Copy drafting is taking too long — check that the ANTHROPIC_API_KEY secret is set and the latest function is deployed, then try again.");
  };

  function renderContent() {
    const zone = $("#contentzone"); if (!zone) return;
    // Rows = the named pages from Section 08 + the non-page content items.
    // Target keys: "page:N" and "item:Label" — the same keys the edge
    // function's content generation understands.
    const pages = pageRows(data);
    const rows = [
      ...pages.map((pg) => ({
        key: `page:${pg.n}`, name: pg.name, sub: pg.purpose, tag: "",
        ownerFid: `page_owner_${pg.n}`, statusFid: `page_status_${pg.n}`, draftFid: `page_draft_${pg.n}`,
      })),
      ...CONTENT_ITEMS.filter((c) => !c.cond || c.cond(data.package, data)).map((c) => ({
        key: `item:${c.label}`, name: c.label,
        sub: c.label === "Testimonials" ? "Real quotes only — pulled from their site or requested from customers" : "",
        tag: c.tag || "",
        ownerFid: `content_owner_${c.label}`, statusFid: `content_${c.label}`, draftFid: `draft_${c.label}`,
      })),
    ];
    const owned = rows.filter((r) => ownerIs44i(data[r.ownerFid]));

    const rowHtml = (r) => {
      const owner = data[r.ownerFid] || "";
      const writing = ownerIs44i(owner);
      const opts = writing ? ["To write", "Drafted", "Final"] : ["Received", "Requested"];
      const v = data[r.statusFid];
      return `
        <div class="uprow" data-checkwrap="${h(r.key)}">
          <div style="flex:1;min-width:0">
            <span style="font-size:14px">${h(r.name)}${r.tag ? `<span class="badge cond">${h(r.tag)}</span>` : ""}</span>
            ${r.sub ? `<div class="hint" style="font-size:11.5px;color:var(--ink-faint)">${h(r.sub)}</div>` : ""}
          </div>
          <div class="seg" data-fid="${h(r.ownerFid)}">${OWNER_OPTS.map((o) =>
            `<button type="button" data-val="${h(o)}" class="${owner === o ? "on" : ""}">${h(o)}</button>`).join("")}</div>
          ${owner ? `<div class="seg" data-fid="${h(r.statusFid)}">${opts.map((o) =>
            `<button type="button" data-val="${h(o)}" class="${v === o ? "on" : ""}">${h(o)}</button>`).join("")}</div>` : ""}
          ${writing ? `<button class="btn small" type="button" data-draftitem="${h(r.key)}">Draft</button>` : ""}
        </div>
        ${data[r.draftFid] ? `<div class="fld" style="margin-top:8px"><label style="font-size:12px;color:var(--ink-faint)">Drafted copy — ${h(r.name)} — review before publishing</label><textarea rows="5" data-fid="${h(r.draftFid)}">${h(data[r.draftFid])}</textarea>
          <span style="margin-top:4px"><button class="btn small" type="button" data-approve="${h(r.key)}">${data[r.statusFid] === "Final" ? "✓ Approved" : "Approve"}</button>
          <button class="btn small" type="button" data-crw="${h(r.key)}">Rewrite</button></span>
          <div class="coach" hidden data-ccoach="${h(r.key)}">
            <input type="text" placeholder="Coach the rewrite — tone, angle, must-mention (optional)" style="flex:1" />
            <button class="btn small" type="button" data-cgo="${h(r.key)}">Go</button></div></div>` : ""}`;
    };

    zone.innerHTML = `
      ${!pages.length ? `<p class="hint" style="font-size:13px;color:var(--ink-soft);margin:10px 0">Name the site's pages in Section 08 first — each page gets its own ownership row here.</p>` : ""}
      ${owned.length ? `
      <div style="margin:10px 0 14px">
        <button class="btn primary" id="contentgen" type="button">Generate copy for all 44i-owned pages</button>
        <span class="hint" style="font-size:12px;color:var(--ink-faint);margin-left:10px">Drafts the ${owned.length} row(s) marked "44i writes" or "Needs work" — grounded in their website, or competitor analysis + this form when there isn't one. Testimonials are pulled or requested, never invented.</span>
      </div>` : ""}
      ${rows.map(rowHtml).join("")}`;

    const statusFidFor = (key) => key.startsWith("page:") ? `page_status_${key.slice(5)}` : `content_${key.slice(5)}`;
    const nameFor = (key) => (rows.find((r) => r.key === key) || {}).name || key;
    $$("[data-draftitem]", zone).forEach((b) => b.onclick = () => runContentGen(b, b.dataset.draftitem, "Draft"));
    $$("[data-approve]", zone).forEach((b) => b.onclick = () => {
      setField(statusFidFor(b.dataset.approve), "Final", nameFor(b.dataset.approve) + " approved");
      renderContent();
    });
    $$("[data-crw]", zone).forEach((b) => b.onclick = () => {
      const row = $(`[data-ccoach="${CSS.escape(b.dataset.crw)}"]`);
      if (row) { row.hidden = !row.hidden; if (!row.hidden) row.querySelector("input").focus(); }
    });
    $$("[data-cgo]", zone).forEach((b) => b.onclick = () => {
      const coach = $(`[data-ccoach="${CSS.escape(b.dataset.cgo)}"]`)?.querySelector("input")?.value?.trim() || "";
      data.content_coach = coach || null;
      runContentGen(b, b.dataset.cgo, "Go");
    });
    const cg2 = $("#contentgen");
    if (cg2) cg2.onclick = () => runContentGen(cg2, null, "Generate copy for all 44i-owned pages");
  }
  function renderChatbot() {
    const zone = $("#chatbotzone"); if (!zone) return;
    const card = $("#chatbotcard");
    if (card) card.style.display = data.chatbot === "Yes" ? "" : "none";
    if (data.chatbot !== "Yes") { zone.innerHTML = ""; return; }
    const convos = data.chatbot_convos || [];
    zone.innerHTML = `
      <div class="faqcard" style="background:var(--field-tint);border-color:var(--line);margin-top:10px">
        <label style="font-size:13px;font-weight:600">AI chatbot conversations — GoHighLevel</label>
        <p class="hint" style="font-size:12px;color:var(--ink-soft);margin:2px 0 8px">
          Generates 20 visitor conversations answering from this intake and steering to the site's goal (${h(data.top_action || data.primary_goal || "set the goal in Section 03 first")}). Edit below, then export for GHL.</p>
        <span>
          <button class="btn small" id="chatgen" type="button">${convos.length ? "Regenerate 20 conversations" : "Generate 20 conversations"}</button>
          ${convos.length ? `<button class="btn small" id="chatexport" type="button">Export CSV for GoHighLevel</button>` : ""}
        </span>
      </div>
      ${convos.map((cv, i) => `
        <div class="faqcard" style="padding:10px 12px">
          <span style="font-size:11.5px;font-weight:700;color:var(--ink-faint)">CONVO ${i + 1}</span>
          <div class="fld" style="margin:4px 0 6px"><input type="text" data-cbi="${i}" data-cbk="q" value="${h(cv.q)}" placeholder="Visitor message" /></div>
          <div class="fld" style="margin:0"><textarea rows="2" data-cbi="${i}" data-cbk="a" placeholder="Bot reply">${h(cv.a)}</textarea></div>
        </div>`).join("")}`;
    const g = $("#chatgen");
    if (g) g.onclick = async () => {
      busy(g, "Writing conversations…");
      data.chatbot_generate = true;
      changed.add("chatbot conversations");
      clearTimeout(saveTimer); await save();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await db.from("intakes").select("data").eq("id", id).single();
        if (row && row.data.chatbot_generate !== true) {
          if (row.data.ai_error) { data.chatbot_generate = false; idle(g, "Generate 20 conversations"); alert("Chatbot generation failed:\n\n" + row.data.ai_error); return; }
          data.chatbot_convos = row.data.chatbot_convos || [];
          data.chatbot_generate = false;
          renderChatbot();
          return;
        }
      }
      data.chatbot_generate = false;
      clearTimeout(saveTimer); await save();
      idle(g, "Generate 20 conversations");
      alert("Chatbot generation is taking too long — try again.");
    };
    const ex = $("#chatexport");
    if (ex) ex.onclick = () => {
      const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
      const csv = "question,answer\n" + (data.chatbot_convos || []).map((cv) => `${esc(cv.q)},${esc(cv.a)}`).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const aEl = document.createElement("a");
      aEl.href = URL.createObjectURL(blob);
      aEl.download = `${(data.company || intake.client_name).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-ghl-chatbot.csv`;
      aEl.click();
      URL.revokeObjectURL(aEl.href);
    };
  }

  async function runContentGen(b, target, idleLabel) {
    busy(b, "Writing copy…");
    data.content_target = target || null;
    data.content_generate = true;
    changed.add("AI website copy");
    clearTimeout(saveTimer); await save();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data: row } = await db.from("intakes").select("data").eq("id", id).single();
      if (row && row.data.content_generate !== true) {
        if (row.data.ai_error) { data.content_generate = false; idle(b, idleLabel); alert("Content drafting failed:\n\n" + row.data.ai_error); return; }
        data = row.data;
        renderContent();
        updateReqBar();
        return;
      }
    }
    data.content_generate = false;
    clearTimeout(saveTimer); await save();
    idle(b, idleLabel);
    alert("Content drafting is taking too long — try again.");
  }

  document.addEventListener("input", (e) => {
    const el = e.target.closest("[data-cbi]");
    if (!el || !$("#chatbotzone")?.contains(el)) return;
    const i = +el.dataset.cbi, k = el.dataset.cbk;
    data.chatbot_convos = data.chatbot_convos || [];
    if (data.chatbot_convos[i]) { data.chatbot_convos[i][k] = el.value; changed.add("chatbot conversations"); markDirty(); }
  });

  /* --- input wiring (delegated; DOM never re-rendered on keystroke) --- */
  const view = $("#view");
  view.addEventListener("input", (e) => {
    const fid = e.target.dataset.fid;
    if (fid) setField(fid, e.target.value, labelFor(fid));
  });
  view.addEventListener("click", (e) => {
    const seg = e.target.closest(".seg[data-fid]");
    const btn = e.target.closest("button[data-val]");
    if (seg && btn) {
      $$("button", seg).forEach((x) => x.classList.remove("on"));
      btn.classList.add("on");
      setField(seg.dataset.fid, btn.dataset.val, labelFor(seg.dataset.fid));
    }
  });
  const labelFor = (fid) => {
    for (const s of SECTIONS) for (const f of s.fields) if (f.id === fid) return f.label;
    const pageName = (n) => String(data["page_" + n + "_name"] ?? "").trim() || `Page ${n}`;
    let m;
    if ((m = fid.match(/^page_owner_(\d+)$/))) return pageName(m[1]) + " ownership";
    if ((m = fid.match(/^page_status_(\d+)$/))) return pageName(m[1]) + " status";
    if ((m = fid.match(/^page_draft_(\d+)$/))) return "drafted copy: " + pageName(m[1]);
    if (fid.startsWith("content_owner_")) return fid.slice(14) + " ownership";
    if (fid.startsWith("content_")) return fid.slice(8);
    if (fid.startsWith("source_")) return "copy source: " + fid.slice(7);
    if (fid.startsWith("draft_")) return "drafted copy: " + fid.slice(6);
    return fid;
  };

  /* --- FAQs --- */
  function renderFaqs() {
    const faqs = data.faqs || [];
    $("#faqzone").innerHTML = `
      <div class="faqcard" style="background:var(--field-tint);border-color:var(--line)">
        <label style="font-size:13px;font-weight:600">AI FAQ copywriter</label>
        <p class="hint" style="font-size:12px;color:var(--ink-soft);margin:2px 0 6px">
          List topics or keywords (one per line) — the system writes SEO/AEO-tuned FAQs from them plus this intake's business details. Everything stays editable below.</p>
        <div class="fld"><textarea rows="3" data-fid="faq_topics"
          placeholder="emergency service&#10;financing options&#10;service area / how far do you travel">${h(data.faq_topics ?? "")}</textarea></div>
        <button class="btn small" id="faqgen" type="button">Generate FAQs</button>
      </div>` + faqs.map((f, i) => `
      <div class="faqcard">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:12px;font-weight:700;color:var(--ink-faint)">FAQ ${i + 1}</span>
          <span><button class="btn small" data-faqrw="${i}">Rewrite</button>
          <button class="btn small" data-faqdel="${i}">Remove</button></span></div>
        <div class="coach" hidden data-coachrow="${i}">
          <input type="text" placeholder="Coach the rewrite — tone, angle, must-mention (optional)" style="flex:1" />
          <button class="btn small" data-faqgo="${i}" type="button">Go</button></div>
        <div class="fld"><input type="text" data-faqi="${i}" data-faqk="q"
          placeholder="Do you offer free estimates in Sioux Falls?" value="${h(f.q)}" /></div>
        <div class="fld" style="margin-bottom:0"><textarea rows="2" data-faqi="${i}" data-faqk="a"
          placeholder="Direct, factual one- to two-sentence answer">${h(f.a)}</textarea></div>
      </div>`).join("") + `
      <button class="btn small" id="faqadd" ${faqs.length >= 20 ? "disabled" : ""}>Add question (${faqs.length} of 20)</button>
      ${faqs.length < 10 ? `<span style="font-size:12px;color:var(--ink-faint);margin-left:10px">Aim for at least 10.</span>` : ""}`;
    $("#faqgen").onclick = async () => {
      const b = $("#faqgen");
      busy(b, "Writing FAQs…");
      data.faq_generate = true;
      changed.add("FAQ generation");
      clearTimeout(saveTimer); await save();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await db.from("intakes").select("data").eq("id", id).single();
        if (row && row.data.faq_generate !== true) {
          if (row.data.ai_error) {
            data.faq_generate = false;
            idle(b, "Generate FAQs");
            alert("FAQ generation failed:\n\n" + row.data.ai_error);
            return;
          }
          data.faqs = row.data.faqs || [];
          data.faq_generate = false;
          renderFaqs();
          return;
        }
      }
      data.faq_generate = false;         // unstick so retry works
      clearTimeout(saveTimer); await save();
      idle(b, "Generate FAQs");
      alert("FAQ generation is taking too long — check that the ANTHROPIC_API_KEY secret is set, then try again.");
    };
    $("#faqadd").onclick = () => {
      data.faqs = [...(data.faqs || []), { q: "", a: "" }];
      changed.add("FAQs"); markDirty(); renderFaqs();
    };
    $$("[data-faqrw]").forEach((b) => b.onclick = () => {
      const row = $(`[data-coachrow="${b.dataset.faqrw}"]`);
      if (row) { row.hidden = !row.hidden; if (!row.hidden) row.querySelector("input").focus(); }
    });
    $$("[data-faqgo]").forEach((b) => b.onclick = async () => {
      const i = +b.dataset.faqgo;
      const coach = $(`[data-coachrow="${i}"]`)?.querySelector("input")?.value?.trim() || "";
      busy(b, "Rewriting…");
      data.faq_rewrite_req = { i, at: Date.now(), coach };
      changed.add("FAQ rewrite");
      clearTimeout(saveTimer); await save();
      for (let n = 0; n < 15; n++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await db.from("intakes").select("data").eq("id", id).single();
        if (row && !row.data.faq_rewrite_req) {
          if (row.data.ai_error) { data.faq_rewrite_req = null; idle(b, "Go"); alert("Rewrite failed:\n\n" + row.data.ai_error); return; }
          data.faqs = row.data.faqs || [];
          data.faq_rewrite_req = null;
          renderFaqs();
          return;
        }
      }
      data.faq_rewrite_req = null;
      clearTimeout(saveTimer); await save();
      idle(b, "Go");
      alert("Rewrite is taking too long — try again.");
    });
    $$("[data-faqdel]").forEach((b) => b.onclick = () => {
      data.faqs.splice(+b.dataset.faqdel, 1);
      changed.add("FAQs"); markDirty(); renderFaqs();
    });
  }
  view.addEventListener("input", (e) => {
    if (e.target.dataset.faqi === undefined) return;
    data.faqs[+e.target.dataset.faqi][e.target.dataset.faqk] = e.target.value;
    changed.add("FAQs"); markDirty();
  });

  /* --- uploads --- */
  let files = [];
  async function loadFiles() {
    const { data: rows } = await db.from("intake_files").select("*").eq("intake_id", id).order("created_at");
    files = rows || [];
    renderUploader();
  }
  function renderUploader() {
    const slugP = (partners || []).find((x) => x.id === partnerId);
    const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const cslug = slugify(data.company || intake.client_name);
    const clientLink = location.href.split("#")[0] + "#/" +
      [slugP?.slug ? encodeURIComponent(slugP.slug) : null, cslug || null, "upload", id]
        .filter(Boolean).join("/");
    $("#uploader").innerHTML = `
      <div class="uprow" style="align-items:flex-start">
        <div style="flex:1;min-width:0">
          <span style="font-size:14px;font-weight:600">Client upload link</span>
          <div class="hint" style="font-size:12px;color:var(--ink-faint)">Send this to the client — anything they upload lands in this section automatically (no account needed).</div>
          <input type="text" readonly value="${h(clientLink)}" onclick="this.select()" style="margin-top:6px;font-size:12px" />
        </div>
        <button class="btn small" type="button" id="copylink">Copy link</button>
        <button class="btn small" type="button" id="refreshfiles">Refresh</button>
      </div>
      <div class="uprow">
        <div style="flex:1;min-width:0">
          <span style="font-size:14px;font-weight:600">Optional client PIN</span>
          <div class="hint" style="font-size:12px;color:var(--ink-faint)">Blank = the link alone works. Set a PIN for sensitive clients — tell it to them on the call; the upload page will ask for it.</div>
        </div>
        <input type="text" data-fid="upload_pin" value="${h(data.upload_pin ?? "")}" placeholder="e.g. 4729" style="max-width:120px" />
      </div>` + ASSET_CATEGORIES.map((cat) => {
      const catFiles = files.filter((f) => f.category === cat.id);
      return `<div class="uprow">
        <div style="flex:1;min-width:0">
          <span style="font-size:14px;font-weight:600">${h(cat.label)}${cat.req ? '<span class="badge req">REQ</span>' : ""}</span>
          ${cat.hint ? `<div class="hint" style="font-size:12px;color:var(--ink-faint)">${h(cat.hint)}</div>` : ""}
          ${catFiles.map((f) => `<div style="font-size:12.5px;color:var(--ink-soft);margin-top:3px">${h(f.filename)} · ${fmtBytes(f.size_bytes)}
            <button class="btn small" style="margin-left:8px;font-size:11px;padding:1px 7px" data-filedel="${f.id}" data-filepath="${h(f.storage_path)}">Remove</button></div>`).join("")}
        </div>
        <span class="pill ${catFiles.length ? "designer_ready" : "draft"}">${catFiles.length ? "Received" : "Requested"}</span>
        <button class="btn small" data-upcat="${cat.id}">Upload</button>
      </div>`;
    }).join("") + `
      <div id="progresszone"></div>
      <div class="dropzone" id="dropzone">Drop files here or click to browse · uploads are resumable</div>
      <input type="file" id="fileinput" multiple hidden />`;

    $("#copylink").onclick = async () => {
      try { await navigator.clipboard.writeText(clientLink); $("#copylink").textContent = "Copied!"; }
      catch { $("#copylink").textContent = "Select + copy above"; }
      setTimeout(() => { const b = $("#copylink"); if (b) b.textContent = "Copy link"; }, 2000);
    };
    $("#refreshfiles").onclick = loadFiles;
    $$("[data-upcat]").forEach((b) => b.onclick = () => { pickCat = b.dataset.upcat; $("#fileinput").click(); });
    $$("[data-filedel]").forEach((b) => b.onclick = async () => {
      await db.storage.from(CONFIG.BUCKET).remove([b.dataset.filepath]);
      await db.from("intake_files").delete().eq("id", b.dataset.filedel);
      loadFiles();
    });
    const dz = $("#dropzone");
    dz.onclick = () => { pickCat = "other"; $("#fileinput").click(); };
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("over"); };
    dz.ondragleave = () => dz.classList.remove("over");
    dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove("over"); uploadFiles([...e.dataTransfer.files], "other"); };
    $("#fileinput").onchange = (e) => { uploadFiles([...e.target.files], pickCat); e.target.value = ""; };
  }
  let pickCat = "other";
  async function uploadFiles(list, category) {
    const { data: { session: s } } = await db.auth.getSession();
    for (const file of list) {
      const path = safeStoragePath(id, category, file.name);
      const prog = document.createElement("div");
      prog.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0";
      prog.innerHTML = `<span style="font-size:12.5px;flex:1">${h(file.name)}</span>
        <div class="reqbar" style="width:160px"><div style="width:0%"></div></div>
        <span style="font-size:12px;color:var(--ink-soft);width:36px">0%</span>`;
      $("#progresszone").appendChild(prog);
      const bar = prog.querySelector(".reqbar > div");
      const pct = prog.querySelector("span:last-child");

      const record = async () => {
        const { error } = await db.from("intake_files").insert({
          intake_id: id, category, filename: file.name,
          storage_path: path, size_bytes: file.size, mime: file.type,
          uploaded_by: profile.id,
        });
        if (error) {
          prog.innerHTML += `<span class="error">Stored, but couldn't record it: ${h(error.message || error)}</span>`;
          return false;
        }
        prog.remove(); return true;
      };
      const fail = (why) => {
        pct.textContent = "";
        prog.innerHTML += `<span class="error">Upload failed: ${h(why)}</span>`;
      };

      await new Promise((resolve) => {
        const upload = new tus.Upload(file, {
          endpoint: `${CONFIG.SUPABASE_URL}/storage/v1/upload/resumable`,
          retryDelays: [0, 3000, 5000, 10000],
          headers: { authorization: `Bearer ${s.access_token}`, apikey: CONFIG.SUPABASE_ANON_KEY },
          chunkSize: 6 * 1024 * 1024, // required by Supabase TUS
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          metadata: { bucketName: CONFIG.BUCKET, objectName: path, contentType: file.type || "application/octet-stream" },
          onProgress: (sent, total) => {
            const p = Math.round((sent / total) * 100);
            bar.style.width = p + "%"; pct.textContent = p + "%";
          },
          onError: async (err) => {
            // Resumable path failed — fall back to a plain upload, which
            // succeeds in several cases where resumable doesn't and returns
            // a readable error when it can't.
            const plainErr = await plainUpload(path, file);
            if (!plainErr) { await record(); resolve(); return; }
            fail(`${tusErrorText(err)} (retry without resume: ${plainErr})`);
            resolve();
          },
          onSuccess: async () => { await record(); resolve(); },
        });
        upload.findPreviousUploads().then((prev) => {
          if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
          upload.start();
        });
      });
    }
    await logActivity(id, `Uploaded ${list.length} file(s) to ${category}`);
    loadFiles();
  }

  /* --- go --- */
  if ($("#faqzone")) renderFaqs();
  if ($("#contentzone")) renderContent();
  if ($("#chatbotzone")) renderChatbot();
  if ($("#uploader")) loadFiles();
  applyConditions();
  updateReqBar();
}

/* ================= DETAIL ================= */
async function viewDetail(id) {
  const [{ data: intake }, { data: files }, { data: activity }] = await Promise.all([
    db.from("intakes").select("*, partners:partner_id(name)").eq("id", id).single(),
    db.from("intake_files").select("*").eq("intake_id", id),
    db.from("intake_activity").select("*, profiles:actor(full_name)")
      .eq("intake_id", id).order("created_at", { ascending: false }).limit(12),
  ]);
  if (!intake) { location.hash = "#/"; return; }
  const d = intake.data || {};
  const totalBytes = (files || []).reduce((s, f) => s + (f.size_bytes || 0), 0);

  const sectionHtml = (sec) => {
    const fields = sec.fields.filter((f) => (!f.cond || f.cond(d.package, d)) && String(d[f.id] ?? "").trim());
    const faqs = sec.faqs ? (d.faqs || []).filter((f) => f.q || f.a) : [];
    const rows = sec.checklist ? [
      ...pageRows(d).map((pg) => ({ name: pg.name, owner: d["page_owner_" + pg.n], status: d["page_status_" + pg.n], draft: d["page_draft_" + pg.n] })),
      ...CONTENT_ITEMS.filter((c) => !c.cond || c.cond(d.package, d))
        .map((c) => ({ name: c.label, owner: d["content_owner_" + c.label], status: d["content_" + c.label], draft: d["draft_" + c.label] })),
    ].filter((r) => r.owner || r.status || r.draft) : [];
    const hasFiles = sec.uploads && (files || []).length;
    if (!fields.length && !faqs.length && !rows.length && !hasFiles) return "";
    return `<div class="card"><p class="secnum">SECTION ${sec.num}</p><h2>${h(sec.title)}</h2>
      <div style="margin-top:10px">
      ${hasFiles ? `<p style="font-size:13.5px"><strong>Files on record:</strong> ${
        files.map((f) => `${h(f.filename)} (${h(f.category)})`).join(" · ")}</p>` : ""}
      ${rows.map((r) => `<p style="font-size:13.5px;margin:3px 0">${h(r.name)}: <strong>${h([r.owner, r.status].filter(Boolean).join(" · ") || "—")}</strong></p>`).join("")}
      ${rows.filter((r) => r.draft).map((r) => `<p style="font-size:13.5px;margin:6px 0"><span style="color:var(--ink-faint)">Drafted copy — ${h(r.name)}</span><br /><span style="white-space:pre-wrap">${h(r.draft)}</span></p>`).join("")}
      ${faqs.map((f, i) => `<p style="font-size:13.5px;margin:6px 0"><strong>${i + 1}. ${h(f.q)}</strong><br />${h(f.a)}</p>`).join("")}
      ${fields.map((f) => `<p style="font-size:13.5px;margin:6px 0"><span style="color:var(--ink-faint)">${h(f.label)}</span><br />
        <span style="white-space:pre-wrap">${h(d[f.id])}</span></p>`).join("")}
      </div></div>`;
  };

  shell(`
    <div class="card no-print" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div><h1>${h(intake.client_name)}</h1>
        <p class="subhead" style="margin:2px 0 0">${h(intake.partners?.name || "No partner set")} · ${h(pkgLabel(intake.package))} ·
          <span class="pill ${intake.status}" style="vertical-align:1px">${statusLabel[intake.status]}</span>
          ${intake.trello_card_url ? ` · <a href="${h(intake.trello_card_url)}" target="_blank" rel="noreferrer">Trello card</a>` : ""}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="brief">Download brief (PDF)</button>
        <button class="btn" id="zip" ${files?.length ? "" : "disabled"}>All assets (.zip, ${(totalBytes / 1e6).toFixed(0)} MB)</button>
        <a href="#/intake/${id}/edit"><button class="btn primary">Open intake</button></a>
        <button class="btn danger" id="delintake">Delete</button>
      </div>
    </div>
    ${SECTIONS.map(sectionHtml).join("")}
    <div class="card no-print"><h2 style="margin-bottom:8px">Recent activity</h2>
      ${(activity || []).length ? activity.map((a) =>
        `<p class="activity">${new Date(a.created_at).toLocaleString()} — ${h(a.profiles?.full_name || "Someone")}: ${h(a.action)}</p>`).join("")
        : `<p class="activity">No activity yet.</p>`}
    </div>`);

  // The brief: this page IS the brief — print styles strip the chrome,
  // so this opens the browser's save-as-PDF dialog.
  $("#brief").onclick = () => window.print();
  $("#delintake").onclick = async () => {
    const sure = await new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "modal-overlay";
      ov.innerHTML = `
        <div class="modal">
          <h2 style="margin:0 0 8px">Are you sure?</h2>
          <p style="font-size:14px;margin:0 0 6px">You're about to permanently delete <strong>${h(intake.client_name)}</strong>.</p>
          <p style="font-size:13.5px;color:var(--ink-soft);margin:0 0 6px"><strong>ALL items will be deleted:</strong> the intake form, all drafted copy, FAQs and chatbot conversations, the full activity history, and every uploaded file.</p>
          <p style="font-size:13px;color:var(--danger);margin:0 0 14px">This cannot be undone.${intake.trello_card_url ? " The Trello card is not deleted — archive it in Trello separately." : ""}</p>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn" data-m="cancel">Cancel</button>
            <button class="btn danger" data-m="ok">Yes, delete everything</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      ov.querySelector('[data-m="cancel"]').onclick = () => { ov.remove(); resolve(false); };
      ov.querySelector('[data-m="ok"]').onclick = () => { ov.remove(); resolve(true); };
      ov.onclick = (e) => { if (e.target === ov) { ov.remove(); resolve(false); } };
    });
    if (!sure) return;
    const b = $("#delintake");
    busy(b, "Deleting…");
    try {
      const { data: fl } = await db.from("intake_files").select("storage_path").eq("intake_id", id);
      const paths = (fl || []).map((f) => f.storage_path);
      for (let i = 0; i < paths.length; i += 100) {
        await db.storage.from(CONFIG.BUCKET).remove(paths.slice(i, i + 100));
      }
      await db.from("intake_activity").delete().eq("intake_id", id);
      await db.from("intake_files").delete().eq("intake_id", id);
      const { error } = await db.from("intakes").delete().eq("id", id);
      if (error) throw error;
      location.hash = "#/";
    } catch (e) {
      idle(b, "Delete");
      alert("Delete failed:\n\n" + (e.message || e));
    }
  };

  $("#zip").onclick = async () => {
    const b = $("#zip"); b.disabled = true; b.textContent = "Zipping…";
    const zip = new JSZip();
    for (const f of files) {
      const { data: blob } = await db.storage.from(CONFIG.BUCKET).download(f.storage_path);
      if (blob) zip.folder(f.category).file(f.filename, blob);
    }
    const out = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(out);
    const a = Object.assign(document.createElement("a"), {
      href: url, download: `${intake.client_name.replace(/\s+/g, "-")}-assets.zip`,
    });
    a.click();
    URL.revokeObjectURL(url);
    b.disabled = false; b.textContent = `All assets (.zip, ${(totalBytes / 1e6).toFixed(0)} MB)`;
  };
}


/* ================= CLIENT UPLOAD PAGE ================= */
/* Public page an AM sends to the client. Shows the PARTNER's name (white
   label — never 44i). Files land in the same bucket + intake_files rows the
   form reads, so they appear in Section 07 automatically. */
async function viewClientUpload(id) {
  let pin = null;
  let info = null;
  const fetchInfo = async () => {
    const { data } = await db.rpc("get_upload_info", { iid: id, pin });
    return data?.length ? data[0] : null;
  };
  info = await fetchInfo();
  while (info && info.pin_required && !info.pin_ok) {
    // PIN gate: minimal, client-friendly, partner-branded
    const entered = await new Promise((resolve) => {
      app.innerHTML = `<div class="login-wrap"><div class="card login-card">
        <h1 style="font-size:18px">Enter your upload PIN</h1>
        <p class="subhead">${pin === null ? "Your account manager gave you a short PIN for this upload page." : "That PIN didn't match — try again, or check with your account manager."}</p>
        <div class="fld"><input type="text" id="pinbox" inputmode="numeric" autocomplete="one-time-code" /></div>
        <button class="btn primary" id="pingo" style="width:100%">Continue</button>
      </div></div>`;
      $("#pingo").onclick = () => resolve($("#pinbox").value.trim());
      $("#pinbox").onkeydown = (e) => { if (e.key === "Enter") resolve($("#pinbox").value.trim()); };
      $("#pinbox").focus();
    });
    pin = entered || "";
    info = await fetchInfo();
  }
  const intake = info ? { id, client_name: info.client_name, partners: { name: info.partner_name } } : null;
  if (!intake) {
    app.innerHTML = `<div class="login-wrap"><div class="card login-card"><h1 style="font-size:18px">Link not found</h1><p class="subhead">This upload link isn't valid — please check with your account manager.</p></div></div>`;
    return;
  }
  const agency = intake.partners?.name || "Your agency";

  app.innerHTML = `
    <div class="shell" style="max-width:640px">
      <div style="margin:24px 0 14px">
        <p class="secnum">${h(agency.toUpperCase())}</p>
        <h1>Website assets — ${h(intake.client_name)}</h1>
        <p class="subhead">Upload your logo, photos, and any brand files for your new website. Big files are fine — uploads resume automatically if your connection drops.</p>
      </div>
      <div class="card">
        ${ASSET_CATEGORIES.map((cat) => `
          <div class="uprow">
            <div style="flex:1;min-width:0">
              <span style="font-size:14px;font-weight:600">${h(cat.label)}</span>
              ${cat.hint ? `<div class="hint" style="font-size:12px;color:var(--ink-faint)">${h(cat.hint)}</div>` : ""}
              <div data-catfiles="${cat.id}"></div>
            </div>
            <button class="btn small" type="button" data-upcat="${cat.id}">Upload</button>
          </div>`).join("")}
        <div id="progresszone"></div>
        <div class="dropzone" id="dropzone">Drop files here or click to browse</div>
        <input type="file" id="fileinput" multiple hidden />
        <p class="hint" style="font-size:12px;color:var(--ink-faint);margin:12px 0 0">
          When you're done, just close this page — your team is notified automatically.</p>
      </div>
    </div>`;

  let pickCat = "other";
  async function refresh() {
    const { data: files } = await db.rpc("list_intake_files", { iid: id, pin });
    for (const cat of ASSET_CATEGORIES) {
      const zone = $(`[data-catfiles="${cat.id}"]`);
      if (!zone) continue;
      zone.innerHTML = (files || []).filter((f) => f.category === cat.id)
        .map((f) => `<div style="font-size:12.5px;color:var(--ink-soft);margin-top:3px">${h(f.filename)} <span style="color:var(--ready)">✓</span></div>`).join("");
    }
  }

  async function uploadFiles(list, category) {
    const { data: { session: s } } = await db.auth.getSession();
    for (const file of list) {
      const path = safeStoragePath(id, category, file.name);
      const prog = document.createElement("div");
      prog.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0";
      prog.innerHTML = `<span style="font-size:12.5px;flex:1">${h(file.name)}</span>
        <div class="reqbar" style="width:160px"><div style="width:0%"></div></div>
        <span style="font-size:12px;color:var(--ink-soft);width:36px">0%</span>`;
      $("#progresszone").appendChild(prog);
      const bar = prog.querySelector(".reqbar > div");
      const pct = prog.querySelector("span:last-child");
      const record = async () => {
        const { error } = await db.rpc("record_upload", {
          iid: id, category, filename: file.name,
          storage_path: path, size_bytes: file.size, mime: file.type || "", pin,
        });
        if (error) {
          prog.innerHTML += `<span class="error">Uploaded, but couldn't be recorded: ${h(error.message || error)} — tell your account manager.</span>`;
          return;
        }
        prog.remove();
      };
      const fail = (why) => {
        pct.textContent = "";
        prog.innerHTML += `<span class="error">Upload failed: ${h(why)}</span>`;
      };
      await new Promise((resolve) => {
        const up = new tus.Upload(file, {
          endpoint: `${CONFIG.SUPABASE_URL}/storage/v1/upload/resumable`,
          retryDelays: [0, 3000, 5000, 10000],
          headers: { authorization: `Bearer ${s.access_token}`, apikey: CONFIG.SUPABASE_ANON_KEY },
          chunkSize: 6 * 1024 * 1024,
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          metadata: { bucketName: CONFIG.BUCKET, objectName: path, contentType: file.type || "application/octet-stream" },
          onProgress: (sent, total) => {
            const p = Math.round((sent / total) * 100);
            bar.style.width = p + "%"; pct.textContent = p + "%";
          },
          onError: async (err) => {
            const plainErr = await plainUpload(path, file);
            if (!plainErr) { await record(); resolve(); return; }
            fail(`${tusErrorText(err)} (retry without resume: ${plainErr})`);
            resolve();
          },
          onSuccess: async () => { await record(); resolve(); },
        });
        up.findPreviousUploads().then((prev) => { if (prev.length) up.resumeFromPreviousUpload(prev[0]); up.start(); });
      });
    }
    await db.rpc("log_client_upload", { iid: id, n: list.length, category, pin });
    refresh();
  }

  $$("[data-upcat]").forEach((b) => b.onclick = () => { pickCat = b.dataset.upcat; $("#fileinput").click(); });
  const dz = $("#dropzone");
  dz.onclick = () => { pickCat = "other"; $("#fileinput").click(); };
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("over"); };
  dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove("over"); uploadFiles([...e.dataTransfer.files], "other"); };
  $("#fileinput").onchange = (e) => { uploadFiles([...e.target.files], pickCat); e.target.value = ""; };
  refresh();
}
