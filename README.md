# Subsyncarr++

A drop-in replacement for [Subsyncarr Plus](https://github.com/tomtomwillis/subsyncarr_plus) (itself a fork of [subsyncarr](https://github.com/johnpc/subsyncarr)) that adds a fourth engine, **claudesynchro**, which synchronises subtitles **by what is said, not only by when somebody speaks**.

It was built for Polish subtitles, where the subtitle text has to stay (English does not tell you whether a speaker is male or female, Polish does), but it works for any language pair.

- Same container layout as Subsyncarr Plus: same env vars, port `3000`, `/app/data` volume and database. Switching is a change of image name.
- ffsubsync, autosubsync and alass still run as before; claudesynchro writes its own `*.claudesynchro.srt` next to them.

## What claudesynchro does differently

ffsubsync, autosubsync and alass align **timing patterns**: where speech is in the audio (or where lines are in a reference file) versus where subtitle lines are. They never look at the text, so they cannot tell that a block of subtitles belongs to a scene that is not in your cut, and they always write a result, right or wrong.

claudesynchro compares every subtitle line with a **reference that is known to match your video**, by meaning, across languages ("Gdzie jest Anna?" ≈ "Where is Anna?"):

1. **Reference**, best first: an English (or other) text track embedded in the video → external subtitles next to the video (checked against the audio first) → a Whisper transcript of the audio (local, cached).
2. **Matching**: a small multilingual sentence-embedding model scores every pair of lines; names and numbers count extra; generic lines ("Yes.", "Sorry.") count little.
3. **Timeline**: the best chain of matches is split wherever the time offset jumps. Each jump is a cut, an ad break or an extended scene; frame-rate differences (23.976 / 24 / 25 / 29.97) are detected.
4. **Cuts are resolved line by line**:
   - **subtitles longer than the video** (subtitles for an extended cut, TV edit with trimmed scenes) → the lines of the missing scenes are **dropped**;
   - **video longer than the subtitles** (extended edition, commercial breaks) → the extra scenes are **left empty, filled with the English lines, or translated** by an LLM using the surrounding Polish lines for grammatical gender and names.
5. **Confidence**: every result gets a score and a report (cuts, dropped and filled lines). Below `CLAUDESYNCHRO_MIN_CONFIDENCE` nothing is written, so a wrong subtitle file (another episode, another film) does not produce a broken `.srt`.

Your original subtitle text is never changed; only timing is, plus optional filled-in lines.

### How it compares

Synthetic benchmark (real English/Polish sentence pairs from Tatoeba, ~1,100-line "films", ground truth known; alass given the reference as a subtitle file), share of lines placed within 0.5 s:

| Scenario                                                    | alass                      | claudesynchro                           |
| ----------------------------------------------------------- | -------------------------- | --------------------------------------- |
| Offset, frame rate 25↔23.976, silent ad breaks             | 100 %                      | 100 %                                   |
| Video extended (+3 scenes)                                  | 99.9–100 %                 | 100 %, extra scenes filled with English |
| Subtitles extended (+3 scenes)                              | 41–60 % (no lines dropped) | 100 %, 100 % of extra lines dropped     |
| TV edit with 2–4 lines trimmed from scenes                  | 87–97 %                    | 99.9–100 %                              |
| Noisy transcript reference, subtitles extended + frame rate | 36–78 %                    | 99.7–100 %                              |
| Subtitles for a different film                              | writes garbage             | refuses (no output)                     |

Real audio ([Tears of Steel](https://mango.blender.org), CC-BY, with its Polish community subtitles), "TV version" with a scene cut out, a 90 s ad break and PAL speed-up (24→25 fps), and "extended" version vs. shortened subtitles:

| Scenario                                              | alass (audio, as used by Subsyncarr) | claudesynchro                                          |
| ----------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| TV version, embedded English track                    | 0 / 67 lines within 0.5 s            | **67 / 67**, 9 / 9 lines of the cut scene dropped      |
| TV version, no English subtitles (Whisper `base`)     | 0 / 67                               | **63 / 67**, 7 / 9 dropped                             |
| Extended video, embedded English track                | 0 / 67                               | **67 / 67**, missing scene filled with 9 English lines |
| Extended video, no English subtitles (Whisper `base`) | 0 / 67                               | **64 / 67** (rest within 0.6 s)                        |

Tears of Steel is short and music-heavy, which is hard for audio-pattern engines; on dialogue-heavy films without cuts alass usually does well. Where claudesynchro gains most is cuts, extended editions and ad breaks, and knowing when it got it right.

**Cost** (measured with 4 threads): peak memory is ~0.8 GB with an embedded/external English track and ~0.9 GB when Whisper runs, so a 2 GB container limit leaves room for the Node service. With an English track a film takes seconds. Without one, the audio is transcribed once (cached): a 12-minute film took 5 s on an Apple M5; on a 4-core NAS Celeron my estimate (not yet measured) is 10–30 minutes per 2-hour film with the `base` model.

## Switching from Subsyncarr Plus (Portainer / QNAP)

1. In your stack, change the image to `ghcr.io/<your-github-user>/subsyncarr-plusplus:latest`.
2. If you set `INCLUDE_ENGINES`, add `claudesynchro` to it (if you do not set it, all four engines run).
3. Raise the memory limit to **2G** (claudesynchro peaks at ~0.9 GB).
4. Optionally set `CLAUDESYNCHRO_LANGUAGES` (default `pl`) and `CLAUDESYNCHRO_GAP_FILL` (default `english`).
5. Redeploy. History, database and logs in `/app/data` are kept. Models (~300 MB) are downloaded into `/app/data/claudesynchro/models` on first use.

The image is `linux/amd64` (Intel/AMD NAS). It is built by GitHub Actions on every push to `main` (see `.github/workflows/docker-publish.yml`).

## claudesynchro settings

| Variable                                 | Default                        | Description                                                                                                                                                            |
| ---------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDESYNCHRO_LANGUAGES`                | `pl`                           | Subtitle languages to synchronise (ISO 639-1, comma-separated). Other subtitles are skipped by this engine without starting it. Untagged files are checked by content. |
| `CLAUDESYNCHRO_GAP_FILL`                 | `english`                      | Scenes that exist in the video but not in the subtitles: `none`, `english` (copy the reference lines) or `translate` (LLM via OpenRouter, needs `OPENROUTER_API_KEY`). |
| `CLAUDESYNCHRO_GAP_FILL_PREFIX`          | _(empty)_                      | Text put in front of filled lines, e.g. `[EN] `.                                                                                                                       |
| `CLAUDESYNCHRO_GAP_FILL_FROM_TRANSCRIPT` | `false`                        | Also fill when the reference is a Whisper transcript. Off by default: a "scene" missing from the subtitles may be an ad break, and you would get the ad's speech.      |
| `CLAUDESYNCHRO_MIN_CONFIDENCE`           | `0.5`                          | Do not write a result below this confidence (0–1).                                                                                                                     |
| `CLAUDESYNCHRO_REFERENCE`                | `embedded,external,transcript` | Reference sources, in order of preference. Remove `transcript` to never run Whisper.                                                                                   |
| `CLAUDESYNCHRO_REFERENCE_LANGUAGES`      | `en,*`                         | Preferred reference languages; `*` allows any other language afterwards.                                                                                               |
| `CLAUDESYNCHRO_VERIFY_EXTERNAL`          | `true`                         | Check external reference subtitles against the speech in the audio (in 10-minute windows) before trusting them.                                                        |
| `CLAUDESYNCHRO_TIMEOUT_MS`               | `10800000`                     | Timeout per file (3 h; transcription on a slow CPU takes a while).                                                                                                     |
| `WHISPER_MODEL`                          | `base`                         | `tiny`, `base`, `small`, … Only used when there is no usable subtitle reference. `small` is more accurate and ~2.5× slower.                                            |
| `WHISPER_COMPUTE_TYPE`                   | `int8`                         | CTranslate2 compute type; falls back automatically if the CPU does not support it.                                                                                     |
| `CLAUDESYNCHRO_THREADS`                  | _(all cores)_                  | CPU threads for Whisper and embeddings. Set e.g. `2` to leave room for Plex.                                                                                           |
| `CLAUDESYNCHRO_TRANSCRIBER`              | `local`                        | `local` or `openrouter` (Whisper in the cloud, ~$0.006/min, nothing heavy on the NAS).                                                                                 |
| `CLAUDESYNCHRO_EMBEDDINGS`               | `local`                        | `local` or `openrouter`.                                                                                                                                               |
| `OPENROUTER_API_KEY`                     | _(none)_                       | Only needed for `translate`, or the OpenRouter backends.                                                                                                               |
| `OPENROUTER_MODEL`                       | `anthropic/claude-haiku-5.5`   | LLM for `translate`.                                                                                                                                                   |
| `OPENROUTER_TRANSCRIBE_MODEL`            | `openai/whisper-large-v3`      | Speech-to-text model for `CLAUDESYNCHRO_TRANSCRIBER=openrouter`.                                                                                                       |
| `OPENROUTER_EMBED_MODEL`                 | `baai/bge-m3`                  | Embedding model for `CLAUDESYNCHRO_EMBEDDINGS=openrouter`.                                                                                                             |
| `CLAUDESYNCHRO_DATA_DIR`                 | `/app/data/claudesynchro`      | Models, transcript cache and reports.                                                                                                                                  |

With the defaults nothing leaves your NAS and no LLM is used: the "AI" is a 120 MB multilingual sentence model and, when needed, Whisper.

### Files

```
Movie (2024)/
├── Movie (2024).mkv
├── Movie (2024).pl.srt                  # your subtitles (never modified)
├── Movie (2024).pl.claudesynchro.srt    # claudesynchro result
├── Movie (2024).pl.alass.srt            # other engines, as before
└── Movie (2024).txt                     # Napiprojekt MicroDVD/MPL2 .txt is supported too → Movie (2024).pl.claudesynchro.srt
```

Supported subtitle input: SRT, ASS/SSA, WebVTT, MicroDVD, MPL2 and TMPlayer, in UTF-8/16, CP1250 or ISO-8859-2 (detected automatically). Output is always UTF-8 SRT.

In the web UI, every file shows claudesynchro's summary (confidence, reference, frame rate, cuts, dropped/filled lines) with a link to the full report (`/api/claudesynchro/report?file=…`), which also lists the dropped lines.

### Command line

The engine can be run on its own, inside the container or anywhere Python 3.10+ and ffmpeg are installed:

```bash
docker exec -it subsyncarr-plusplus claudesynchro sync \
  --video "/movies/Movie (2024)/Movie (2024).mkv" \
  --subtitle "/movies/Movie (2024)/Movie (2024).pl.srt"

claudesynchro probe --video movie.mkv                       # streams and reference candidates
claudesynchro transcribe --video movie.mkv --output t.srt   # Whisper transcript as SRT
```

Exit codes: `0` written, `2` not written (low confidence), `3` skipped, `1` error. `--json` prints a machine-readable result.

### Development

```bash
npm install && npm run build && npm test          # Node service (use Node 22)
cd claudesynchro && pip install -e '.[dev]' && pytest
```

## General configuration

All Subsyncarr Plus settings work unchanged. claudesynchro's own settings are listed [above](#claudesynchro-settings).

### Core Configuration

| Variable                    | Default                                     | Description                                                                      |
| --------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `SCAN_PATHS`                | `/scan_dir`                                 | Comma-separated directories to scan for SRT files (must be mounted as volumes)   |
| `EXCLUDE_PATHS`             | _(none)_                                    | Comma-separated directories to exclude from scanning                             |
| `CRON_SCHEDULE`             | `0 0 * * *`                                 | Cron expression for sync schedule (daily at midnight), or `disabled` to turn off |
| `MAX_CONCURRENT_SYNC_TASKS` | `1`                                         | Number of subtitle files to process in parallel (higher = faster but more CPU)   |
| `INCLUDE_ENGINES`           | `ffsubsync,autosubsync,alass,claudesynchro` | Which sync engines to use (comma-separated)                                      |
| `SYNC_ENGINE_TIMEOUT_MS`    | `1800000`                                   | Timeout for each sync engine in milliseconds (30 min default)                    |
| `NODE_OPTIONS`              | `--max-old-space-size=512`                  | Node.js options, used here to set memory limit (in MB)                           |
| `TZ`                        | _(system)_                                  | Timezone for logging and cron scheduling (e.g., `America/New_York`)              |
| `PUID`                      | `1000`                                      | User ID for file permissions (run `id -u` to find yours)                         |
| `PGID`                      | `1000`                                      | Group ID for file permissions (run `id -g` to find yours)                        |

### Database & Log Configuration

| Variable                           | Default                        | Description                                 |
| ---------------------------------- | ------------------------------ | ------------------------------------------- |
| `DB_PATH`                          | `/app/data/subsyncarr-plus.db` | SQLite database location                    |
| `LOG_BUFFER_SIZE`                  | `1000`                         | Ring buffer size for in-memory logs         |
| `RETENTION_KEEP_RUNS_DAYS`         | `30`                           | Keep complete runs for N days               |
| `RETENTION_TRIM_LOGS_DAYS`         | `7`                            | Trim logs after N days (keeps summary only) |
| `RETENTION_MAX_LOG_SIZE`           | `10000`                        | Max size for trimmed logs in bytes          |
| `RETENTION_CLEANUP_INTERVAL_HOURS` | `24`                           | How often to run cleanup (in hours)         |

### Timeout Configuration

The `SYNC_ENGINE_TIMEOUT_MS` environment variable controls how long each sync engine can run before being terminated. This prevents hung processes from blocking the queue.

Example configuration:

```yaml
environment:
  - SYNC_ENGINE_TIMEOUT_MS=3600000 # 60 minutes for large files
```

### Directory Structure

Your media directory should be organized with video files and their corresponding subtitle files using matching names:

```txt
/movies
├── Movie Title (2024).mkv
├── Movie Title (2024).srt          # Will be synchronized
├── Movie Title (2024).ffsubsync.srt # Generated output
└── Another Movie.mp4
    └── Another Movie.srt

/tv
├── Show Name/
│   ├── Season 01/
│   │   ├── Show.S01E01.mkv
│   │   └── Show.S01E01.srt
```

The app follows standard naming conventions compatible with Plex, Jellyfin, Emby, and Bazarr.

## Web UI

Subsyncarr Plus includes a comprehensive web-based monitoring interface accessible at `http://localhost:3000` after starting the container.

### UI Features

**Real-time Monitoring:**

- Live progress bars showing current processing status
- File-by-file status updates via WebSocket
- Engine-level detail (see which sync engine is running)
- Current and queued files display

**Manual Control:**

- **Start Full Run** - Process all configured directories immediately
- **Scan Specific Path** - Process a custom directory on demand
- **Stop Processing** - Cancel all remaining files in current run
- **Skip File** - Cancel processing for individual files

**File Management:**

- View completed and skipped files
- Clear processed files from the UI
- Track file status (pending, processing, completed, skipped, error)
- See matched video files for each subtitle

**Processing History:**

- Sortable run history table with timestamps
- Per-run statistics (total, completed, skipped, failed counts)
- Engine-level results summary with notation:
  - **F** = ffsubsync result
  - **Au** = autosubsync result
  - **Al** = alass result
- Duration tracking for each run
- View detailed logs for any past run with copy-to-clipboard functionality

**Configuration Dashboard:**

- Display of monitored paths and excluded paths
- Schedule status with next run time
- Human-readable cron schedule translation

### Database Persistence

Processing history is stored in SQLite and persists across container restarts. Ensure the data volume is mounted:

```yaml
volumes:
  - ./data:/app/data # Database and logs stored here
```

## Advanced Features

### Auto-Skip on Repeated Failures

The app intelligently tracks failures for each file/engine combination. After 3 consecutive failures, that engine will be automatically skipped for that specific file, preventing wasted processing time. You can reset skip status via the API endpoint `/api/skip-status/reset`.

### Memory Management

Optimized for low-memory environments with:

- Configurable memory limits (768MB default, 128MB minimum)
- SQLite optimizations for low RAM usage
- File-based logging with buffering to reduce memory pressure
- Automatic database vacuuming and cleanup
- Ring buffer for in-memory logs

### Log Retention & Cleanup

Automatic cleanup keeps your database size manageable:

- Complete runs retained for 30 days (configurable)
- Logs trimmed after 7 days, keeping only summaries
- Runs beyond retention period are automatically deleted
- Cleanup runs every 24 hours (configurable)

## Troubleshooting

### View Container Logs

```bash
docker logs -f subsyncarr-plus
```

### Check Web UI Logs

Detailed processing logs are available in the Web UI under "Processing History" - click on any run to view full logs.

### Permission Issues

If you encounter permission errors, ensure `PUID` and `PGID` match your host user:

```bash
id -u  # Get your user ID
id -g  # Get your group ID
```

Then update your docker-compose.yaml with these values.

### Memory Issues

If the container is being killed due to OOM (Out Of Memory):

1. Reduce `MAX_CONCURRENT_SYNC_TASKS` to 1
2. Increase memory limit in `NODE_OPTIONS` (e.g., `--max-old-space-size=1024`)
3. Increase memory limit in docker-compose.yaml
4. Reduce `SYNC_ENGINE_TIMEOUT_MS` for faster timeouts
5. Exclude large files or problematic directories with `EXCLUDE_PATHS`

### Files Not Being Processed

Check that:

1. Your subtitle files are named to match video files (e.g., `movie.mkv` and `movie.srt`)
2. `SCAN_PATHS` matches your mounted volumes
3. Files haven't already been synced (check for `.ffsubsync.srt` files)
4. Files aren't being auto-skipped due to repeated failures (check skip status in Web UI)

## Contributing

Issues and pull requests are welcome.

## Credits

- [subsyncarr](https://github.com/johnpc/subsyncarr) by johnpc and [Subsyncarr Plus](https://github.com/tomtomwillis/subsyncarr_plus) by tomtomwillis, which this builds on.
- [ffsubsync](https://github.com/smacke/ffsubsync), [autosubsync](https://github.com/oseiskar/autosubsync), [alass](https://github.com/kaegi/alass).
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and [paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) (ONNX export by [Xenova](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)) used by claudesynchro.
