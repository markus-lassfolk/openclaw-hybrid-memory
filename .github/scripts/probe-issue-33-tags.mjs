#!/usr/bin/env node
// Temporary read-only diagnostic (to be reverted): list every recorded event for GlitchTip
// issue 33 with its release tag, to check whether recent occurrences come from clients still
// running a pre-fix version (v2026.7.225 or earlier) rather than a genuine post-fix regression.
const GLITCHTIP_TOKEN = process.env.GLITCHTIP_TOKEN;
const GLITCHTIP_BASE_URL = process.env.GLITCHTIP_BASE_URL;

async function main() {
  const res = await fetch(new URL(`${GLITCHTIP_BASE_URL}/api/0/issues/33/events/`), {
    headers: { Authorization: `Bearer ${GLITCHTIP_TOKEN}` },
  });
  const events = await res.json();
  const summary = (Array.isArray(events) ? events : []).map((event) => {
    const tags = Object.fromEntries((event.tags ?? []).map((t) => [t.key, t.value]));
    return {
      dateCreated: event.dateCreated,
      eventId: event.eventID ?? event.id,
      release: tags.release ?? null,
      environment: tags.environment ?? null,
      allTags: tags,
    };
  });
  console.log(JSON.stringify({ count: summary.length, events: summary }, null, 2));
}

main();
