import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || 'veo-3.0-generate-001';
const AUDIO_MODEL = process.env.GEMINI_AUDIO_MODEL || 'gemini-2.5-flash';

if (!GEMINI_API_KEY) {
  console.warn('[gemini-mcp] WARNING: GEMINI_API_KEY is not set. Tool calls will fail until it is configured.');
}

// ---- Gemini REST helpers -----------------------------------------------

async function geminiPost(path, body) {
  const url = `${GEMINI_BASE}/${path}?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function geminiGet(pathWithoutBase) {
  // pathWithoutBase is an operation name like "models/veo-3.0-generate-001/operations/xyz"
  const url = `${GEMINI_BASE}/${pathWithoutBase}?key=${GEMINI_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function extractText(data) {
  return (
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text)
      .filter(Boolean)
      .join('\n') || ''
  );
}

// ---- MCP server / tool definitions -------------------------------------

function buildServer() {
  const server = new McpServer({ name: 'gemini-mcp', version: '1.0.0' });

  // 1. Text generation -----------------------------------------------------
  server.registerTool(
    'generate_text',
    {
      title: 'Generate text',
      description:
        'Generate text with Gemini — captions, copywriting, summaries, translation, analysis, or any text-based content. ' +
        'Supports an optional system instruction to steer tone/persona (e.g. for Egyptian Arabic ad copy).',
      inputSchema: {
        prompt: z.string().describe('The prompt to send to Gemini'),
        system_instruction: z.string().optional().describe('Optional system instruction to steer tone/persona/format'),
        model: z.string().optional().describe(`Gemini model override (default: ${TEXT_MODEL})`),
        max_output_tokens: z.number().int().positive().optional().describe('Maximum tokens in the response'),
        temperature: z.number().min(0).max(2).optional().describe('Sampling temperature 0-2 (default model setting)'),
      },
    },
    async ({ prompt, system_instruction, model, max_output_tokens, temperature }) => {
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(system_instruction && { systemInstruction: { parts: [{ text: system_instruction }] } }),
        generationConfig: {
          ...(max_output_tokens && { maxOutputTokens: max_output_tokens }),
          ...(temperature !== undefined && { temperature }),
        },
      };
      const data = await geminiPost(`models/${model || TEXT_MODEL}:generateContent`, body);
      return { content: [{ type: 'text', text: extractText(data) }] };
    }
  );

  // 2. Image generation / editing ------------------------------------------
  server.registerTool(
    'generate_image',
    {
      title: 'Generate or edit an image',
      description:
        'Generate an image from a text prompt, or edit/compose an existing image (Nano Banana / Gemini image model). ' +
        'Pass reference_image_base64 to edit a specific image instead of generating from scratch.',
      inputSchema: {
        prompt: z.string().describe('Image description, or editing instruction when a reference image is provided'),
        reference_image_base64: z.string().optional().describe('Base64-encoded reference image to edit or compose with'),
        reference_image_mime_type: z
          .string()
          .optional()
          .describe('MIME type of the reference image, e.g. image/png, image/jpeg (default image/png)'),
        model: z.string().optional().describe(`Gemini image model override (default: ${IMAGE_MODEL})`),
      },
    },
    async ({ prompt, reference_image_base64, reference_image_mime_type, model }) => {
      const parts = [];
      if (reference_image_base64) {
        parts.push({
          inlineData: { mimeType: reference_image_mime_type || 'image/png', data: reference_image_base64 },
        });
      }
      parts.push({ text: prompt });

      const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      };
      const data = await geminiPost(`models/${model || IMAGE_MODEL}:generateContent`, body);
      const responseParts = data.candidates?.[0]?.content?.parts || [];
      const imagePart = responseParts.find((p) => p.inlineData);

      if (!imagePart) {
        const textPart = responseParts.find((p) => p.text);
        throw new Error(`No image returned by Gemini. Model said: ${textPart?.text || 'no explanation given'}`);
      }

      return {
        content: [{ type: 'image', data: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType }],
      };
    }
  );

  // 3. Video generation (Veo) — async, two-step ---------------------------
  server.registerTool(
    'start_video_generation',
    {
      title: 'Start a Veo video generation job',
      description:
        'Starts a Veo video generation job from a text prompt (and optionally a reference image for image-to-video). ' +
        'This is asynchronous — generation typically takes 1-6 minutes. Returns an operation_name to poll with check_video_status.',
      inputSchema: {
        prompt: z.string().describe('Description of the video to generate'),
        reference_image_base64: z.string().optional().describe('Base64-encoded image to animate (image-to-video)'),
        reference_image_mime_type: z.string().optional().describe('MIME type of the reference image (default image/png)'),
        aspect_ratio: z.enum(['16:9', '9:16']).optional().describe('Video aspect ratio (default 16:9)'),
        model: z.string().optional().describe(`Veo model override (default: ${VIDEO_MODEL})`),
      },
    },
    async ({ prompt, reference_image_base64, reference_image_mime_type, aspect_ratio, model }) => {
      const instance = { prompt };
      if (reference_image_base64) {
        instance.image = {
          bytesBase64Encoded: reference_image_base64,
          mimeType: reference_image_mime_type || 'image/png',
        };
      }
      const body = {
        instances: [instance],
        parameters: { ...(aspect_ratio && { aspectRatio: aspect_ratio }) },
      };
      const data = await geminiPost(`models/${model || VIDEO_MODEL}:predictLongRunning`, body);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'pending', operation_name: data.name }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'check_video_status',
    {
      title: 'Check Veo video generation status',
      description:
        'Polls a Veo video generation job started with start_video_generation. ' +
        'Returns {"status":"pending"} while still running, or the finished video (base64 mp4) when done.',
      inputSchema: {
        operation_name: z.string().describe('The operation_name returned by start_video_generation'),
      },
    },
    async ({ operation_name }) => {
      const data = await geminiGet(operation_name);

      if (!data.done) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'pending' }, null, 2) }] };
      }
      if (data.error) {
        throw new Error(`Video generation failed: ${JSON.stringify(data.error)}`);
      }

      const sample =
        data.response?.generateVideoResponse?.generatedSamples?.[0]?.video ||
        data.response?.predictions?.[0];
      const videoB64 = sample?.bytesBase64Encoded || sample?.video?.bytesBase64Encoded;

      if (!videoB64) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ status: 'done', warning: 'no video bytes found', raw: data.response }, null, 2) },
          ],
        };
      }

      return {
        content: [
          { type: 'text', text: JSON.stringify({ status: 'done' }) },
          {
            type: 'resource',
            resource: {
              uri: `gemini-video://${randomUUID()}.mp4`,
              mimeType: 'video/mp4',
              blob: videoB64,
            },
          },
        ],
      };
    }
  );

  // 4. Audio transcription --------------------------------------------------
  server.registerTool(
    'transcribe_audio',
    {
      title: 'Transcribe audio',
      description:
        'Transcribes an audio file (m4a, mp3, wav, aac, ogg, flac) using Gemini. Supports an optional instruction, ' +
        'e.g. "transcribe in Egyptian Arabic" or "translate to English". Inline audio is limited to ~20MB; larger files ' +
        'need the Gemini File API (not yet implemented in this tool).',
      inputSchema: {
        audio_base64: z.string().describe('Base64-encoded audio file data'),
        mime_type: z
          .string()
          .optional()
          .describe('MIME type — audio/mp4 for .m4a, audio/mpeg for .mp3, audio/wav for .wav (default audio/mp4)'),
        instruction: z
          .string()
          .optional()
          .describe('Optional instruction, e.g. "transcribe in Egyptian Arabic" or "translate to English"'),
        model: z.string().optional().describe(`Gemini model override (default: ${AUDIO_MODEL})`),
      },
    },
    async ({ audio_base64, mime_type, instruction, model }) => {
      const prompt = instruction || 'Transcribe this audio file exactly, word for word. Output only the transcript.';
      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: mime_type || 'audio/mp4', data: audio_base64 } },
              { text: prompt },
            ],
          },
        ],
      };
      const data = await geminiPost(`models/${model || AUDIO_MODEL}:generateContent`, body);
      return { content: [{ type: 'text', text: extractText(data) }] };
    }
  );

  return server;
}

// ---- Express transport wiring -------------------------------------------

const app = express();
app.use(express.json({ limit: '50mb' })); // base64 audio/image payloads need a larger body limit

// Optional shared secret: when MCP_SECRET is set, the endpoint becomes /mcp/<MCP_SECRET>
// so a public URL can't be used to spend the API key. claude.ai connectors can't send
// custom headers, so the secret lives in the path.
const MCP_SECRET = process.env.MCP_SECRET;
const MCP_PATH = MCP_SECRET ? `/mcp/${MCP_SECRET}` : '/mcp';
if (!MCP_SECRET) {
  console.warn('[gemini-mcp] WARNING: MCP_SECRET is not set. The /mcp endpoint is open to anyone who finds the URL.');
}

app.post(MCP_PATH, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[gemini-mcp] request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(err?.message || err) }, id: null });
    }
  }
});

app.get(MCP_PATH, (_req, res) => {
  res.status(405).json({ error: 'Method not allowed. MCP clients should POST to this endpoint.' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, geminiKeyConfigured: Boolean(GEMINI_API_KEY) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[gemini-mcp] listening on port ${PORT}`);
});
