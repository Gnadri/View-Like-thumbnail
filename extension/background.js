// background.js (MV3 service worker) — with extra logs & a ping

let cache = new Map();           // videoId -> {likes, views, t}
let cacheDuration = 600000;      // 10 min default
let apiKey = "";                 // set via chrome.storage.sync { apiKey: "..." }

// --- startup logging
console.log("[BG] service worker loaded", new Date().toISOString());
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[BG] onInstalled:", details.reason);
});
chrome.runtime.onStartup?.addListener(() => {
  console.log("[BG] onStartup fired");
});

// Load settings on worker start (not just onInstalled)
chrome.storage.sync.get({ cacheDuration: 600000, apiKey: "" }, (s) => {
  cacheDuration = s.cacheDuration ?? 600000;
  apiKey = s.apiKey ?? "";
  console.log("[BG] settings loaded:", { cacheDuration, hasApiKey: !!apiKey });
});

async function fetchStats(videoId) {
  const now = Date.now();
  const hit = cache.get(videoId);
  if (hit && (now - hit.t) < cacheDuration) {
    console.log("[BG] cache hit", videoId, hit);
    return { likes: hit.likes, views: hit.views };
  }

  if (!apiKey) {
    console.warn("[BG] no API key set (chrome.storage.sync.apiKey)");
    return null;
  }

  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}&key=${apiKey}`;
  console.log("[BG] fetching:", url);

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error("[BG] fetch error:", e);
    return null;
  }
  if (!res.ok) {
    console.error("[BG] fetch not ok:", res.status, res.statusText);
    return null;
  }

  let json;
  try { json = await res.json(); }
  catch (e) { console.error("[BG] json error:", e); return null; }

  const stats = json?.items?.[0]?.statistics;
  if (!stats) {
    console.warn("[BG] no stats in response:", json);
    return null;
  }

  const likes = Number(stats.likeCount ?? 0);
  const views = Number(stats.viewCount ?? 0);
  cache.set(videoId, { likes, views, t: now });
  console.log("[BG] fetched stats:", videoId, { likes, views });
  return { likes, views };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // quick ping for diagnostics
  if (msg.query === "ping") {
    console.log("[BG] ping from", sender?.tab?.id ?? "n/a");
    sendResponse({ pong: true, ts: Date.now() });
    return; // no async
  }

  if (msg.query === "getStats" && msg.videoId) {
    (async () => {
      try {
        const data = await fetchStats(msg.videoId);
        sendResponse(data); // can be null on failure
      } catch (e) {
        console.error("[BG] getStats error:", e);
        sendResponse(null);
      }
    })();
    return true; // keep channel open for async
  }

  if (msg.query === "insertCss" && Array.isArray(msg.files)) {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        for (const file of msg.files) {
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: [file] });
        }
        sendResponse(true);
      } catch (e) {
        console.error("[BG] insertCss error:", e);
        sendResponse(false);
      }
    })();
    return true;
  }

  if (msg.query === "updateSettings") {
    if (typeof msg.cacheDuration === "number") cacheDuration = msg.cacheDuration;
    if (typeof msg.apiKey === "string") apiKey = msg.apiKey.trim();
    console.log("[BG] settings updated:", { cacheDuration, hasApiKey: !!apiKey });
  }
});
