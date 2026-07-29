#!/usr/bin/env node
// Temporary read-only diagnostic (to be reverted): check the release tag on the single most
// recent recorded event for GlitchTip issue 33, to see whether it postdates v2026.7.227 (the
// release containing both prior fixes) or is still from an older, unpatched client.
const GLITCHTIP_TOKEN = process.env.GLITCHTIP_TOKEN;
const GLITCHTIP_BASE_URL = process.env.GLITCHTIP_BASE_URL;

async function main() {
  const res = await fetch(new URL(`${GLITCHTIP_BASE_URL}/api/0/issues/33/events/latest/`), {
    headers: { Authorization: `Bearer ${GLITCHTIP_TOKEN}` },
  });
  const event = await res.json();
  const tags = Object.fromEntries((event.tags ?? []).map((t) => [t.key, t.value]));
  console.log(
    JSON.stringify(
      {
        eventId: event.eventID ?? event.id,
        dateCreated: event.dateCreated ?? event.dateReceived ?? null,
        release: tags.release ?? null,
        allTags: tags,
      },
      null,
      2,
    ),
  );
}

main();
