// === Like/View Thumbnail Percentage (content-script.js) ===

// Throttle DOM scans
const HANDLE_DOM_MUTATIONS_THROTTLE_MS = 300;
let domMutationsAreThrottled = false;
let hasUnseenDomMutations = false;

// Markers & cooldown
const PROCESSED_ATTR = "data-ytrb-processed";
const NEXT_TRY_ATTR = "data-ytrb-next-try";
const FAIL_RETRY_MS = 5 * 60 * 1000;   // try again in 5 min when API fails

// Site context
const IS_MOBILE_SITE = location.href.startsWith("https://m.youtube.com");
const IS_YOUTUBE_KIDS_SITE = location.href.startsWith("https://www.youtubekids.com");

// Theme (for colorized % chip)
const IS_DARK =
  getComputedStyle(document.body).getPropertyValue("--yt-spec-general-background-a") === " #181818";

// Minimal user settings
const DEFAULT_USER_SETTINGS = { showPercentage: true, colorizePercent: true, decimals: 2 };
let userSettings = { ...DEFAULT_USER_SETTINGS };

// --- helpers ---
function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatPercent(rating, decimals) {
  if (rating === 1) return "100%";
  const d = Math.max(0, Math.min(3, Number(decimals ?? 2)));
  const mult = 10 ** d;
  const pct = Math.floor((rating ?? 0) * 100 * mult) / mult;
  return pct.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
}
function emojiForRatio(r) {
  const pct = (r ?? 0) * 100;
  if (pct >= 12) return "💎";
  if (pct >= 8)  return "😎";
  if (pct >= 3)  return "😐";
  if (pct >= 1)  return "🗑️";
  return "💩";
}

// --- badge UI (tiny overlay) ---
function thumbHost(el) {
  return el.closest("ytd-thumbnail") || el.closest("ytd-rich-grid-media") || el.parentElement;
}
function ensureBadge(host) {
  if (!host) return null;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
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
function setBadge(el, txt, state="ok") {
  const badge = ensureBadge(thumbHost(el));
  if (!badge) return;
  badge.textContent = txt;
  if (state === "loading") { badge.style.background = "rgba(255,193,7,0.9)"; badge.style.color="#000"; }
  else if (state === "err") { badge.style.background = "rgba(183,28,28,0.9)"; badge.style.color="#fff"; }
  else { badge.style.background = "rgba(0,0,0,0.8)"; badge.style.color="#fff"; }
}

// Percentage chip inside metadata line (optional)
function getRatingPercentageElement(rating) {
  const span = document.createElement("span");
  span.role = "text";
  const txt = `${formatPercent(rating, userSettings.decimals)} ${emojiForRatio(rating)}`;
  const node = document.createTextNode(txt);

  if (!userSettings.colorizePercent || !Number.isFinite(rating)) {
    span.appendChild(node);
    return span;
  }
  const inner = document.createElement("span");
  const r = Math.round((1 - Math.min(rating, 1)) * 1275);
  let g = Math.min(rating, 1) * 637.5 - 255;
  if (!IS_DARK) g = Math.min(g, 255) * 0.85;
  inner.style.setProperty("color", `rgb(${r},${Math.round(g)},0)`, "important");
  inner.appendChild(node);
  span.appendChild(inner);
  return span;
}
function removeOldPercentages(el) {
  el.querySelectorAll(".ytrb-percentage").forEach(n => n.remove());
}
const METADATA_LINE_DATA_DESKTOP = [
  ["ytd-rich-grid-media", "#metadata-line", "style-scope ytd-video-meta-block ytd-grid-video-renderer"],
  ["ytd-video-renderer", "#metadata-line", "inline-metadata-item style-scope ytd-video-meta-block"],
  ["ytm-shorts-lockup-view-model", ".shortsLockupViewModelHostMetadataSubhead", "yt-core-attributed-string yt-core-attributed-string--white-space-pre-wrap"],
  [".yt-lockup-view-model-wiz", ".yt-content-metadata-view-model-wiz__metadata-row:last-child", "yt-core-attributed-string yt-content-metadata-view-model-wiz__metadata-text yt-core-attributed-string--white-space-pre-wrap yt-core-attributed-string--link-inherit-color"],
  ["div.ytd-playlist-video-renderer", "#metadata-line", "style-scope ytd-video-meta-block"],
  ["ytd-grid-movie-renderer", ".grid-movie-renderer-metadata", ""],
  ["ytd-grid-movie-renderer", "#byline-container", "style-scope ytd-video-meta-block"],
  ["div.ytd-grid-video-renderer", "#metadata-line", "style-scope ytd-grid-video-renderer"],
  ["ytd-promoted-video-renderer", "#metadata-line", "style-scope ytd-video-meta-block"],
  [".ytd-video-display-full-buttoned-and-button-group-renderer", "#byline-container", "style-scope ytd-ad-inline-playback-meta-block yt-simple-endpoint"],
  ["ytmusic-two-row-item-renderer", "yt-formatted-string.subtitle", "style-scope yt-formatted-string"]
];
const METADATA_LINE_DATA_MOBILE = [
  ["ytm-media-item", "ytm-badge-and-byline-renderer", "ytm-badge-and-byline-item-byline small-text"],
  [".shortsLockupViewModelHostEndpoint", ".shortsLockupViewModelHostMetadataSubhead", "yt-core-attributed-string yt-core-attributed-string--white-space-pre-wrap"],
  ["ytm-video-card-renderer", ".subhead .small-text:last-child", "yt-core-attributed-string"],
  [".compact-media-item", ".subhead", "compact-media-item-stats small-text"]
];
function addRatingPercentage(el, rating) {
  if (!userSettings.showPercentage) return;
  const configs = IS_MOBILE_SITE ? METADATA_LINE_DATA_MOBILE : METADATA_LINE_DATA_DESKTOP;
  for (const [containerSel, lineSel, classes] of configs) {
    const container = el.closest(containerSel);
    if (!container) continue;
    const line = container.querySelector(lineSel);
    if (!line) continue;
    removeOldPercentages(line);
    const chip = getRatingPercentageElement(rating);
    chip.className = `${classes} ytrb-percentage`;
    line.appendChild(chip);
    return;
  }
}

// --- single-shot fetch per video id (dedupe in-flight) ---
const inflight = new Map(); // videoId -> Promise<stats|null>
function getStatsOnce(videoId) {
  if (inflight.has(videoId)) return inflight.get(videoId);
  const p = chrome.runtime.sendMessage({ query: "getStats", videoId })
    .catch(() => null)
    .finally(() => inflight.delete(videoId));
  inflight.set(videoId, p);
  return p;
}

// --- per-thumbnail processing ---
async function processThumb(el, url) {
  // skip chapter thumbs (hqdefault_*.jpg but not hqdefault_custom_*.jpg)
  const parts = url.split("/");
  const file = parts[5];
  if (file && file.startsWith("hqdefault_") && !file.startsWith("hqdefault_custom_")) return;

  const videoId = parts[4];
  if (!videoId) return;

  // respect cooldown marker
  const nextTry = Number(el.getAttribute(NEXT_TRY_ATTR) || "0");
  if (nextTry && now() < nextTry) return;

  // mark processed once; we won't remove it on failure anymore
  el.setAttribute(PROCESSED_ATTR, "");

  // show loading once
  setBadge(el, "…", "loading");

  const stats = await getStatsOnce(videoId);
  if (!stats || !Number.isFinite(stats.likes) || !Number.isFinite(stats.views)) {
    // failure: mark cooldown so we don't retry every scan
    el.setAttribute(NEXT_TRY_ATTR, String(now() + FAIL_RETRY_MS));
    setBadge(el, "!", "err");
    return;
  }

  const rating = stats.views > 0 ? stats.likes / stats.views : 0;
  setBadge(el, `${formatPercent(rating, userSettings.decimals)} ${emojiForRatio(rating)}`, "ok");
  addRatingPercentage(el, rating);
}

function scan() {
  // <img> thumbnails
  document.querySelectorAll(
    'img[src*=".ytimg.com/"]:not([data-ytrb-processed]):not(.ytCinematicContainerViewModelBackgroundImage)'
  ).forEach(img => {
    img.setAttribute(PROCESSED_ATTR, "");
    processThumb(img, img.getAttribute("src") || "");
  });

  // videowall stills
  document.querySelectorAll(".ytp-videowall-still-image:not([data-ytrb-processed])").forEach(div => {
    div.setAttribute(PROCESSED_ATTR, "");
    const bg = div.style.backgroundImage; // url("https://i.ytimg.com/vi/<id>/...")
    const src = bg && bg.startsWith('url("') ? bg.slice(5, -2) : "";
    if (src) processThumb(div, src);
  });
}

function handleMutations() {
  if (domMutationsAreThrottled) { hasUnseenDomMutations = true; return; }
  domMutationsAreThrottled = true;
  scan();
  hasUnseenDomMutations = false;
  setTimeout(() => {
    domMutationsAreThrottled = false;
    if (hasUnseenDomMutations) handleMutations();
  }, HANDLE_DOM_MUTATIONS_THROTTLE_MS);
}

const mo = new MutationObserver(handleMutations);

chrome.storage.sync.get(DEFAULT_USER_SETTINGS, (stored) => {
  if (stored) userSettings = { ...DEFAULT_USER_SETTINGS, ...stored };
  if (IS_YOUTUBE_KIDS_SITE) userSettings.showPercentage = false;

  if (userSettings.showPercentage) {
    chrome.runtime.sendMessage({ query: "insertCss", files: ["css/text-percentage.css"] });
  }

  handleMutations();
  mo.observe(document.body, { childList: true, subtree: true });

  // Periodic light rescan to honor NEXT_TRY_ATTR timestamps without spamming
  setInterval(() => scan(), 30_000);
});
