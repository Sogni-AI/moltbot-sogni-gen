#!/usr/bin/env node
/**
 * sogni-gen MCP Server
 *
 * Exposes Sogni AI image/video generation as MCP tools for Claude Code
 * and Claude Desktop.  Wraps the sogni-gen CLI using its --json mode.
 *
 * Install (Claude Code):
 *   claude mcp add sogni -- npx -y -p sogni-gen sogni-gen-mcp
 *
 * Install (Claude Desktop – add to claude_desktop_config.json):
 *   { "mcpServers": { "sogni": { "command": "npx", "args": ["-y", "-p", "sogni-gen", "sogni-gen-mcp"] } } }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SOGNI_GEN = join(__dirname, 'sogni-gen.mjs');
const CREDENTIALS_PATH = join(homedir(), '.config', 'sogni', 'credentials');

// ---------------------------------------------------------------------------
// CLI spawning helper
// ---------------------------------------------------------------------------

/**
 * Spawn `node sogni-gen.mjs --json ...args`, collect stdout, parse JSON.
 * Returns the parsed object on success or throws on failure.
 */
function runSogniGen(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SOGNI_GEN, '--json', '--quiet', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn sogni-gen: ${err.message}`));
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (!stdout) {
        reject(new Error(stderr || `sogni-gen exited with code ${code} and no output`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch {
        reject(new Error(`Failed to parse sogni-gen output: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Credential check helper
// ---------------------------------------------------------------------------

function checkCredentials() {
  if (existsSync(CREDENTIALS_PATH)) return null;
  if (process.env.SOGNI_USERNAME && process.env.SOGNI_PASSWORD) return null;
  return {
    content: [
      {
        type: 'text',
        text: [
          'Sogni credentials not found. Please set up credentials:',
          '',
          '1. Create a Sogni account at https://sogni.ai',
          '2. Create the credentials file:',
          '',
          '   mkdir -p ~/.config/sogni',
          '   cat > ~/.config/sogni/credentials << \'EOF\'',
          '   SOGNI_USERNAME=your_username',
          '   SOGNI_PASSWORD=your_password',
          '   EOF',
          '   chmod 600 ~/.config/sogni/credentials',
          '',
          'Or set SOGNI_USERNAME and SOGNI_PASSWORD environment variables.',
        ].join('\n'),
      },
    ],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatSuccess(result) {
  const parts = [];

  if (result.type === 'balance') {
    parts.push(`SPARK: ${result.spark ?? 'N/A'}`);
    parts.push(`SOGNI: ${result.sogni ?? 'N/A'}`);
    return { content: [{ type: 'text', text: parts.join('\n') }] };
  }

  // Image / video result
  if (result.prompt) parts.push(`Prompt: ${result.prompt}`);
  parts.push(`Model: ${result.model}`);
  parts.push(`Size: ${result.width}x${result.height}`);
  if (result.seed != null) parts.push(`Seed: ${result.seed}`);

  if (result.type === 'video') {
    if (result.workflow) parts.push(`Workflow: ${result.workflow}`);
    if (result.duration) parts.push(`Duration: ${result.duration}s`);
    if (result.fps) parts.push(`FPS: ${result.fps}`);
  }

  if (result.localPath) parts.push(`Saved to: ${result.localPath}`);

  // URLs
  const urls = result.urls || [];
  if (urls.length > 0) {
    parts.push('');
    urls.forEach((url, i) => {
      parts.push(urls.length === 1 ? `URL: ${url}` : `URL #${i + 1}: ${url}`);
    });
  }

  const content = [{ type: 'text', text: parts.join('\n') }];

  // Also include image URLs as image content so Claude can see them
  for (const url of urls) {
    if (/\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(url)) {
      content.push({ type: 'image', data: url, mimeType: 'image/png' });
    }
  }

  return { content };
}

function formatError(result) {
  const parts = [`Error: ${result.error}`];
  if (result.errorCode) parts.push(`Code: ${result.errorCode}`);
  if (result.hint) parts.push(`Hint: ${result.hint}`);
  return { content: [{ type: 'text', text: parts.join('\n') }], isError: true };
}

function formatResult(result) {
  if (result.success === false) return formatError(result);
  return formatSuccess(result);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const IMAGE_MODEL_TABLE = `Image Models:
  z_image_turbo_bf16         — Fast (~5-10s), general purpose (default)
  flux1-schnell-fp8          — Very fast (~3-5s), quick iterations
  flux2_dev_fp8              — Slow (~2min), high quality
  chroma-v.46-flash_fp8      — Medium (~30s), balanced
  qwen_image_edit_2511_fp8   — Medium (~30s), image editing with context
  qwen_image_edit_2511_fp8_lightning — Fast (~8s), quick image editing`;

const VIDEO_MODEL_TABLE = `Video Models (auto-selected per workflow):
  wan_v2.2-14b-fp8_t2v_lightx2v             — Text-to-video (~5min)
  wan_v2.2-14b-fp8_i2v_lightx2v             — Image-to-video (~3-5min)
  wan_v2.2-14b-fp8_s2v_lightx2v             — Sound-to-video (~5min)
  wan_v2.2-14b-fp8_animate-move_lightx2v    — Animate-move (~5min)
  wan_v2.2-14b-fp8_animate-replace_lightx2v — Animate-replace (~5min)`;

const TOOLS = [
  {
    name: 'generate_image',
    description: `Generate an image using Sogni AI's decentralized GPU network.

${IMAGE_MODEL_TABLE}

Cost: Uses Spark tokens. 512x512 is most cost-efficient. Claim 50 free daily Spark at https://app.sogni.ai/`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Image description / generation prompt',
        },
        model: {
          type: 'string',
          description: 'Model ID (default: z_image_turbo_bf16)',
        },
        width: {
          type: 'number',
          description: 'Image width in pixels (default: 512)',
        },
        height: {
          type: 'number',
          description: 'Image height in pixels (default: 512)',
        },
        count: {
          type: 'number',
          description: 'Number of images to generate (default: 1)',
        },
        seed: {
          type: 'number',
          description: 'Specific seed for reproducibility',
        },
        output: {
          type: 'string',
          description: 'Save image to this file path',
        },
        output_format: {
          type: 'string',
          enum: ['png', 'jpg'],
          description: 'Output format (default: png)',
        },
        loras: {
          type: 'array',
          items: { type: 'string' },
          description: 'LoRA model IDs',
        },
        lora_strengths: {
          type: 'array',
          items: { type: 'number' },
          description: 'LoRA strengths (parallel to loras array)',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description: `Generate a video using Sogni AI's decentralized GPU network.

Workflows:
  t2v             — Text-to-video (default). Just provide a prompt.
  i2v             — Image-to-video. Provide ref (reference image). Supports looping.
  s2v             — Sound-to-video. Provide ref (face image) + ref_audio.
  animate-move    — Transfer motion from ref_video to ref image.
  animate-replace — Replace subject in ref_video with ref image.

${VIDEO_MODEL_TABLE}

Video dimensions must be divisible by 16, min 480px, max 1536px. Generation takes 3-5 minutes.
Cost: Uses Spark tokens. Claim 50 free daily Spark at https://app.sogni.ai/`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Video description / generation prompt',
        },
        workflow: {
          type: 'string',
          enum: ['t2v', 'i2v', 's2v', 'animate-move', 'animate-replace'],
          description: 'Video workflow (default: t2v, auto-inferred from provided refs)',
        },
        model: {
          type: 'string',
          description: 'Model ID (auto-selected per workflow by default)',
        },
        width: {
          type: 'number',
          description: 'Video width in pixels (default: 512, must be divisible by 16)',
        },
        height: {
          type: 'number',
          description: 'Video height in pixels (default: 512, must be divisible by 16)',
        },
        fps: {
          type: 'number',
          description: 'Frames per second (default: 16)',
        },
        duration: {
          type: 'number',
          description: 'Duration in seconds (default: 5)',
        },
        frames: {
          type: 'number',
          description: 'Override total frame count (alternative to duration)',
        },
        ref: {
          type: 'string',
          description: 'Reference image path or URL (for i2v, s2v, animate workflows)',
        },
        ref_end: {
          type: 'string',
          description: 'End frame image path or URL (for i2v interpolation)',
        },
        ref_audio: {
          type: 'string',
          description: 'Reference audio file path (for s2v workflow)',
        },
        ref_video: {
          type: 'string',
          description: 'Reference video file path (for animate workflows)',
        },
        seed: {
          type: 'number',
          description: 'Specific seed for reproducibility',
        },
        output: {
          type: 'string',
          description: 'Save video to this file path',
        },
        looping: {
          type: 'boolean',
          description: 'Generate seamless loop (i2v only)',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description: `Edit or transform an existing image using Sogni AI (Qwen image editing models).

Provide 1-3 context images and a prompt describing the desired edit. Examples:
  - "make the background a beach"
  - "apply pop art style"
  - "remove the person on the left"
  - "add a rainbow in the sky"

Models:
  qwen_image_edit_2511_fp8_lightning — Fast (~8s), default
  qwen_image_edit_2511_fp8          — Medium (~30s), higher quality`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Editing instruction describing the desired change',
        },
        context_images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Image file paths or URLs to edit (1-3 images)',
          minItems: 1,
          maxItems: 3,
        },
        model: {
          type: 'string',
          description: 'Model ID (default: qwen_image_edit_2511_fp8_lightning)',
        },
        width: {
          type: 'number',
          description: 'Output width in pixels',
        },
        height: {
          type: 'number',
          description: 'Output height in pixels',
        },
        output: {
          type: 'string',
          description: 'Save edited image to this file path',
        },
      },
      required: ['prompt', 'context_images'],
    },
  },
  {
    name: 'photobooth',
    description: `Generate stylized portraits from a face photo using InstantID face transfer.

Provide a face reference image and a style prompt. Examples:
  - "80s fashion portrait"
  - "LinkedIn professional headshot"
  - "oil painting Renaissance style"
  - "anime character"

Uses SDXL Turbo (coreml-sogniXLturbo_alpha1_ad) at 1024x1024 by default.
The face likeness is preserved while applying the style from the prompt.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Style/scene description for the portrait',
        },
        reference_face: {
          type: 'string',
          description: 'Face image file path or URL',
        },
        model: {
          type: 'string',
          description: 'Model ID (default: coreml-sogniXLturbo_alpha1_ad)',
        },
        cn_strength: {
          type: 'number',
          description: 'ControlNet strength — higher = more face likeness (default: 0.8)',
        },
        cn_guidance_end: {
          type: 'number',
          description: 'ControlNet guidance end point (default: 0.3)',
        },
        width: {
          type: 'number',
          description: 'Output width in pixels (default: 1024)',
        },
        height: {
          type: 'number',
          description: 'Output height in pixels (default: 1024)',
        },
        count: {
          type: 'number',
          description: 'Number of images to generate (default: 1)',
        },
        output: {
          type: 'string',
          description: 'Save image to this file path',
        },
      },
      required: ['prompt', 'reference_face'],
    },
  },
  {
    name: 'check_balance',
    description:
      'Check your current Sogni token balances (SPARK and SOGNI). Free daily Spark tokens can be claimed at https://app.sogni.ai/',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_models',
    description:
      'List all available Sogni AI models for image generation, image editing, photobooth, and video generation with speed estimates.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleGenerateImage(params) {
  const credErr = checkCredentials();
  if (credErr) return credErr;

  const args = [params.prompt];
  if (params.model) args.push('-m', params.model);
  if (params.width) args.push('-w', String(params.width));
  if (params.height) args.push('-h', String(params.height));
  if (params.count) args.push('-n', String(params.count));
  if (params.seed != null) args.push('-s', String(params.seed));
  if (params.output) args.push('-o', params.output);
  if (params.output_format) args.push('--output-format', params.output_format);
  if (params.loras?.length) args.push('--loras', params.loras.join(','));
  if (params.lora_strengths?.length) args.push('--lora-strengths', params.lora_strengths.join(','));

  const result = await runSogniGen(args, { timeoutMs: 60_000 });
  return formatResult(result);
}

async function handleGenerateVideo(params) {
  const credErr = checkCredentials();
  if (credErr) return credErr;

  const args = ['--video', params.prompt];
  if (params.workflow) args.push('--workflow', params.workflow);
  if (params.model) args.push('-m', params.model);
  if (params.width) args.push('-w', String(params.width));
  if (params.height) args.push('-h', String(params.height));
  if (params.fps) args.push('--fps', String(params.fps));
  if (params.duration) args.push('--duration', String(params.duration));
  if (params.frames) args.push('--frames', String(params.frames));
  if (params.ref) args.push('--ref', params.ref);
  if (params.ref_end) args.push('--ref-end', params.ref_end);
  if (params.ref_audio) args.push('--ref-audio', params.ref_audio);
  if (params.ref_video) args.push('--ref-video', params.ref_video);
  if (params.seed != null) args.push('-s', String(params.seed));
  if (params.output) args.push('-o', params.output);
  if (params.looping) args.push('--looping');

  const result = await runSogniGen(args, { timeoutMs: 600_000 });
  return formatResult(result);
}

async function handleEditImage(params) {
  const credErr = checkCredentials();
  if (credErr) return credErr;

  const args = [];
  for (const img of params.context_images) {
    args.push('-c', img);
  }
  args.push(params.prompt);
  if (params.model) args.push('-m', params.model);
  if (params.width) args.push('-w', String(params.width));
  if (params.height) args.push('-h', String(params.height));
  if (params.output) args.push('-o', params.output);

  const result = await runSogniGen(args, { timeoutMs: 60_000 });
  return formatResult(result);
}

async function handlePhotobooth(params) {
  const credErr = checkCredentials();
  if (credErr) return credErr;

  const args = ['--photobooth', '--ref', params.reference_face, params.prompt];
  if (params.model) args.push('-m', params.model);
  if (params.cn_strength != null) args.push('--cn-strength', String(params.cn_strength));
  if (params.cn_guidance_end != null) args.push('--cn-guidance-end', String(params.cn_guidance_end));
  if (params.width) args.push('-w', String(params.width));
  if (params.height) args.push('-h', String(params.height));
  if (params.count) args.push('-n', String(params.count));
  if (params.output) args.push('-o', params.output);

  const result = await runSogniGen(args, { timeoutMs: 60_000 });
  return formatResult(result);
}

async function handleCheckBalance() {
  const credErr = checkCredentials();
  if (credErr) return credErr;

  const result = await runSogniGen(['--balance'], { timeoutMs: 30_000 });
  return formatResult(result);
}

function handleListModels() {
  const text = `${IMAGE_MODEL_TABLE}

Photobooth Model:
  coreml-sogniXLturbo_alpha1_ad — Fast, face transfer (SDXL Turbo, default for --photobooth)

${VIDEO_MODEL_TABLE}

Defaults:
  Image generation: z_image_turbo_bf16
  Image editing:    qwen_image_edit_2511_fp8_lightning
  Photobooth:       coreml-sogniXLturbo_alpha1_ad
  Video:            auto-selected per workflow (t2v/i2v/s2v/animate-move/animate-replace)`;

  return { content: [{ type: 'text', text }] };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'sogni', version: '1.3.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: params } = request.params;
  try {
    switch (name) {
      case 'generate_image':
        return await handleGenerateImage(params);
      case 'generate_video':
        return await handleGenerateVideo(params);
      case 'edit_image':
        return await handleEditImage(params);
      case 'photobooth':
        return await handlePhotobooth(params);
      case 'check_balance':
        return await handleCheckBalance();
      case 'list_models':
        return handleListModels();
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
