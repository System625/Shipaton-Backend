import { createClient } from "@supabase/supabase-js";
import { required } from "./env.ts";

// Service role. Local scripts only — this key bypasses RLS entirely and must
// never reach the app bundle.
export const admin = createClient(
  required("SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);
