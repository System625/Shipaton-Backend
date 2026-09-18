// OneSignal delivery. One call per notification, not a batch: `include_aliases`
// can target many recipients in one call, but only with IDENTICAL content, and
// every row here says something different (who did what to whom) — there is
// nothing to batch, only to decouple, which push-sweep/index.ts does at the sweep
// level instead.
//
// Request shape checked against documentation.onesignal.com/reference/create-message
// on 15 Sep 2026, not assumed: `include_aliases.external_id`, `headings`/`contents`
// (both keyed by locale — `en` is the only one this app ships), `Authorization: Key
// <REST API key>`, and `app_id` is required in the body itself, not implied by the
// key.

const ONESIGNAL_URL = "https://api.onesignal.com/notifications";

export type OneSignalMessage = {
  // The Supabase user id, per item 7 of the OneSignal plan: the app calls
  // `OneSignal.login(<supabase user id>)` on sign-in, which is what makes
  // external_id targeting resolve to a real device with no device-token table on
  // our side.
  externalId: string;
  title: string;
  body: string;
};

export class OneSignalError extends Error {}

export async function sendOneSignalPush(
  apiKey: string,
  appId: string,
  msg: OneSignalMessage,
): Promise<void> {
  const res = await fetch(ONESIGNAL_URL, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: appId,
      include_aliases: { external_id: [msg.externalId] },
      target_channel: "push",
      headings: { en: msg.title },
      contents: { en: msg.body },
    }),
  });
  if (!res.ok) {
    throw new OneSignalError(`OneSignal ${res.status}: ${await res.text()}`);
  }
}

// The copy. Kept next to the sender rather than in the sweep loop so the notify
// triggers' semantics (20260909121000_notifications.sql), the game_release sweep's
// (20260917130000), and the push strings stay in one place — add a kind in the
// schema and this is the other place that has to change.
//
// `name` is the actor's display name for the three social kinds, and the game's
// title for `game_release` — there is no actor to name (20260917130000).
export function pushCopyFor(
  kind: "follow" | "post_like" | "post_comment" | "game_release" | "post_repost" | "post_mention",
  name: string,
): { title: string; body: string } {
  switch (kind) {
    case "follow":
      return { title: "New follower", body: `${name} started following you` };
    case "post_like":
      return { title: "New like", body: `${name} liked your post` };
    case "post_comment":
      return { title: "New comment", body: `${name} commented on your post` };
    case "game_release":
      return { title: "Out today", body: `${name} just released` };
    case "post_repost":
      return { title: "New repost", body: `${name} reposted your post` };
    case "post_mention":
      return { title: "New mention", body: `${name} mentioned you in a post` };
  }
}
