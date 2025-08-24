// === Options for Like/View % overlay ===

const DEFAULT_USER_SETTINGS = {
  showPercentage: true,
  colorizePercent: true,
  decimals: 2,          // 0..3
  cacheDuration: 600000, // 10 minutes
  apiKey: ""            // YouTube Data API key
};

// Helpers
function pctString(r, decimals) {
  const v = Math.max(0, Math.min(100, (r ?? 0) * 100));
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }) + "%";
}

function updatePreviewFromForm() {
  const show = $("#show-percentage").prop("checked");
  const colorize = $("#colorize-percent").prop("checked");
  const decimals = Math.min(3, Math.max(0, Number($("#decimals").val() || 0)));

  // Sample numbers from your earlier example
  const likes = 100;
  const views = 13050;
  const rating = views > 0 ? likes / views : 0;

  const $meta = $("#preview-metadata");
  const $chip = $("#preview-percent");

  $meta.find(".yt-core-attributed-string").text(
    `${likes.toLocaleString()} likes / ${views.toLocaleString()} views`
  );

  if (!show) {
    $chip.hide();
    return;
  }

  $chip.show().text(pctString(rating, decimals));

  // Colorization similar to content script
  if (colorize) {
    const r = Math.round((1 - Math.min(rating, 1)) * 1275);
    let g = Math.min(rating, 1) * 637.5 - 255;
    const color = `rgb(${r},${Math.round(g)},0)`;
    $chip.css("color", color);
  } else {
    $chip.css("color", "");
  }
}

// Wire field changes to preview
$("#show-percentage, #colorize-percent").on("change", updatePreviewFromForm);
$("#decimals").on("input change", updatePreviewFromForm);

// Save settings
$("#save-btn").click(function () {
  const cacheDuration = parseInt($('[name="cache-duration"]').val() || "600000", 10);

  const settings = {
    showPercentage: $("#show-percentage").prop("checked"),
    colorizePercent: $("#colorize-percent").prop("checked"),
    decimals: Math.min(3, Math.max(0, Number($("#decimals").val() || 0))),
    cacheDuration,
    apiKey: ($("#api-key").val() || "").trim()
  };

  chrome.storage.sync.set(settings, function () {
    document.querySelector("#toast").MaterialSnackbar.showSnackbar({
      message: "Settings saved. Refresh YouTube.",
      timeout: 2000
    });
  });

  // Tell background to apply runtime values immediately
  chrome.runtime.sendMessage({
    query: "updateSettings",
    cacheDuration,
    apiKey: settings.apiKey
  });
});

// Restore defaults button
$("#restore-defaults-btn").click(function () {
  applySettings(DEFAULT_USER_SETTINGS);
});

// Apply settings to the form and preview
function applySettings(s) {
  $("#show-percentage").prop("checked", !!s.showPercentage);
  $("#colorize-percent").prop("checked", !!s.colorizePercent);

  $("#decimals").val(Number.isFinite(s.decimals) ? s.decimals : 2);
  if ($("#decimals").val()) {
    $("#decimals").parent().addClass("is-dirty");
  }

  $("#api-key").val(s.apiKey || "");
  if (s.apiKey) $("#api-key").parent().addClass("is-dirty");

  // Set cache duration dropdown
  const id = `#cache-duration-${(s.cacheDuration ?? 600000).toString()}`;
  if ($(id).length) $(id).click();

  updatePreviewFromForm();
}

// Load saved settings
function restoreOptions() {
  chrome.storage.sync.get(DEFAULT_USER_SETTINGS, function (settings) {
    if (!settings) settings = DEFAULT_USER_SETTINGS;

    // Backfill any new keys that might be missing
    for (const [k, v] of Object.entries(DEFAULT_USER_SETTINGS)) {
      if (!(k in settings)) settings[k] = v;
    }

    applySettings(settings);
  });
}

document.addEventListener("DOMContentLoaded", function () {
  restoreOptions();
  // Re-run after MDL upgrades components
  setTimeout(restoreOptions, 200);
});
