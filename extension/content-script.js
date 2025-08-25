// === Like/View Thumbnail Percentage (content-script.js) ===

// Throttle DOM scans so we don't burn CPU
const HANDLE_DOM_MUTATIONS_THROTTLE_MS = 100;
let domMutationsAreThrottled = false;
let hasUnseenDomMutations = false;

// Retry policy for API lookups coming from background.js
const MAX_API_RETRIES_PER_THUMBNAIL = 10;
const API_RETRY_DELAY_MIN_MS = 3000;
const API_RETRY_UNIFORM_DISTRIBUTION_WIDTH_MS = 3000;

// Used to mark thumbnails we've already processed
const PROCESSED_DATA_ATTRIBUTE_NAME = "data-ytrb-processed";

// Site context
const IS_MOBILE_SITE = window.location.href.startsWith("https://m.youtube.com");
const IS_YOUTUBE_KIDS_SITE = window.location.href.startsWith("https://www.youtubekids.com");

// Theme check (used only for optional text color blend)
const IS_USING_DARK_THEME =
  getComputedStyle(document.body).getPropertyValue("--yt-spec-general-background-a") === " #181818";

// User settings (kept minimal for this overlay)
const DEFAULT_USER_SETTINGS = {
  showPercentage: true,     // append like/view % to metadata line
  colorizePercent: true,    // greenish when higher, muted when lower
  decimals: 2               // 0..3
};

let userSettings = { ...DEFAULT_USER_SETTINGS };

// --- tiny debug logger ---
const DEBUG = false;
function dlog(...a) { if (DEBUG) console.log("[LV]", ...a); }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Data fetch & shaping (LIKE/VIEW ONLY) ---

function getVideoDataObject(likes, views) {
  const rating = views > 0 ? likes / views : 0; // 0..1 (treat 0 views as 0%)
  return { likes, views, rating };
}

async function getVideoDataFromApi(videoId) {
  for (let i = 0; i <= MAX_API_RETRIES_PER_THUMBNAIL; i++) {
    // Background should call YouTube Data API v3 videos.list?part=statistics
    // and return { likes, views } for this videoId.
    const stats = await chrome.runtime.sendMessage({
      query: "getStats",
      videoId
    });

    if (stats && Number.isFinite(stats.likes) && Number.isFinite(stats.views)) {
      return getVideoDataObject(stats.likes, stats.views);
    }

    // Backoff a bit and retry
    await sleep(
      API_RETRY_DELAY_MIN_MS +
      Math.random() * API_RETRY_UNIFORM_DISTRIBUTION_WIDTH_MS
    );
  }
  return null;
}

// --- Formatting ---

function formatPercent(rating, decimals) {
  if (rating === 1) return "100%";
  const d = Math.max(0, Math.min(3, Number(decimals ?? 2)));
  const mult = Math.pow(10, d);
  const pct = Math.floor((rating ?? 0) * 100 * mult) / mult; // floor to avoid 99.999 -> 100.00%
  return pct.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d
  }) + "%";
}

// Emoji thresholds (percent):
// 💎  >= 13
// 😎  8–12.99
// 😐  3–7.99
// 🗑️  1–2.99
// 💩  < 1
function emojiForRatio(rating) {
  const pct = (rating ?? 0) * 100;
  if (pct >= 13) return "💎";
  if (pct >= 8)  return "😎";
  if (pct >= 3)  return "😐";
  if (pct >= 1)  return "🗑️";
  return "💩";
}

// --- SIMPLE BADGE OVERLAY (top-left) ---

function getThumbHost(el) {
  return (
    el.closest("ytd-thumbnail") ||
    el.closest("ytd-rich-grid-media") ||
    el.parentElement
  );
}

function getOrCreateBadge(host) {
  if (!host) return null;

  // Ensure we can absolutely-position inside
  const pos = getComputedStyle(host).position;
  if (pos === "static") host.style.position = "relative";

  let badge = host.querySelector(".lv-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "lv-badge";
    Object.assign(badge.style, {
      position: "absolute",
      left: "4px",
      top: "4px",
      padding: "2px 6px",
      borderRadius: "4px",
      fontSize: "11px",
      fontWeight: "700",
      background: "rgba(0,0,0,0.80)",
      color: "#fff",
      zIndex: "1000",
      pointerEvents: "none",
      lineHeight: "1.3",
      textShadow: "0 1px 1px rgba(0,0,0,0.4)"
    });
    host.appendChild(badge);
  }
  return badge;
}

/**
 * state: "loading" | "ok" | "err"
 */
function setBadge(el, text, state = "ok") {
  const host = getThumbHost(el);
  const badge = getOrCreateBadge(host);
  if (!badge) return;

  badge.textContent = text;
  badge.removeAttribute("title"); // no hover details anymore

  // Subtle background hue by state
  if (state === "loading") {
    badge.style.background = "rgba(255, 193, 7, 0.90)";   // amber
    badge.style.color = "#000";
  } else if (state === "err") {
    badge.style.background = "rgba(183, 28, 28, 0.90)";   // deep red
    badge.style.color = "#fff";
  } else {
    badge.style.background = "rgba(0,0,0,0.80)";          // normal
    badge.style.color = "#fff";
  }
}

// --- Metadata percentage chip (optional) ---

function getRatingPercentageElement(videoData) {
  const span = document.createElement("span");
  span.role = "text";

  const txt = `${formatPercent(videoData.rating, userSettings.decimals)} ${emojiForRatio(videoData.rating)}`;
  const textNode = document.createTextNode(txt);

  if (!userSettings.colorizePercent || !Number.isFinite(videoData.rating)) {
    span.appendChild(textNode);
    return span;
  }

  // Simple greenish gradient based on like/view ratio (0..1)
  // Note: like/view is often < 0.05, so colorization will be subtle.
  const inner = document.createElement("span");
  const r = Math.round((1 - Math.min(videoData.rating, 1)) * 1275);
  let g = Math.min(videoData.rating, 1) * 637.5 - 255;
  if (!IS_USING_DARK_THEME) g = Math.min(g, 255) * 0.85;
  const color = `rgb(${r},${Math.round(g)},0)`;
  inner.style.setProperty("color", color, "important");
  inner.appendChild(textNode);
  span.appendChild(inner);

  return span;
}

function removeOldPercentages(element) {
  element.querySelectorAll(".ytrb-percentage").forEach((n) => n.remove());
}

// Each item: [closest container selector, metadata line selector, classes to apply]
const METADATA_LINE_DATA_DESKTOP = [
  ["ytd-rich-grid-media", "#metadata-line", "style-scope ytd-video-meta-block ytd-grid-video-renderer"],              // Home
  ["ytd-video-renderer", "#metadata-line", "inline-metadata-item style-scope ytd-video-meta-block"],                  // Search
  ["ytm-shorts-lockup-view-model", ".shortsLockupViewModelHostMetadataSubhead", "yt-core-attributed-string yt-core-attributed-string--white-space-pre-wrap"], // Shorts carousel
  [".yt-lockup-view-model-wiz", ".yt-content-metadata-view-model-wiz__metadata-row:last-child", "yt-core-attributed-string yt-content-metadata-view-model-wiz__metadata-text yt-core-attributed-string--white-space-pre-wrap yt-core-attributed-string--link-inherit-color"], // Subs
  ["div.ytd-playlist-video-renderer", "#metadata-line", "style-scope ytd-video-meta-block"],                          // Playlist small thumbs
  ["ytd-grid-movie-renderer", ".grid-movie-renderer-metadata", ""],                                                   // Movies
  ["ytd-grid-movie-renderer", "#byline-container", "style-scope ytd-video-meta-block"],                               // Courses playlist
  ["div.ytd-grid-video-renderer", "#metadata-line", "style-scope ytd-grid-video-renderer"],                           // Clips
  ["ytd-promoted-video-renderer", "#metadata-line", "style-scope ytd-video-meta-block"],                              // Sponsored v1
  [".ytd-video-display-full-buttoned-and-button-group-renderer", "#byline-container", "style-scope ytd-ad-inline-playback-meta-block yt-simple-endpoint"], // Sponsored v2
  ["ytmusic-two-row-item-renderer", "yt-formatted-string.subtitle", "style-scope yt-formatted-string"]                // music.youtube.com
];

const METADATA_LINE_DATA_MOBILE = [
  ["ytm-media-item", "ytm-badge-and-byline-renderer", "ytm-badge-and-byline-item-byline small-text"],                 // Home
  [".shortsLockupViewModelHostEndpoint", ".shortsLockupViewModelHostMetadataSubhead", "yt-core-attributed-string yt-core-attributed-string--white-space-pre-wrap"], // Shorts
  ["ytm-video-card-renderer", ".subhead .small-text:last-child", "yt-core-attributed-string"],                        // History carousel
  [".compact-media-item", ".subhead", "compact-media-item-stats small-text"]                                          // Profile videos
];

function addRatingPercentage(thumbnailElement, videoData) {
  if (!userSettings.showPercentage) return;

  const configs = IS_MOBILE_SITE ? METADATA_LINE_DATA_MOBILE : METADATA_LINE_DATA_DESKTOP;

  for (const [containerSelector, metadataLineSelector, metadataLineItemClasses] of configs) {
    const container = thumbnailElement.closest(containerSelector);
    if (!container) continue;

    const metadataLine = container.querySelector(metadataLineSelector);
    if (!metadataLine) continue;

    removeOldPercentages(metadataLine);

    const el = getRatingPercentageElement(videoData);
    el.className = `${metadataLineItemClasses} ytrb-percentage`;
    metadataLine.appendChild(el);
    return;
  }
}

// --- Thumbnail scanning ---

async function processNewThumbnail(thumbnailElement, thumbnailUrl) {
  const parts = thumbnailUrl.split("/");

  // Skip chapter thumbs: hqdefault_*.jpg but not hqdefault_custom_*.jpg
  const filenameAndParams = parts[5];
  if (filenameAndParams &&
      filenameAndParams.startsWith("hqdefault_") &&
      !filenameAndParams.startsWith("hqdefault_custom_")) {
    return;
  }

  const videoId = parts[4];
  if (!videoId) return;

  // Show a tiny "loading" badge immediately so we can see we're running
  setBadge(thumbnailElement, "…", "loading");

  const videoData = await getVideoDataFromApi(videoId);

  if (!videoData) {
    // Keep a red badge so failures are obvious
    setBadge(thumbnailElement, "err", "err");
    // Mark unprocessed so we can try again on next pass
    thumbnailElement.removeAttribute(PROCESSED_DATA_ATTRIBUTE_NAME);
    return;
  }

  // Compute percentage + emoji and display only that
  const pct = formatPercent(videoData.rating, userSettings.decimals);
  const emoji = emojiForRatio(videoData.rating);
  setBadge(thumbnailElement, `${pct} ${emoji}`, "ok");

  // Also add the metadata-line percentage chip if enabled
  addRatingPercentage(thumbnailElement, videoData);
}

function processNewThumbnails() {
  // Standard <img> thumbnails (desktop + many surfaces)
  const unprocessedImgs = document.querySelectorAll(
    'img[src*=".ytimg.com/"]:not([data-ytrb-processed]):not(.ytCinematicContainerViewModelBackgroundImage)'
  );
  for (const img of unprocessedImgs) {
    img.setAttribute(PROCESSED_DATA_ATTRIBUTE_NAME, "");
    processNewThumbnail(img, img.getAttribute("src"));
  }

  // Video wall stills with background-image (end screens, etc.)
  const unprocessedDivs = document.querySelectorAll(
    ".ytp-videowall-still-image:not([data-ytrb-processed])"
  );
  for (const div of unprocessedDivs) {
    div.setAttribute(PROCESSED_DATA_ATTRIBUTE_NAME, "");
    const bg = div.style.backgroundImage;             // url("https://i.ytimg.com/vi/<id>/...")
    const src = bg && bg.startsWith('url("') ? bg.slice(5, -2) : "";
    if (src) processNewThumbnail(div, src);
  }
}

// --- Mutation observation & boot ---

function handleDomMutations() {
  if (domMutationsAreThrottled) {
    hasUnseenDomMutations = true;
    return;
  }

  domMutationsAreThrottled = true;

  processNewThumbnails();

  hasUnseenDomMutations = false;

  setTimeout(() => {
    domMutationsAreThrottled = false;
    if (hasUnseenDomMutations) handleDomMutations();
  }, HANDLE_DOM_MUTATIONS_THROTTLE_MS);
}

const mutationObserver = new MutationObserver(handleDomMutations);

chrome.storage.sync.get(DEFAULT_USER_SETTINGS, (stored) => {
  if (stored) userSettings = { ...DEFAULT_USER_SETTINGS, ...stored };

  if (IS_YOUTUBE_KIDS_SITE) userSettings.showPercentage = false;

  // Inject minimal CSS for the metadata percentage chip (optional).
  if (userSettings.showPercentage) {
    chrome.runtime.sendMessage({
      query: "insertCss",
      files: ["css/text-percentage.css"]
    });
  }

  handleDomMutations();
  mutationObserver.observe(document.body, { childList: true, subtree: true });
});
