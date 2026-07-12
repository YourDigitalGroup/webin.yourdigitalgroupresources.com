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
  if (!session && !CONFIG.REQUIRE_LOGIN) {
    const { data: anon } = await db.auth.signInAnonymously();
    session = anon?.session ?? null;
    // If this fails, anonymous sign-ins are off in the dashboard —
    // the login screen appears as the fallback.
  }
  if (session) await loadProfile();
  db.auth.onAuthStateChange(async (_e, s) => {
    session = s;
    if (session) await loadProfile();
    route();
  });
  window.addEventListener("hashchange", route);
  route();
})();

async function loadProfile() {
  const { data } = await db.from("profiles").select("*").eq("id", session.user.id).single();
  profile = data;
}

function route() {
  if (!session) return viewLogin();
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "upload" && parts[1]) return viewClientUpload(parts[1]);
  if (parts[1] === "upload" && parts[2]) return viewClientUpload(parts[2]);
  if (parts[0] === "intake" && parts[1] && parts[2] === "edit") return viewForm(parts[1]);
  if (parts[0] === "intake" && parts[1]) return viewDetail(parts[1]);
  return viewList();
}

function shell(inner) {
  app.innerHTML = `
    <div class="shell">
      <div class="topbar no-print">
        <a href="#/" style="text-decoration:none;color:inherit"><span class="wordmark">44<span>i</span> · Website intakes</span></a>
        <div style="display:flex;align-items:center;gap:12px">
          ${session.user.is_anonymous
            ? `<span class="who">44i team</span>`
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
      <p class="wordmark" style="margin:0 0 4px">44<span>i</span></p>
      <h1 style="font-size:19px;margin-bottom:2px">Website intake portal</h1>
      <p class="subhead">Team access only. Sign in with your 44i account.</p>
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
      <button class="btn primary" id="newintake">New intake</button>
    </div>
    <div class="rowlist" id="list"><div class="row" style="cursor:default"><span class="meta">Loading…</span></div></div>`);

  let rows = [];
  let status = "all";

  async function load() {
    let q = db.from("intakes")
      .select("id, client_name, status, package, req_missing, updated_at, handed_off_at, profiles:created_by(full_name), partners:partner_id(name)")
      .order("updated_at", { ascending: false });
    if (status !== "all") q = q.eq("status", status);
    const { data } = await q;
    rows = data || [];
    render();
  }

  function render() {
    const term = ($("#q").value || "").toLowerCase();
    const visible = rows.filter((r) => r.client_name.toLowerCase().includes(term));
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
    const hidden = f.cond && !f.cond(data.package);
    const badges = `${f.req ? '<span class="badge req">REQ</span>' : ""}${f.rec ? '<span class="badge rec">REC</span>' : ""}${f.tag ? `<span class="badge cond">${h(f.tag)}</span>` : ""}`;
    const v = data[f.id] ?? "";
    let control;
    if (f.id === "am_name" && (ams || []).length) {
      const names = [...new Set([...ams.map((x) => x.name), ...(v ? [v] : [])])];
      control = `<select data-fid="am_name"><option value="">Choose…</option>${
        names.map((n) => `<option ${v === n ? "selected" : ""}>${h(n)}</option>`).join("")}</select>`;
    } else if (f.type === "textarea") control = `<textarea data-fid="${f.id}">${h(v)}</textarea>`;
    else if (f.type === "select") control = `<select data-fid="${f.id}"><option value="">Choose…</option>${
      f.options.map((o) => `<option value="${o.value}" ${v === o.value ? "selected" : ""}>${h(o.label)}</option>`).join("")}</select>`;
    else if (f.type === "segmented") control = `<div class="seg" data-fid="${f.id}">${
      f.options.map((o) => `<button type="button" data-val="${h(o)}" class="${v === o ? "on" : ""}">${h(o)}</button>`).join("")}</div>`;
    else control = `<input type="${f.type === "date" ? "date" : f.type === "email" ? "email" : "text"}" data-fid="${f.id}" value="${h(v)}" />`;
    return `<div class="fld" data-wrap="${f.id}" style="${f.half ? "" : "grid-column:1/-1;"}${hidden ? "display:none" : ""}">
      <label>${h(f.label)}${badges}</label>${f.hint ? `<span class="hint">${h(f.hint)}</span>` : ""}${control}</div>`;
  };

  shell(`
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      <div><h1 id="title">${h(data.company?.trim() || intake.client_name)}</h1>
        <p class="subhead" style="margin:0">Filled live during the KOC · <a href="#/intake/${id}">back to record</a></p></div>
      <span class="savestate" id="savestate">All changes saved</span>
    </div>
    <div class="card">
      <p class="secnum">SECTION 00</p><h2>White-label partner</h2>
      <p class="subhead">Routes the handoff to this partner's Trello board. Required.</p>
      <div class="fld" style="max-width:380px">
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
        ${sec.checklist ? `<div class="grid2">${sec.fields.map(fieldHtml).join("")}</div><div id="contentzone"></div>` : ""}
        ${sec.faqs ? `<div id="faqzone"></div>` : ""}
        ${sec.checklist ? "" : `<div class="grid2">${sec.fields.map(fieldHtml).join("")}</div>`}
      </div>`).join("")}
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
    if (fid === "package") applyConditions();
    if (fid === "copy_producer" || fid.startsWith("source_")) renderContent();
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
      if (wrap) wrap.style.display = f.cond(data.package) ? "" : "none";
    }
    for (const c of CONTENT_ITEMS) {
      if (!c.cond) continue;
      const wrap = $(`[data-checkwrap="${c.label}"]`);
      if (wrap) wrap.style.display = c.cond(data.package) ? "" : "none";
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
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await db.from("intakes").select("trello_card_url").eq("id", id).single();
        if (row?.trello_card_url) { cardUrl = row.trello_card_url; break; }
        b.textContent = "Creating Trello card…";
      }
      if (!cardUrl) {
        alert("Handoff saved. The Trello card is still being created — check the record page in a moment; if no card link appears, edit any field to retry.");
      }
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

  const WRITABLE_CONTENT = ["About Us / company story", "Service descriptions (copy)", "Legal/policy pages"];
  function contentSource(label) {
    if (!WRITABLE_CONTENT.includes(label)) return "Client";
    const p = data.copy_producer || "";
    if (p === "44i writes it") return "44i";
    if (p === "Mixed") return data["source_" + label] || "Client";
    return "Client";
  }
  function renderContent() {
    const zone = $("#contentzone"); if (!zone) return;
    const p = data.copy_producer || "";
    const mixed = p === "Mixed";
    zone.innerHTML =
      (p ? "" : `<p class="hint" style="font-size:12.5px;color:var(--req);margin:0 0 8px">Answer "Who's producing the website copy?" above — these rows adapt to it.</p>`) +
      CONTENT_ITEMS.map((c) => {
        const canWrite = WRITABLE_CONTENT.includes(c.label);
        const src = contentSource(c.label);
        const opts = src === "44i" ? ["To write", "Drafted", "Final"] : ["Received", "Requested", "N/A"];
        const v = data["content_" + c.label];
        return `
        <div class="uprow" data-checkwrap="${h(c.label)}" style="${c.cond && !c.cond(data.package) ? "display:none" : ""}">
          <div style="flex:1;min-width:0">
            <span style="font-size:14px">${h(c.label)}${c.tag ? `<span class="badge cond">${h(c.tag)}</span>` : ""}</span>
            ${!canWrite && p && p !== "Client supplies" ? `<div class="hint" style="font-size:11.5px;color:var(--ink-faint)">Always client-supplied — facts we can't write for them</div>` : ""}
          </div>
          ${mixed && canWrite ? `<div class="seg" data-fid="source_${h(c.label)}">${["Client", "44i"].map((o) =>
            `<button type="button" data-val="${o}" class="${(data["source_" + c.label] || "Client") === o ? "on" : ""}">${o}</button>`).join("")}</div>` : ""}
          <div class="seg" data-fid="content_${h(c.label)}">${opts.map((o) =>
            `<button type="button" data-val="${o}" class="${v === o ? "on" : ""}">${o}</button>`).join("")}</div>
          ${src === "44i" ? `<button class="btn small" type="button" data-draftitem="${h(c.label)}">Draft with AI</button>` : ""}
        </div>
        ${data["draft_" + c.label] ? `<div class="fld" style="margin-top:8px"><label style="font-size:12px;color:var(--ink-faint)">Drafted copy — review before publishing</label><textarea rows="5" data-fid="draft_${h(c.label)}">${h(data["draft_" + c.label])}</textarea></div>` : ""}`;
      }).join("") +
      (CONTENT_ITEMS.some((c) => contentSource(c.label) === "44i") ? `
        <div style="margin:12px 0 4px">
          <button class="btn small" id="contentgen" type="button">Draft all 44i-written copy</button>
          <span class="hint" style="font-size:12px;color:var(--ink-faint);margin-left:8px">Never invents testimonials, bios, or prices.</span>
        </div>` : "");
    $$("[data-draftitem]", zone).forEach((b) => b.onclick = () => runContentGen(b, b.dataset.draftitem, "Draft with AI"));
    const cg2 = $("#contentgen");
    if (cg2) cg2.onclick = () => runContentGen(cg2, null, "Draft all 44i-written copy");
  }
  async function runContentGen(b, target, idleLabel) {
    busy(b, "Writing copy…");
    data.content_target = target || null;
    data.content_generate = true;
    changed.add("AI website copy");
    clearTimeout(saveTimer); await save();
    for (let i = 0; i < 25; i++) {
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
    $$("[data-faqrw]").forEach((b) => b.onclick = async () => {
      busy(b, "Rewriting…");
      data.faq_rewrite_req = { i: +b.dataset.faqrw, at: Date.now() };
      changed.add("FAQ rewrite");
      clearTimeout(saveTimer); await save();
      for (let n = 0; n < 15; n++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { data: row } = await db.from("intakes").select("data").eq("id", id).single();
        if (row && !row.data.faq_rewrite_req) {
          if (row.data.ai_error) { data.faq_rewrite_req = null; idle(b, "Rewrite"); alert("Rewrite failed:\n\n" + row.data.ai_error); return; }
          data.faqs = row.data.faqs || [];
          data.faq_rewrite_req = null;
          renderFaqs();
          return;
        }
      }
      data.faq_rewrite_req = null;
      clearTimeout(saveTimer); await save();
      idle(b, "Rewrite");
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
    const clientLink = location.href.split("#")[0] + "#/" +
      (slugP?.slug ? encodeURIComponent(slugP.slug) + "/" : "") + "upload/" + id;
    $("#uploader").innerHTML = `
      <div class="uprow" style="align-items:flex-start">
        <div style="flex:1;min-width:0">
          <span style="font-size:14px;font-weight:600">Client upload link</span>
          <div class="hint" style="font-size:12px;color:var(--ink-faint)">Send this to the client — anything they upload lands in this section automatically (no account needed).</div>
          <input type="text" readonly value="${h(clientLink)}" onclick="this.select()" style="margin-top:6px;font-size:12px" />
        </div>
        <button class="btn small" type="button" id="copylink">Copy link</button>
        <button class="btn small" type="button" id="refreshfiles">Refresh</button>
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
      const path = `${id}/${category}/${Date.now()}-${file.name}`;
      const prog = document.createElement("div");
      prog.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0";
      prog.innerHTML = `<span style="font-size:12.5px;flex:1">${h(file.name)}</span>
        <div class="reqbar" style="width:160px"><div style="width:0%"></div></div>
        <span style="font-size:12px;color:var(--ink-soft);width:36px">0%</span>`;
      $("#progresszone").appendChild(prog);
      const bar = prog.querySelector(".reqbar > div");
      const pct = prog.querySelector("span:last-child");

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
          onError: () => { pct.textContent = ""; prog.innerHTML += `<span class="error">Upload failed — try again</span>`; resolve(); },
          onSuccess: async () => {
            await db.from("intake_files").insert({
              intake_id: id, category, filename: file.name,
              storage_path: path, size_bytes: file.size, mime: file.type,
              uploaded_by: profile.id,
            });
            prog.remove(); resolve();
          },
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
    const fields = sec.fields.filter((f) => (!f.cond || f.cond(d.package)) && String(d[f.id] ?? "").trim());
    const faqs = sec.faqs ? (d.faqs || []).filter((f) => f.q || f.a) : [];
    const checks = sec.checklist
      ? CONTENT_ITEMS.filter((c) => (!c.cond || c.cond(d.package)) && d["content_" + c.label])
      : [];
    const hasFiles = sec.uploads && (files || []).length;
    if (!fields.length && !faqs.length && !checks.length && !hasFiles) return "";
    return `<div class="card"><p class="secnum">SECTION ${sec.num}</p><h2>${h(sec.title)}</h2>
      <div style="margin-top:10px">
      ${hasFiles ? `<p style="font-size:13.5px"><strong>Files on record:</strong> ${
        files.map((f) => `${h(f.filename)} (${h(f.category)})`).join(" · ")}</p>` : ""}
      ${checks.map((c) => `<p style="font-size:13.5px;margin:3px 0">${h(c.label)}: <strong>${h(d["content_" + c.label])}</strong></p>`).join("")}
      ${sec.checklist ? CONTENT_ITEMS.filter((c) => d["draft_" + c.label]).map((c) => `<p style="font-size:13.5px;margin:6px 0"><span style="color:var(--ink-faint)">Drafted copy — ${h(c.label)}</span><br /><span style="white-space:pre-wrap">${h(d["draft_" + c.label])}</span></p>`).join("") : ""}
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
  const { data: intake } = await db.from("intakes")
    .select("id, client_name, partners:partner_id(name)").eq("id", id).single();
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
    const { data: files } = await db.from("intake_files").select("*").eq("intake_id", id).order("created_at");
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
      const path = `${id}/${category}/${Date.now()}-${file.name}`;
      const prog = document.createElement("div");
      prog.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 0";
      prog.innerHTML = `<span style="font-size:12.5px;flex:1">${h(file.name)}</span>
        <div class="reqbar" style="width:160px"><div style="width:0%"></div></div>
        <span style="font-size:12px;color:var(--ink-soft);width:36px">0%</span>`;
      $("#progresszone").appendChild(prog);
      const bar = prog.querySelector(".reqbar > div");
      const pct = prog.querySelector("span:last-child");
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
          onError: () => { pct.textContent = ""; prog.innerHTML += `<span class="error">Upload failed — try again</span>`; resolve(); },
          onSuccess: async () => {
            await db.from("intake_files").insert({
              intake_id: id, category, filename: file.name,
              storage_path: path, size_bytes: file.size, mime: file.type,
              uploaded_by: profile?.id ?? null,
            });
            prog.remove(); resolve();
          },
        });
        up.findPreviousUploads().then((prev) => { if (prev.length) up.resumeFromPreviousUpload(prev[0]); up.start(); });
      });
    }
    await logActivity(id, `Client uploaded ${list.length} file(s) to ${category}`);
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
