// Netlify Function: shared state store for the Standley dashboard.
//
// SETUP (one-time, if not already done):
//   1. Set environment variables NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN.
//   2. Run npm install @netlify/blobs.
//   3. Deploy.
//
// Tombstones: when a client sends `deletes: ["bucket:key", ...]`, the server
// records each deleted path in a tombstones map with a timestamp. Future
// pushes from OTHER clients (which may still have the deleted key in their
// local state) get stripped of those keys before being persisted. Tombstones
// expire after TOMBSTONE_TTL_MS (default 6 hours) so the data doesn't grow
// forever and stale tombstones don't block legitimate future writes.
//
// If a client explicitly wants to "re-add" a tombstoned key, they include
// `clearTombstones: ["bucket:key", ...]` alongside the new value — that
// removes the tombstone BEFORE the new value is processed.

const { getStore } = require("@netlify/blobs");

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TOMBSTONE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getStandleyStore() {
  try {
    return getStore("standley-state");
  } catch (autoErr) {
    const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
    if (!siteID || !token) {
      throw new Error(
        "Netlify Blobs is not auto-configured for this function, and the " +
        "fallback env vars are missing. Set NETLIFY_SITE_ID and " +
        "NETLIFY_BLOBS_TOKEN in Site configuration → Environment variables."
      );
    }
    return getStore({ name: "standley-state", siteID, token, consistency: "strong" });
  }
}

// Helper: split "bucket:key" path. Buckets have no colons; keys may.
function splitPath(path) {
  const idx = path.indexOf(":");
  if (idx < 0) return [null, null];
  return [path.slice(0, idx), path.slice(idx + 1)];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: HEADERS, body: "" };
  }

  let store;
  try {
    store = getStandleyStore();
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(e.message || e) }) };
  }

  try {
    if (event.httpMethod === "GET") {
      const state = await store.get("shared", { type: "json" });
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(state || {}) };
    }

    if (event.httpMethod === "POST") {
      const incoming = JSON.parse(event.body || "{}");
      const current = (await store.get("shared", { type: "json" })) || {};
      const merge = (a, b) => Object.assign({}, a || {}, b || {});

      // Carry forward existing tombstones, prune expired ones
      const tombstones = Object.assign({}, current.tombstones || {});
      const now = Date.now();
      Object.keys(tombstones).forEach((path) => {
        if (typeof tombstones[path] !== "number" || (now - tombstones[path]) > TOMBSTONE_TTL_MS) {
          delete tombstones[path];
        }
      });

      // If the client explicitly wants to revive a tombstoned key, honor that BEFORE merging
      if (Array.isArray(incoming.clearTombstones)) {
        incoming.clearTombstones.forEach((path) => { delete tombstones[path]; });
      }

      // Merge state additively
      const next = {
        changeActions:   merge(current.changeActions,   incoming.changeActions),
        changeNotes:     merge(current.changeNotes,     incoming.changeNotes),
        actionsNotified: merge(current.actionsNotified, incoming.actionsNotified),
        changeResolved:  merge(current.changeResolved,  incoming.changeResolved),
        responded:       merge(current.responded,       incoming.responded),
        dismissed:       merge(current.dismissed,       incoming.dismissed),
        lastDigestSent:  incoming.lastDigestSent || current.lastDigestSent || null,
        updatedAt:       now,
        updatedBy:       incoming.updatedBy || current.updatedBy || "unknown",
        tombstones:      tombstones,
      };

      // Apply incoming explicit deletes — remove from data AND add to tombstones
      if (Array.isArray(incoming.deletes)) {
        incoming.deletes.forEach((path) => {
          const [bucket, key] = splitPath(path);
          if (bucket && key && next[bucket] && next[bucket][key] !== undefined) {
            delete next[bucket][key];
          }
          if (bucket && key) tombstones[path] = now;
        });
      }

      // Re-apply ALL active tombstones — strip any keys that incoming tried to resurrect
      Object.keys(tombstones).forEach((path) => {
        const [bucket, key] = splitPath(path);
        if (bucket && key && next[bucket] && next[bucket][key] !== undefined) {
          delete next[bucket][key];
        }
      });

      next.tombstones = tombstones;
      await store.setJSON("shared", next);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(next) };
    }

    if (event.httpMethod === "DELETE") {
      await store.delete("shared");
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  } catch (e) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
