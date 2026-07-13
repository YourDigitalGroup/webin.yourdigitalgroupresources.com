// Every section and field of the KOC Website Intake, as data.
// The form renders from this config, so adding a field = adding a line here.
// types: text | textarea | email | select | segmented | date

const PACKAGES = [
  { value: "onetime-1", label: "One-time · 1-page" },
  { value: "onetime-5", label: "One-time · 5-page" },
  { value: "onetime-10", label: "One-time · 10-page" },
  { value: "monthly-1", label: "Monthly · 1-page" },
  { value: "monthly-5", label: "Monthly · 5-page" },
  { value: "monthly-10", label: "Monthly · 10-page" },
];

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];

const is5or10 = (pkg) => /-(5|10)$/.test(pkg || "");
const is10 = (pkg) => /-10$/.test(pkg || "");
const isMonthly = (pkg) => /^monthly-/.test(pkg || "");

// From the package grid in the KOC intake doc — drives the Section 08
// checklist AND the Trello build checklist created on handoff.
const PACKAGE_FEATURES = {
  base: ["Google Analytics", "Best practices SEO", "CMS access & training", "Custom forms"],
  pages: { "1": "One page (anchor)", "5": "Up to 5 pages", "10": "Up to 10 pages" },
  fiveTen: ["Newsletter form", "3 URL email addresses", "Photo/video module", "Testimonial module"],
  ten: ["News/blog module", "Subpages"],
  monthly: ["SSL secure hosting", "Content support 1 hr/mo", "ADA web accessibility"],
};

function buildChecklist(data) {
  const pkg = data.package || "";
  const size = (pkg.match(/-(\d+)$/) || [])[1];
  const items = [];
  if (size) items.push(PACKAGE_FEATURES.pages[size]);
  items.push(...PACKAGE_FEATURES.base);
  if (is5or10(pkg)) items.push(...PACKAGE_FEATURES.fiveTen);
  if (is10(pkg)) items.push(...PACKAGE_FEATURES.ten);
  if (isMonthly(pkg)) items.push(...PACKAGE_FEATURES.monthly);
  if (data.chatbot === "Yes") items.push("AI ChatBot");
  // outstanding content = collection tasks for the build
  for (const c of CONTENT_ITEMS) {
    if (c.cond && !c.cond(pkg)) continue;
    if (data["content_" + c.label] === "Requested") items.push(`Collect: ${c.label}`);
  }
  return items.filter(Boolean);
}

const SECTIONS = [
  {
    num: "01", title: "Project and contact basics",
    sub: "Capture the actual approver with final design sign-off — not just who was on the call.",
    fields: [
      { id: "koc_date", label: "KOC date", type: "date", req: true, half: true },
      { id: "am_name", label: "AM completing this form", type: "text", req: true, half: true },
      { id: "ae_name", label: "AE on the account", type: "text", req: true, half: true },
      { id: "company", label: "Company / business name", type: "text", req: true, half: true },
      { id: "contact_name", label: "Main contact — name and role", type: "text", req: true,
        hint: "The person with final design sign-off." },
      { id: "contact_email", label: "Main contact email", type: "email", req: true, half: true },
      { id: "contact_phone", label: "Phone number", type: "text", req: true, half: true },
      { id: "address_street", label: "Street address", type: "text", half: true,
        hint: "The address they want public — feeds the map + local SEO." },
      { id: "address_city", label: "City", type: "text", half: true },
      { id: "address_state", label: "State", type: "select", half: true,
        options: US_STATES.map((s) => ({ value: s, label: s })) },
      { id: "address_zip", label: "ZIP code", type: "text", half: true, hint: "12345 or 12345-6789" },
      { id: "hours", label: "Hours of operation", type: "hours" },
    ],
  },
  {
    num: "02", title: "Package and scope", chatbot: true,
    sub: "Set by the sale — confirm what was sold, then collect what the included features need.",
    fields: [
      { id: "package", label: "Package sold", type: "select", options: PACKAGES, req: true, half: true },
      { id: "chatbot", label: "ChatBot on the site?", type: "segmented", options: ["Yes", "No"], half: true },
      { id: "form_notify_email", label: "Custom forms — notification email(s)", type: "text", req: true,
        hint: "Where do form submissions go? All packages." },
      { id: "url_email_1", label: "URL email 1", type: "text", cond: is5or10, tag: "5/10-page", half: true,
        hint: "Which to create (info@, sales@…)? Note migrations." },
      { id: "url_email_2", label: "URL email 2", type: "text", cond: is5or10, tag: "5/10-page", half: true },
      { id: "url_email_3", label: "URL email 3", type: "text", cond: is5or10, tag: "5/10-page", half: true },
      { id: "newsletter", label: "Newsletter platform", type: "text", cond: is5or10, tag: "5/10-page",
        hint: "Mailchimp, Constant Contact…? Does an account already exist?" },
      { id: "blog_ownership", label: "News/blog ownership", type: "text", cond: is10, tag: "10-page",
        hint: "Who writes posts — 44i or client? How often?" },
    ],
  },
  {
    num: "03", title: "Business snapshot",
    sub: "Where About Us, headlines, and tone come from. Capture in the owner's own words.",
    fields: [
      { id: "business_summary", label: "In a sentence or two, what does the business do and who for?",
        type: "textarea", req: true, hint: "Capture verbatim if you can — becomes homepage / About source material." },
      { id: "founding_story", label: "How long in business / founding story?", type: "textarea", rec: true },
      { id: "differentiator", label: "What makes you different from competitors?", type: "textarea", req: true,
        hint: "Push past 'great service' — if a customer picked you over the shop down the road, why?" },
    ],
  },
  {
    num: "04", title: "Goals and what success looks like",
    sub: "Discovery that feeds the strategist's page planning.",
    fields: [
      { id: "primary_goal", label: "Primary goal of the website", type: "segmented", req: true,
        options: ["Lead generation", "Booking / appointments", "E-commerce", "Informational", "Other"] },
      { id: "top_action", label: "The #1 action you want a visitor to take", type: "text", req: true,
        hint: "Drives the primary call-to-action sitewide." },
      { id: "top_services", label: "Top services or products to feature, ranked", type: "textarea", req: true,
        hint: "The headliners, not the full catalog." },
      { id: "success_6mo", label: "How will you know the site is working in 6 months?", type: "textarea", rec: true },
    ],
  },
  {
    num: "05", title: "Audience and market",
    sub: "Who lands on this site, and what they're worried about when they do.",
    fields: [
      { id: "ideal_customer", label: "Who is the ideal customer?", type: "textarea", req: true },
      { id: "competitor_1", label: "Competitor 1 URL", type: "text", rec: true, half: true,
        hint: "Not to copy — so you don't blend in." },
      { id: "competitor_2", label: "Competitor 2 URL", type: "text", half: true },
      { id: "competitor_3", label: "Competitor 3 URL", type: "text", half: true },
      { id: "industry_notes", label: "Anything about your industry we should know?", type: "textarea", rec: true,
        hint: "Compliance, licensing to display, seasonality, jargon to use or avoid." },
    ],
  },
  {
    num: "06", title: "Brand and design direction",
    sub: "The design team determines layout and strategy — this captures the client's raw preferences.",
    fields: [
      { id: "brand_personality", label: "Brand personality — pick up to 3", type: "text", rec: true,
        hint: "Modern, traditional, luxury, friendly, bold, minimal, playful, corporate, rugged, elegant, tech-forward, warm." },
      { id: "brand_colors", label: "Primary brand colors", type: "text", rec: true,
        hint: "Hex if they have them; otherwise describe and we pull from the logo." },
      { id: "fonts", label: "Fonts", type: "text", rec: true, hint: "Brand fonts? Name them. If none, we choose." },
      { id: "inspiration_url_1", label: "Inspiration site 1", type: "text", req: true, half: true,
        hint: "A URL alone is useless — capture the WHY next to it." },
      { id: "inspiration_why_1", label: "Why? (layout, colors, feel…)", type: "text", req: true, half: true },
      { id: "inspiration_url_2", label: "Inspiration site 2", type: "text", half: true },
      { id: "inspiration_why_2", label: "Why?", type: "text", half: true },
      { id: "avoid", label: "Things to AVOID", type: "textarea", req: true,
        hint: "Pet peeves, sites they hate, off-limits colors/words/imagery." },
    ],
  },
  {
    num: "07", title: "Brand assets", uploads: true,
    sub: "Drag files or browse — uploads resume if the connection drops. Big videos: paste a link instead.",
    fields: [
      { id: "image_rights", label: "Do they own the rights to images on their current site?",
        type: "segmented", options: ["Yes", "No", "Not sure"], req: true,
        hint: "If 'no' or 'not sure', we can't reuse them." },
      { id: "video_link", label: "Video link (YouTube / Vimeo / Drive)", type: "text", cond: is5or10, tag: "5/10-page" },
      { id: "photo_plan", label: "Photo plan if none exist", type: "text" },
    ],
  },
  {
    num: "08", title: "Content inventory and status",
    sub: "Decide who produces the copy first — every row below adapts to that answer.",
    checklist: true,  // rows come from CONTENT_ITEMS below, filtered by package
    fields: [
      { id: "copy_producer", label: "Is 44i producing the copy, or is content client-supplied?", type: "segmented", req: true,
        options: ["Client supplies", "44i writes it"],
        hint: "The biggest timeline assumption on the project — every row below adapts to this answer." },
    ],
  },
  {
    num: "09", title: "FAQs", faqs: true,
    sub: "10-20 real pre-purchase questions written the way a customer would type or speak them, each with a direct one- to two-sentence answer. This is the biggest AEO lever.",
    fields: [],
  },
  {
    num: "10", title: "Domain, hosting and access", sensitive: true,
    sub: "Sensitive — handle with care. These fields ride to the Trello card on handoff.",
    fields: [
      { id: "existing_url", label: "Existing website URL (or 'none / new build')", type: "text", req: true, half: true },
      { id: "desired_domain", label: "If new build — desired domain", type: "text", half: true },
      { id: "hosting", label: "Where is it hosted?", type: "text", req: true, half: true, hint: "GoDaddy, Wix, Squarespace, unknown…" },
      { id: "domain_owned", label: "Do they own the domain?", type: "segmented", options: ["Yes", "No", "Not sure"], req: true, half: true },
      { id: "current_cms", label: "Current CMS", type: "text", req: true, half: true },
      { id: "domain_emails", label: "Emails tied to the domain?", type: "segmented", req: true, half: true,
        options: ["Yes", "No", "Not sure"], hint: "If yes, don't disrupt them during migration." },
      { id: "email_provider", label: "Email provider (if yes)", type: "text", half: true,
        hint: "Google Workspace, Outlook, GoDaddy…" },
      { id: "registrar_login", label: "Domain registrar login", type: "text", half: true },
      { id: "cms_login", label: "CMS / admin login", type: "text", half: true },
      { id: "ga4_email", label: "Grant GA4 access to which email?", type: "email" },
    ],
  },
  {
    num: "11", title: "Pre-launch details",
    sub: "Locked in before go-live.",
    fields: [
      { id: "final_domain", label: "Confirm final domain", type: "text", half: true },
      { id: "www_pref", label: "www or non-www?", type: "segmented", options: ["www", "non-www"], half: true },
      { id: "launch_form_emails", label: "Form submissions go to which email(s)?", type: "text", req: true,
        hint: "Should match Section 02." },
      { id: "cms_access_people", label: "Who needs CMS access post-launch?", type: "textarea", req: true,
        hint: "First name, last name, email — per person." },
      { id: "launch_date", label: "Launch date target / hard deadline?", type: "text", rec: true },
    ],
  },
];

// Section 08 rows. cond hides rows not in the sold package ("skip rows
// not in the package" per the intake doc).
const CONTENT_ITEMS = [
  { label: "About Us / company story" },
  { label: "Team bios + headshots" },
  { label: "Service descriptions (copy)" },
  { label: "Product info + images" },
  { label: "Testimonials", cond: is5or10, tag: "5/10-page" },
  { label: "Legal/policy pages" },
  { label: "Pricing (if shown publicly)" },
];

const ASSET_CATEGORIES = [
  { id: "logo", label: "Logo", req: true, hint: "Vector (EPS/SVG) or high-res transparent PNG preferred." },
  { id: "images", label: "Images for the site", req: true, hint: "The #1 launch-delay cause — decide on the call." },
  { id: "brand_guide", label: "Brand guide / style guide", hint: "If one exists." },
  { id: "other", label: "Other files" },
];

function allRequiredFields(data) {
  const out = [];
  for (const s of SECTIONS) {
    for (const f of s.fields) {
      if (!f.req) continue;
      if (f.cond && !f.cond(data.package)) continue;
      out.push(f);
    }
  }
  return out;
}

function missingRequired(data) {
  return allRequiredFields(data).filter((f) => !String(data[f.id] ?? "").trim());
}
