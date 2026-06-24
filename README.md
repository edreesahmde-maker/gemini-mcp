# Gemini MCP

Remote MCP server that exposes Google Gemini's text, image, video (Veo), and audio
transcription capabilities as tools any MCP client (Claude.ai, Claude Code, Cowork)
can call directly. Same architecture as the Bosta and Salestrail MCP connectors:
Node.js + Express, deployed as a Render web service, talking to Gemini's REST API.

## Tools

| Tool | What it does |
|---|---|
| `generate_text` | Text generation — captions, copy, summaries, translation, analysis. Optional `system_instruction`. |
| `generate_image` | Generate an image from a prompt, or edit/compose an existing one via `reference_image_base64` (Nano Banana / Gemini image model). |
| `start_video_generation` | Kicks off a Veo video job from a prompt (+ optional reference image for image-to-video). Returns an `operation_name` — generation takes ~1-6 min. |
| `check_video_status` | Polls an `operation_name` from `start_video_generation`. Returns `{"status":"pending"}` or the finished video as an embedded base64 resource. |
| `transcribe_audio` | Transcribes audio (m4a/mp3/wav/aac/ogg/flac) from base64, with an optional instruction (e.g. "transcribe in Egyptian Arabic"). |

All tools return MCP error results (`isError: true`) on failure rather than crashing
the server — confirmed against the live Gemini API during build (an invalid key
correctly came back as a tool error, not a connection drop).

## Known limitations / things to verify with a real key

- **Audio inline size limit**: requests with inline base64 data top out around
  ~20MB total. Longer call recordings will need the Gemini File API (upload first,
  then reference by URI) — not implemented yet. Worth adding if your typical .m4a
  files are long.
- **`.m4a` MIME type**: the tool defaults to `audio/mp4` for `.m4a` files, since that's
  the container format (AAC inside MP4). This has *not* been verified against a real
  audio file yet. If Gemini rejects it, try `audio/aac` instead — pass it explicitly
  via the `mime_type` argument.
- **Veo response shape**: `check_video_status` tries a couple of known response
  shapes (`generateVideoResponse.generatedSamples[0].video` and `predictions[0]`).
  Worth confirming against a real job once you have Veo access, since Google has
  changed this shape across API versions before.
- **Veo access**: Veo 3 may require allowlisting / billing on your Gemini API key —
  check the Gemini API console if `start_video_generation` errors out.

## Local setup

```bash
npm install
cp .env.example .env   # fill in GEMINI_API_KEY
npm start
```

Health check: `curl http://localhost:3000/health`

## Deploying to Render

1. Push this folder to a GitHub repo.
2. Render dashboard → New → Web Service → connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variable `GEMINI_API_KEY` (and optionally the model overrides
   from `.env.example`) in Render's Environment tab.
6. Once deployed, your MCP endpoint is `https://<your-app>.onrender.com/mcp`.

## Connecting in Claude

Add it as a custom connector pointing at `https://<your-app>.onrender.com/mcp`,
the same way Bosta MCP / Salestrail MCP are connected.
