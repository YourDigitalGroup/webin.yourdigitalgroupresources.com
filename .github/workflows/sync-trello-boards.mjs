#!/usr/bin/env node
/* Pulls every Trello board your token can see (all ~40 partner boards) and
   generates partners-seed.sql for the Supabase partners table.

   Usage:
     TRELLO_KEY=xxx TRELLO_TOKEN=yyy node tools/sync-trello-boards.mjs > supabase/partners-seed.sql

   Then open partners-seed.sql, review each partner:
     - fix the partner name if the board name isn't it
     - confirm the chosen list (the script prefers a list named To Do /
       Incoming / New / Backlog / Queue; alternatives are in the comment)
   and run it in the Supabase SQL editor. Re-running is safe — it upserts
   by board id, so new boards get added and existing rows keep their names.

   Needs Node 18+ (built-in fetch). No dependencies. */

const KEY = process.env.TRELLO_KEY;
const TOKEN = process.env.TRELLO_TOKEN;
if (!KEY || !TOKEN) {
  console.error("Set TRELLO_KEY and TRELLO_TOKEN environment variables.");
  process.exit(1);
}

const PREFERRED = /^(to.?do|incoming|new|backlog|queue|requests?)$/i;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const boards = await (await fetch(
  `https://api.trello.com/1/members/me/boards?filter=open&fields=id,name&key=${KEY}&token=${TOKEN}`,
)).json();

console.log(`-- Generated ${new Date().toISOString()} — ${boards.length} open boards`);
console.log(`-- Review names + chosen lists, then run in the Supabase SQL editor.\n`);

for (const b of boards) {
  const lists = await (await fetch(
    `https://api.trello.com/1/boards/${b.id}/lists?fields=id,name&key=${KEY}&token=${TOKEN}`,
  )).json();
  const chosen = lists.find((l) => PREFERRED.test(l.name.trim())) ?? lists[0];
  const alternatives = lists.map((l) => `${l.name}=${l.id}`).join("  |  ");

  console.log(`-- ${b.name}`);
  console.log(`--   lists: ${alternatives || "none"}`);
  console.log(
    `insert into public.partners (name, trello_board_id, trello_board_name, trello_list_id)\n` +
    `values (${q(b.name)}, ${q(b.id)}, ${q(b.name)}, ${chosen ? q(chosen.id) : "null"})\n` +
    `on conflict (name) do update set\n` +
    `  trello_board_id = excluded.trello_board_id,\n` +
    `  trello_board_name = excluded.trello_board_name,\n` +
    `  trello_list_id = coalesce(public.partners.trello_list_id, excluded.trello_list_id);\n`,
  );
}

console.error(`Done — ${boards.length} boards written to stdout.`);
