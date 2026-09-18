// game-artwork: fills games.artwork_url with a wide IGDB image for the feed's game card.
//
// POST {"gameIds": string[]} (50 at most). Returns {"artwork": {"<game uuid>": "<url or ''>"}}
// for every requested id that exists. An empty string means IGDB has no art for that game.
//
// JWT verification stays on. Any signed-in user can call it. The service_role key also works,
// so the demo seed can fill art for every game its posts name.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const MAX_IDS = 50;
const IGDB_PAGE = 500;
const IMAGE_BASE = 'https://images.igdb.com/igdb/image/upload/t_screenshot_huge';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------------------------
// Twitch app token. Kept in module scope so a warm instance does not ask Twitch on every call.

let cachedToken: { value: string; expiresAt: number } | null = null;

async function twitchToken(): Promise<string> {
  // A one-minute margin, so a token never expires between this check and the IGDB call.
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.value;
  const params = new URLSearchParams({
    client_id: Deno.env.get('TWITCH_CLIENT_ID') ?? '',
    client_secret: Deno.env.get('TWITCH_CLIENT_SECRET') ?? '',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Twitch token request failed (${res.status})`);
  const body = await res.json();
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

type IgdbImage = { id: number; game: number; image_id?: string; width?: number; height?: number };

async function igdb(endpoint: 'screenshots' | 'artworks', query: string): Promise<IgdbImage[]> {
  const token = await twitchToken();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: 'POST',
      headers: {
        'Client-ID': Deno.env.get('TWITCH_CLIENT_ID') ?? '',
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body: query,
    });
    // IGDB allows 4 requests a second. One short wait covers a burst from parallel callers.
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    if (res.status === 401) cachedToken = null;
    if (!res.ok) throw new Error(`IGDB ${endpoint} failed (${res.status}): ${await res.text()}`);
    return await res.json();
  }
}

/** One image per IGDB game id, the lowest image id first. Pages past 500 rows, so a game
 *  with many screenshots cannot push another game out of the result. */
async function lowestImages(endpoint: 'screenshots' | 'artworks', igdbIds: number[]): Promise<Map<number, string>> {
  const best = new Map<number, { id: number; imageId: string }>();
  for (let offset = 0; ; offset += IGDB_PAGE) {
    const rows = await igdb(
      endpoint,
      `fields game,image_id,width,height; where game = (${igdbIds.join(',')}); sort id asc; limit ${IGDB_PAGE}; offset ${offset};`,
    );
    for (const row of rows) {
      if (!row.image_id) continue;
      const seen = best.get(row.game);
      if (!seen || row.id < seen.id) best.set(row.game, { id: row.id, imageId: row.image_id });
    }
    if (rows.length < IGDB_PAGE || offset >= 4 * IGDB_PAGE) break;
  }
  return new Map([...best].map(([game, v]) => [game, `${IMAGE_BASE}/${v.imageId}.jpg`]));
}

/** The role claim of the caller's JWT. The gateway has already checked the signature. */
function callerRole(req: Request): string | null {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))).role ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  // The anon key is a valid JWT too. Only signed-in users (and the service role) may spend
  // the IGDB quota.
  const role = callerRole(req);
  if (role !== 'authenticated' && role !== 'service_role') return json({ error: 'Sign in first.' }, 401);

  let body: { gameIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'The body must be JSON: {"gameIds": string[]}.' }, 400);
  }
  const raw = body?.gameIds;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    return json({ error: 'gameIds must be an array of strings.' }, 400);
  }
  if (raw.length > MAX_IDS) return json({ error: `Send ${MAX_IDS} game ids or fewer.` }, 400);

  // A string that is not a uuid cannot match a game, and it would make the query fail.
  const ids = [...new Set(raw as string[])].filter((id) => UUID.test(id));
  if (ids.length === 0) return json({ artwork: {} });

  const { data: games, error } = await admin.from('games').select('id, igdb_id, artwork_url').in('id', ids);
  if (error) return json({ error: error.message }, 500);

  const artwork: Record<string, string> = {};
  const todo = new Map<number, string[]>(); // IGDB id -> game uuids (a catalog can hold duplicates)
  for (const g of games ?? []) {
    // null: not checked yet. '': checked, IGDB has nothing. Anything else: a URL.
    if (g.artwork_url !== null) artwork[g.id] = g.artwork_url;
    else if (g.igdb_id === null) artwork[g.id] = ''; // Nothing to ask IGDB. Left null for a later catalog sync.
    else todo.set(g.igdb_id, [...(todo.get(g.igdb_id) ?? []), g.id]);
  }
  if (todo.size === 0) return json({ artwork });

  let found: Map<number, string>;
  try {
    found = await lowestImages('screenshots', [...todo.keys()]);
    const noScreenshot = [...todo.keys()].filter((id) => !found.has(id));
    if (noScreenshot.length) {
      for (const [game, url] of await lowestImages('artworks', noScreenshot)) found.set(game, url);
    }
  } catch (e) {
    // Write nothing: an empty string would wrongly mark these games as having no art.
    return json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }

  const writes: PromiseLike<unknown>[] = [];
  for (const [igdbId, gameIds] of todo) {
    const url = found.get(igdbId) ?? '';
    for (const id of gameIds) {
      artwork[id] = url;
      // "is null" keeps a value that a parallel call wrote first.
      writes.push(admin.from('games').update({ artwork_url: url }).eq('id', id).is('artwork_url', null));
    }
  }
  const results = (await Promise.all(writes)) as { error: { message: string } | null }[];
  const failed = results.find((r) => r.error);
  if (failed?.error) return json({ error: failed.error.message, artwork }, 500);

  return json({ artwork });
});
