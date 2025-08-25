<div align="center"> <img src="extension/icons/icon128.png" width="128" />
Like/View % on YouTube™ Thumbnails
</div>

Tiny extension that shows a Like ÷ View percentage on each YouTube thumbnail so you can spot videos that punch above their views and dodge fluff.

What it shows

A small badge on the top-left of thumbnails with the percent, e.g. 0.82%.

(Optional) an emoji by quality:

💩 very low • 🗑️ low • 😐 mid • 😎 good • 💎 13%+

Formula: percentage = (likes / views) × 100 (defaults to 2 decimals)

Quick install (unpacked)

Download/clone this repo.

Chrome/Edge: chrome://extensions → Developer mode → Load unpacked → select the extension/ folder.
Firefox (Nightly/Kiwi/etc.): load as a temporary add-on.

Open the extension Options page and paste your YouTube Data API v3 key.

Optional: choose decimals, colorize %, cache duration.

Refresh YouTube.

Settings

Show percentage (on/off)

Colorize percent (subtle green for higher ratios)

Decimals (0–3)

Cache duration (reduces API calls)

YouTube API key (used to fetch likes & views)

Notes

Uses YouTube Data API v3 (videos.list?part=statistics) to fetch likes and views.

Results are cached to reduce requests; heavy scrolling may still hit rate/quotas.

Permissions: storage, *.youtube.com, www.googleapis.com.

We use this information to try to estimate the value of the content before
exploring it further. A useful indicator of the value of the content is how
valuable other viewers found it. The view count has some correlation with the
value of the content, but on its own is unreliable. By being able to also see
the video’s like ratio, users can much more accurately estimate the value
of the content, resulting in finding higher quality content, saving time, and
avoiding being clickbaited.

## License

[MIT](LICENSE)
