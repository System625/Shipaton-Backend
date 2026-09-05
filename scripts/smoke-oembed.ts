// Checks the oEmbed endpoints from wherever this is run.
//
// The point of this script is the DEPLOYED case. Both endpoints were verified from
// a laptop on a residential connection on 4 Sep 2026; one cross-check report claims
// they throttle or 403 datacenter IPs, which is untested. Run this locally to get a
// baseline, then hit the deployed /share/resolve against the same links. If it
// works here and 403s there, that is the answer, and the fallback is OpenGraph tags.
//
//   npx tsx scripts/smoke-oembed.ts [url ...]

import {
  detectProvider,
  extractCandidateTexts,
  fetchOEmbed,
} from "../supabase/functions/_shared/oembed.ts";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: tsx scripts/smoke-oembed.ts <youtube-url> <tiktok-url>");
  process.exit(1);
}

for (const url of urls) {
  const provider = detectProvider(url);
  process.stdout.write(`\n${provider.padEnd(8)} ${url}\n`);
  try {
    const result = await fetchOEmbed(url, provider);
    if (!result) {
      console.log("  no oEmbed response (non-2xx or unsupported provider)");
      continue;
    }
    console.log(`  title      ${result.title}`);
    console.log(`  candidates ${JSON.stringify(extractCandidateTexts(result.title, provider))}`);
  } catch (e) {
    console.log(`  FAILED ${(e as Error).message}`);
  }
}
