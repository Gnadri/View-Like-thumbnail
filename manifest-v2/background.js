// === background.js ===
// Minimal service worker fetching {likes, views} for a videoId via YouTube Data API v3.

const API_KEY = "<PUT_YOUR_YOUTUBE_DATA_API_KEY_HERE>"; // get from Google Cloud Console
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const cache = new Map(); // { videoId: { t: timestamp, likes, views } }

async function fetchStats(videoId) {
  const now = Date.now();
  const cached = cache.get(videoId);
  if (cached && now - cached.t < CACHE_TTL_MS) {
    return { likes: cached.likes, views: cached.views };
  }

  const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(
    videoId
  )}&key=${API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
  const data = await res.json();

  const item = data.items && data.items[0];
  if (!item || !item.statistics) throw new Error("No statistics found");

  const likes = Number(item.statistics.likeCount || 0);
  const views = Number(item.statistics.viewCount || 0);

  cache.set(videoId, { t: now, likes, views });
  return { likes, views };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.query === "insertCss" && Array.isArray(msg.files)) {
        // Inject CSS into the active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        for (const file of msg.files) {
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: [file] });
        }
        sendResponse(true);
      } else if (msg.query === "getStats" && msg.videoId) {
        const stats = await fetchStats(msg.videoId);
        sendResponse(stats);
      } else {
        sendResponse(null);
      }
    } catch (_e) {
      sendResponse(null);
    }
  })();
  return true; // keep the message channel open for async sendResponse
});
