# TolWatch 2 — Node.js CCTV desk

Browse the [Bina Marga highway cameras](https://binamarga.pu.go.id/contents/cctv_tol), watch live video, save clips, schedule captures, and continuously archive selected cameras. Node 24 is the recommended runtime. No Python is needed to run this version.

## Local startup

Install Node.js **24**, FFmpeg and FFprobe, then:

```powershell
npm ci
npm start
```

Open **http://127.0.0.1:8765**. By default the server is local-only and does not require a password. For hosted access, configure `HOST=0.0.0.0` and `ADMIN_PASSWORD`.

## Pterodactyl (Node 24)

1. Select the Docker image **`ghcr.io/parkervcp/yolks:nodejs_24`**. Its current image definition includes FFmpeg and FFprobe; check your actual image if it has been customized.
2. Upload `package.json`, `package-lock.json`, `src/`, and `static/` to `/home/container`. Existing `recordings/` may also be uploaded. You do not need tests or local `node_modules`.
3. Install dependencies using `npm ci` in the egg's installation/startup setup.
4. Configure these environment variables in the egg/server startup settings:

| Variable | Value |
|---|---|
| `HOST` | `0.0.0.0` |
| `PORT` | Your allocated port; the app also accepts `SERVER_PORT` when `PORT` is unset |
| `ADMIN_PASSWORD` | A long, private admin password |
| `PUBLIC_URL` | Your browser-facing origin, e.g. `https://cctv.example.com` |
| `COOKIE_SECURE` | `true` for HTTPS; `false` for direct HTTP testing |
| `DATA_DIR` | `/home/container/data` |
| `RECORDINGS_DIR` | `/home/container/recordings` |
| `MAX_ACTIVE_RECORDINGS` | `2` initially; continuous archives each consume one slot |
| `MIN_FREE_MB` | `512`, or the free-space reserve you prefer |

5. Use startup command **`npm start`** after dependencies are installed. If your generic Node egg does not install dependencies, use `npm ci && npm start` as its startup command. Set the egg's startup-detection text to `TolWatch ready` and stop signal to SIGINT or SIGTERM.
6. Open the allocation address or your HTTPS domain and sign in.

The example configuration is in `.env.example`. Environment files are **not automatically loaded** by `npm start`; configure variables through Pterodactyl or run `node --env-file=.env src/server.js` after creating `.env` locally. Keep passwords out of source control.

The database and clips are under the server's persistent `/home/container` volume, not inside the container image. Back up **both** `data/` and `recordings/` while the app is stopped. Pterodactyl's disk quota and the underlying filesystem's free space are different: the app reports filesystem free space; monitor the panel quota too.

### HTTPS reverse proxy example

Point a domain at your reverse proxy and configure its TLS certificate. In the HTTPS server block:

```nginx
location / {
    proxy_pass http://127.0.0.1:8765; # Replace with your allocation address/port
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    proxy_buffering off;
}
```

Set `PUBLIC_URL` to the exact HTTPS origin and `COOKIE_SECURE=true`. Sessions expire after 12 hours and are invalidated on restart. The app uses a single administrator password.

## Recording and automation

Select a road and camera, then use **Start recording** for an immediate clip. Finished clips appear in the paginated library with download/delete controls. Filter by camera/road, mode, status, or date (Jakarta time).

To automate a camera, select it and create a task:

- **Scheduled clip:** choose a duration, five-field cron expression and timezone. Presets include hourly, every 15 minutes, and daily at 08:00. `0 * * * *` means the beginning of every hour. The default timezone is `Asia/Jakarta`.
- **Continuous archive:** choose the segment duration. A single FFmpeg process records continuously and rotates files at source keyframes. Segment lengths therefore may vary slightly. Completed segments become downloadable while recording continues.
- Tasks support pause/enable, run now, edit and delete. Pause a running task before editing it. Each task targets one camera; create multiple tasks for multiple cameras.
- Enabled continuous tasks resume after restart and retry failed feeds with backoff. Schedules, recording metadata and recent execution history persist in SQLite. Missed cron runs during downtime are skipped, since historical footage cannot be fetched. Busy-camera or capacity conflicts are logged; scheduled runs are skipped, continuous tasks retry.
- The browser can be closed. The Node server must remain running. Camera outages can create gaps; the history shows interruptions and retries.

**Automatic downloads are saved on the hosting server**, not into a browser's Downloads folder. Download them from the library to your computer.

### Source resolution and quality

Capture uses FFmpeg `-c:v copy`: no video re-encoding, scaling, or quality reduction. For HLS master playlists, the highest-resolution listed variant is selected, with bandwidth breaking ties. FFprobe measures the saved video's dimensions, codec and duration. A source resolution change is not upscaled or hidden.

Output is video-only MP4. Unsupported source codecs/container combinations produce an explicit capture error; the app never silently transcodes. Playback remains a separate HLS relay. Some feeds may work for recording but fail in a browser, or vice versa.

All clips are kept until explicitly deleted. The app never automatically deletes old footage. Continuous capture stops at the disk-space reserve and retries when storage is available. A manual clip checks space at startup and reports write errors if it fills storage mid-capture. Reserve enough storage for the configured concurrency.

Road listings are cached for five minutes and can be refreshed manually. Automated tasks refresh camera listings and check the camera name to avoid recording a different camera when publisher IDs move. Renamed/removed cameras may require recreating a task.

## Migration

**`npm start` runs the Node app.** The legacy Python implementation has been removed. Do not share the recording directory between running app instances.

On first startup, the Node app imports completed legacy JSON metadata whose MP4 still exists. Existing footage is not moved or overwritten. Node records and tasks are saved in `data/tolwatch.sqlite`. Interrupted single clips are recovered if FFprobe can read the finalized file; otherwise they are marked failed. Continuous manifests allow already closed segments to be recovered after a restart. An unfinished segment can be unreadable after a forced kill.

## Checks

```powershell
npm run check
npm test
```

Tests use fixture HTML and locally generated HLS video. They cover discovery, stream restrictions, cron timezone behavior, authentication, task management, download/delete, legacy migration, FFmpeg stream-copy dimensions/codec, continuous segments, scheduled execution and interrupted-job recovery. FFmpeg and FFprobe are required for integration tests.

The desktop/mobile UI and automation were also verified with a browser smoke check during development.

This tool is independent of Bina Marga and the road operators. A listed camera is not a guarantee that its stream is currently available. Only live footage is exposed by the source.
