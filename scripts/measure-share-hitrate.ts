// Runs a batch of REAL TikTok links through the deployed /share-resolve and reports,
// per link: the caption oEmbed gave back, whether it was matched, how confidently,
// and what the top candidate was. This is the hit-rate measurement that could not be
// done without real gaming captions from the user.
//
// Creates its own user and deletes it again.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";

const SUPABASE_URL = required("SUPABASE_URL");
const ANON_KEY = required("SUPABASE_ANON_KEY");
const FUNCTIONS = `${SUPABASE_URL}/functions/v1`;
const RUN = Date.now();

const LINKS = process.argv[2] ?? "scripts/fixtures/tiktok-share-links.txt";
const links = readFileSync(LINKS, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

async function main() {
  const email = `verify+hitrate-${RUN}@shelf.test`;
  const password = `Shelf-hitrate-${RUN}!`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signInError } =
    await anon.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);
  const token = signedIn.session!.access_token;

  const rows: any[] = [];
  try {
    for (const [i, url] of links.entries()) {
      const started = Date.now();
      const res = await fetch(`${FUNCTIONS}/share-resolve`, {
        method: "POST",
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      const body: any = await res.json().catch(() => null);
      const ms = Date.now() - started;
      const row = {
        n: i + 1,
        url,
        status: res.status,
        ms,
        caption: body?.extractedText ?? null,
        confident: body?.confident ?? null,
        candidates: (body?.candidates ?? []).map((c: any) => c.title),
        top: body?.candidates?.[0]?.title ?? null,
      };
      rows.push(row);
      console.log(
        `\n[${row.n}/${links.length}] ${url.split("?")[0]}\n` +
        `   HTTP ${row.status} in ${ms}ms\n` +
        `   caption: ${row.caption === null ? "(none — oEmbed gave nothing)" : JSON.stringify(row.caption)}\n` +
        `   confident: ${row.confident}   top: ${row.top ?? "(unmatched)"}\n` +
        `   candidates: ${row.candidates.length ? row.candidates.join(" | ") : "(none)"}`,
      );
    }
  } finally {
    await admin.auth.admin.deleteUser(created.user!.id);
    console.log("\ncleaned up test user.");
  }

  const withCaption = rows.filter((r) => r.caption);
  const confident = rows.filter((r) => r.confident);
  const anyCandidate = rows.filter((r) => r.candidates.length > 0);
  console.log(`\n--- totals over ${rows.length} links ---`);
  console.log(`oEmbed returned a caption : ${withCaption.length}/${rows.length}`);
  console.log(`confident: true           : ${confident.length}/${rows.length}`);
  console.log(`at least one candidate    : ${anyCandidate.length}/${rows.length}`);
  console.log(`\nJSON:\n${JSON.stringify(rows, null, 2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
