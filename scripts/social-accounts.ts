// Throwaway signed-in accounts, shared by the three social verification scripts.
//
// Every one of them has to answer the same question -- "what can a REAL user, holding
// a real JWT, actually reach?" -- and the service-role client in supabase-admin.ts
// cannot answer it, because it bypasses RLS by design. So each script creates users,
// signs them in through the anon key, and drives the whole check through those
// sessions. This module is only the part that was being copied between them.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";

const SUPABASE_URL = required("SUPABASE_URL");
const ANON_KEY = required("SUPABASE_ANON_KEY");

/** Stamps handles and emails so re-runs never collide with a previous run's leftovers. */
export const RUN = Date.now();
const PASSWORD = `Shelf-social-${RUN}!`;

export type Account = { userId: string; handle: string; client: SupabaseClient };

export async function signUp(tag: string): Promise<Account> {
  const email = `verify+social-${tag}-${RUN}@shelf.test`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);
  // Handles are lowercase and 3-20 chars; the run stamp keeps re-runs from colliding.
  const handle = `v${tag}${RUN}`.toLowerCase().slice(0, 20);
  return { userId: created.user!.id, handle, client };
}

/** Signs up and writes the profile row the app is meant to write on first sign-in. */
export async function signUpWithProfile(tag: string, displayName: string): Promise<Account> {
  const acct = await signUp(tag);
  const { error } = await acct.client.from("profiles").insert({
    user_id: acct.userId, handle: acct.handle, display_name: displayName,
    avatar_color: "green",
  });
  if (error) throw new Error(`profile for ${tag}: ${error.message}`);
  return acct;
}

export async function removeAccounts(accounts: Account[]): Promise<void> {
  for (const acct of accounts) {
    await admin.auth.admin.deleteUser(acct.userId);
  }
}

/** PASS/FAIL line plus a failure tally, identical across the scripts. */
export function makeChecker() {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };
  const finish = () => {
    console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
    process.exit(failures === 0 ? 0 : 1);
  };
  return { check, finish };
}
