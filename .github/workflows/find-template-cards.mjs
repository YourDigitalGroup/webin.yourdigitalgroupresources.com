#!/usr/bin/env node
/* Finds your "Website Packages - {1|5|10} page Monthly Recurring Revenue
   Template" lists anywhere in your Trello workspace and generates the
   package_templates seed SQL.

   Usage:
     TRELLO_KEY=xxx TRELLO_TOKEN=yyy node tools/find-template-cards.mjs > supabase/templates-seed.sql

   Review the output, then run it in the Supabase SQL editor. */

const KEY = process.env.TRELLO_KEY, TOKEN = process.env.TRELLO_TOKEN;
if (!KEY || !TOKEN) { console.error("Set TRELLO_KEY and TRELLO_TOKEN."); process.exit(1); }

const boards = await (await fetch(
  `https://api.trello.com/1/members/me/boards?filter=open&fields=id,name&key=${KEY}&token=${TOKEN}`,
)).json();

const found = [];
for (const b of boards) {
  const lists = await (await fetch(
    `https://api.trello.com/1/boards/${b.id}/lists?fields=id,name&key=${KEY}&token=${TOKEN}`,
  )).json();
  for (const l of lists) {
    const m = l.name.match(/website packages\s*-\s*(1|5|10)\s*page\s*monthly/i);
    if (m) found.push({ pkg: `monthly-${m[1]}`, list: l, board: b.name });
  }
}

console.log(`-- Generated ${new Date().toISOString()}`);
if (!found.length) {
  console.log("-- No template lists found. Check the token can see the template board.");
} else {
  for (const f of found) console.log(`-- ${f.pkg}: "${f.list.name}" on board "${f.board}"`);
  console.log(`\ninsert into public.package_templates (package, trello_list_id, list_name) values`);
  console.log(found.map((f) =>
    `  ('${f.pkg}', '${f.list.id}', '${f.list.name.replace(/'/g, "''")}')`).join(",\n"));
  console.log(`on conflict (package) do update set
  trello_list_id = excluded.trello_list_id,
  list_name = excluded.list_name;`);
}
console.error(`Done — ${found.length} template lists found.`);
