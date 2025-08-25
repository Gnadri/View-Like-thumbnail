// background.js (MV3) — batches requests + logs error bodies

let cache = new Map();          // videoId -> { likes, views, t }
let cacheDuration = 600000;     // 10 min
let apiKey = "";

// Batch queue
const pending = new Map();      // videoId -> [sendResponse, ...]
let batchSet = new Set();       // videoIds waiting to be fetched
let batchTimer = null;
const BATCH_WINDOW_MS = 120;    // collect IDs for this long
const MAX_IDS_PER_REQUEST = 50; // API limit

console.log("[BG] service worker loaded", new Date().toISOString());

chrome.storage.sync.get({ cacheDuration: 600000, apiKey: "" }, (s) => {
  cacheDuration = s.cacheDuration ?? 600000;
  apiKey = (s.apiKey ?? "").trim();
  console.log("[BG] settings loaded:", { cacheDuration, hasApiKey: !!apiKey });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.query === "ping") {
    sendResponse({ pong: true, ts: Date.now() });
    return; // sync
  }

  if (msg.query === "updateSettings") {
    if (typeof msg.cacheDuration === "number") cacheDuration = msg.cacheDuration;
    if (typeof msg.apiKey === "string") apiKey = msg.apiKey.trim();
    console.log("[BG] settings updated:", { cacheDuration, hasApiKey: !!apiKey });
    return; // sync
  }

  if (msg.query === "getStats" && msg.videoId) {
    // Serve from cache if fresh
    const hit = cache.get(msg.videoId);
    if (hit && Date.now() - hit.t < cacheDuration) {
      sendResponse({ likes: hit.likes, views: hit.views });
      return; // sync
    }

    // Queue this id
    let arr = pending.get(msg.videoId);
    if (!arr) pending.set(msg.videoId, (arr = []));
    arr.push(sendResponse);
    batchSet.add(msg.videoId);

    if (!batchTimer) batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);

    // async response
    return true;
  }
});

// Flush the batch of queued IDs
async function flushBatch() {
  batchTimer = null;
  if (!apiKey) {
    console.warn("[BG] no API key set");
    // respond null to all pending
    for (const [id, callbacks] of pending) {
      for (const cb of callbacks) cb(null);
    }
    pending.clear();
    batchSet.clear();
    return;
  }

  const ids = Array.from(batchSet);
  batchSet.clear();

  // Process in chunks of 50
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);

    try {
      const url =
        "https://www.googleapis.com/youtube/v3/videos" +
        `?part=statistics&id=${encodeURIComponent(chunk.join(","))}` +
        `&key=${apiKey}`;

      const res = await fetch(url);
      let body = null;
      try { body = await res.json(); } catch {}

      if (!res.ok) {
        console.error("[BG] fetch not ok:", res.status, res.statusText, "body:", body);
        // deliver null for each ID in this chunk
        for (const id of chunk) {
          const cbs = pending.get(id) || [];
          for (const cb of cbs) cb(null);
          pending.delete(id);
        }
        continue;
      }

      // Map id -> {likes, views}
      const map = new Map();
      const items = body?.items || [];
      for (const it of items) {
        const st = it.statistics || {};
        const id = it.id;
        const likes = Number(st.likeCount ?? 0);
        const views = Number(st.viewCount ?? 0);
        map.set(id, { likes, views });
        cache.set(id, { likes, views, t: Date.now() });
      }

      // Respond to all callbacks
      for (const id of chunk) {
        const cbs = pending.get(id) || [];
        const data = map.get(id) || null;
        for (const cb of cbs) cb(data);
        pending.delete(id);
      }
    } catch (e) {
      console.error("[BG] batch fetch error:", e);
      for (const id of chunk) {
        const cbs = pending.get(id) || [];
        for (const cb of cbs) cb(null);
        pending.delete(id);
      }
    }
  }
}
