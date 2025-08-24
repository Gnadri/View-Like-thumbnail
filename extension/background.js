// All API requests are made through this background script to avoid CORB
// errors and to cache results. Now we fetch {likes, views} from YouTube Data API.

let cache = {};
let cacheTimes = [];
let cacheDuration = 600000; // 10 minutes default
let getStatsCallbacks = {}; // coalesce concurrent requests per videoId

// Put your API key here, or save it into chrome.storage.sync as "ytApiKey".
let API_KEY = "<PUT_YOUR_YOUTUBE_DATA_API_KEY_HERE>";

function removeExpiredCacheData() {
  const now = Date.now();
  let numRemoved = 0;

  for (const [fetchTime, videoId] of cacheTimes) {
    if (now - fetchTime > cacheDuration) {
      delete cache[videoId];
      numRemoved++;
    } else {
      break;
    }
  }
  if (numRemoved > 0) cacheTimes = cacheTimes.slice(numRemoved);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({ cacheDuration: 600000, ytApiKey: null }, (settings) => {
    if (settings && settings.cacheDuration !== undefined) cacheDuration = settings.cacheDuration;
    if (settings && settings.ytApiKey) API_KEY = settings.ytApiKey;
  });
});

async function fetchStatsFromApi(videoId) {
  if (!API_KEY || API_KEY.includes("<PUT_")) {
    // No key configured -> fail gracefully
    return null;
  }
  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}&key=${API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  const item = data.items && data.items[0];
  if (!item || !item.statistics) return null;

  const likes = Number(item.statistics.likeCount || 0);
  const views = Number(item.statistics.viewCount || 0);
  return { likes, views };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.query) {
    case "getStats": {
      removeExpiredCacheData();

      // Return cached if present
      if (message.videoId in cache) {
        sendResponse(cache[message.videoId]);
        return true; // async path compatible
      }

      // Coalesce concurrent lookups
      if (message.videoId in getStatsCallbacks) {
        getStatsCallbacks[message.videoId].push(sendResponse);
      } else {
        getStatsCallbacks[message.videoId] = [sendResponse];

        (async () => {
          let data = null;
          try {
            data = await fetchStatsFromApi(message.videoId);
            if (data !== null) {
              cache[message.videoId] = data;
              cacheTimes.push([Date.now(), message.videoId]);
            }
          } catch (_e) {
            data = null;
          }

          for (const cb of getStatsCallbacks[message.videoId]) cb(data);
          delete getStatsCallbacks[message.videoId];
        })();
      }

      return true; // we'll respond async
    }

    // Back-compat: if something still sends "getLikesData", answer with stats too.
    case "getLikesData": {
      message.query = "getStats";
      chrome.runtime.sendMessage(message, sendResponse);
      return true;
    }

    case "insertCss": {
      // Requires "scripting" permission in manifest
      if (sender.tab && sender.tab.id) {
        (async () => {
          for (const file of message.files || []) {
            await chrome.scripting.insertCSS({
              target: { tabId: sender.tab.id },
              files: [file],
            });
          }
          sendResponse(true);
        })();
        return true;
      }
      sendResponse(false);
      break;
    }

    case "updateSettings": {
      if (typeof message.cacheDuration === "number") cacheDuration = message.cacheDuration;
      if (typeof message.apiKey === "string") {
        API_KEY = message.apiKey;
        chrome.storage.sync.set({ ytApiKey: API_KEY });
      }
      sendResponse(true);
      break;
    }

    default:
      sendResponse(null);
  }
});
