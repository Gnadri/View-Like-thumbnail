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

// Minimal user settings. Keep showPercentage; bar settings removed.
const DEFAULT_USER_SETTINGS = {
  showPercentage: true,        // append like/view % to metadata line
  colorizePercent: true        // greenish when higher, muted when lower
};

let userSettings = DEFAULT_USER_SETTINGS;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Data fetch & shaping (LIKE/VIEW ONLY) ---

function getVideoDataObject(likes, views) {
  const rating = views > 0 ? likes / views : null; // 0..1, null if unknown
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

function ratingToPercentageString(rating) {
  // rating is 0..1. Display with two decimals; clamp 100% nicely.
  if (rating === 1) return "100%";
  return (
    (Math.floor(rating * 1000) / 10).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }) + "%"
  );
}

function getToolTipHtml(videoData) {
  // Optional helper if you later add a tooltip; safe to leave here.
  return (
    `${videoData.likes.toLocaleString()} likes / ` +
    `${videoData.views.toLocaleString()} views ` +
    `&nbsp;&nbsp; ${ratingToPercentageString(videoData.rating)}`
  );
}

function getRatingPercentageElement(videoData) {
  const span = document.createElement("span");
  span.role = "text";

  const textNode = document.createTextNode(
    ratingToPercentageString(videoData.rating ?? 0)
  );

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

// --- Metadata placement ---

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
  const videoData = await getVideoDataFromApi(videoId);

  if (!videoData) {
    // Mark unprocessed so we can try again on next pass
    thumbnailElement.removeAttribute(PROCESSED_DATA_ATTRIBUTE_NAME);
    return;
  }

  if (userSettings.showPercentage && videoData.rating != null) {
    addRatingPercentage(thumbnailElement, videoData);
  }
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
    const src = bg.slice(5, -2);                      // strip url(" .. ")
    processNewThumbnail(div, src);
  }
}

// --- Mutation observation & boot ---

function handleDomMutations() {
  if (domMutationsAreThrottled) {
    hasUnseenDomMutations = true;
    return;
  }

  domMutationsAreThrottled = true;

  if (userSettings.showPercentage) processNewThumbnails();

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

  // Inject minimal CSS for the metadata percentage (if your extension has it).
  if (userSettings.showPercentage) {
    chrome.runtime.sendMessage({
      query: "insertCss",
      files: ["css/text-percentage.css"]
    });
  }

  handleDomMutations();
  mutationObserver.observe(document.body, { childList: true, subtree: true });
});
