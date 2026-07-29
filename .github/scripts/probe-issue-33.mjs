#!/usr/bin/env node
// Temporary read-only diagnostic: fetch current detail for GlitchTip issue 33 to compare
// event count / lastSeen against the snapshot recorded when GitHub #2212 was closed.
const GLITCHTIP_TOKEN = process.env.GLITCHTIP_TOKEN;
const GLITCHTIP_BASE_URL = process.env.GLITCHTIP_BASE_URL;

async function main() {
  const res = await fetch(new URL(`${GLITCHTIP_BASE_URL}/api/0/issues/33/`), {
    headers: { Authorization: `Bearer ${GLITCHTIP_TOKEN}` },
  });
  const issue = await res.json();
  console.log(JSON.stringify({
    id: issue.id,
    status: issue.status,
    title: issue.title,
    count: issue.count,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    numComments: issue.numComments,
  }, null, 2));

  const eventRes = await fetch(new URL(`${GLITCHTIP_BASE_URL}/api/0/issues/33/events/latest/`), {
    headers: { Authorization: `Bearer ${GLITCHTIP_TOKEN}` },
  });
  const event = await eventRes.json();
  console.log("--- latest event ---");
  console.log(JSON.stringify({
    dateCreated: event.dateCreated,
    message: event.metadata?.value ?? event.message,
    tags: event.tags,
  }, null, 2));
}

main();
