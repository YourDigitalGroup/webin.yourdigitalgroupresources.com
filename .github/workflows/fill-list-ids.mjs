#!/usr/bin/env node
/* Optional precision step. For every partner board, fetches its Trello lists
   and generates UPDATE statements pinning the exact list new cards land in.
   Without this, the handoff function falls back to each board's
   To Do/Incoming-style list (or the first list) automatically.

   Usage:
     TRELLO_KEY=xxx TRELLO_TOKEN=yyy node tools/fill-list-ids.mjs > supabase/list-ids.sql

   Review list-ids.sql (each board's alternatives are in the comments),
   then run it in the Supabase SQL editor. */

const KEY = process.env.TRELLO_KEY, TOKEN = process.env.TRELLO_TOKEN;
if (!KEY || !TOKEN) { console.error("Set TRELLO_KEY and TRELLO_TOKEN."); process.exit(1); }

const BOARDS = [
  "6890f5fdb1bb4aaeade9ff44","636abe1c0a62a9020d913ee4","651b0e13f3f93751e929d532",
  "6a039cec5501c243057c96da","61f2ba4730e86031d7d5ddc8","644bc660a882a19216babcee",
  "64df7b23387279b4b6dec42f","5da611d5c4c6f075b070b1b9","663a6f5e77975074cc20a488",
  "5d9d551fe3f6500291c9050a","663a6bfd28864bb31466a645","67f53a37b808ef0bce516bb4",
  "6398a719f01d54017f5345b7","5f9182016d518c1dad63614e","6978cd47729a4b5d56ce9b62",
  "64021a0650bb9de57aa4f04a","657c5ea87f06add5cae5670f","67b6203d4dfee4fd0f980ab8",
  "6859942ef0a83ee6df76e78a","66cf379f235fc41bf07bfd52","65202e418a97c6ff9c2dc832",
  "65b030aee6cf7427f20135e3","6696b132170f21a6d0a2a7d4","66f2d31d5f24f63832dbebe1",
  "6724fe60fceb61634a3437e2","640f253654e864cfa9659fa0","66a17377c3ff4a0772abe3b8",
  "5da9c2e52d99235ff759ad4d","68cd6db945784e94b8030742","67cf3746eea192006b3a95f5",
  "67c9e213cbe81cbeb00a16fc","6899f87c5eb5418937e924c2","69d7bc2debd0c6c9a9bd441a",
  "63ada119f73d7d016c8a19c1","6102f2da956132044a8e0ac6","69c15cf2f838bf070cfae237",
  "5dd2f6ba170a4403bc0dbe99","6938a0e084b59f72f2358eb0","69e13e76a9077c7b6a99b1fc",
];

const PREFERRED = /^(to.?do|incoming|new|backlog|queue|requests?)$/i;
console.log(`-- Generated ${new Date().toISOString()} — review, then run in the SQL editor.\n`);

for (const id of BOARDS) {
  const res = await fetch(`https://api.trello.com/1/boards/${id}/lists?fields=id,name&key=${KEY}&token=${TOKEN}`);
  if (!res.ok) { console.log(`-- board ${id}: ${res.status} ${res.statusText} — token can't see it? skipped\n`); continue; }
  const lists = await res.json();
  const chosen = lists.find((l) => PREFERRED.test(l.name.trim())) ?? lists[0];
  console.log(`-- board ${id} lists: ${lists.map((l) => `${l.name}=${l.id}`).join("  |  ") || "none"}`);
  if (chosen) console.log(`update public.partners set trello_list_id = '${chosen.id}' where trello_board_id = '${id}';\n`);
  else console.log(`-- no lists found on this board — set trello_list_id manually.\n`);
}
console.error("Done.");
