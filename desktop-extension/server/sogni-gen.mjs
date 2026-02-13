#!/usr/bin/env node
/**
 * sogni-gen - Generate images and videos using Sogni AI
 * Usage: sogni-gen [options] "prompt"
 */

import { SogniClientWrapper, ClientEvent, getMaxContextImages } from '@sogni-ai/sogni-client-wrapper';
import JSON5 from 'json5';
import { createHash, randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { homedir, tmpdir } from 'os';
import sharp from 'sharp';

const LAST_RENDER_PATH = join(homedir(), '.config', 'sogni', 'last-render.json');
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), '.openclaw', 'openclaw.json');
const IS_OPENCLAW_INVOCATION = Boolean(process.env.OPENCLAW_PLUGIN_CONFIG);
const RAW_ARGS = process.argv.slice(2);
const CLI_WANTS_JSON = RAW_ARGS.includes('--json');
const JSON_ERROR_MODE = CLI_WANTS_JSON || IS_OPENCLAW_INVOCATION;
const VIDEO_WORKFLOW_DEFAULT_MODELS = {
  't2v': 'wan_v2.2-14b-fp8_t2v_lightx2v',
  'i2v': 'wan_v2.2-14b-fp8_i2v_lightx2v',
  's2v': 'wan_v2.2-14b-fp8_s2v_lightx2v',
  'animate-move': 'wan_v2.2-14b-fp8_animate-move_lightx2v',
  'animate-replace': 'wan_v2.2-14b-fp8_animate-replace_lightx2v'
};

function buildCliErrorPayload({ message, code, details, hint, prompt }) {
  const payload = {
    success: false,
    error: message || 'Unknown error',
    prompt: prompt ?? null
  };
  if (code) payload.errorCode = code;
  if (details) payload.errorDetails = details;
  if (hint) payload.hint = hint;
  payload.timestamp = new Date().toISOString();
  payload.node = process.versions.node;
  payload.cwd = process.cwd();
  if (IS_OPENCLAW_INVOCATION) payload.openclaw = true;
  return payload;
}

function fatalCliError(message, opts = {}) {
  let prompt = opts.prompt;
  if (prompt === undefined) {
    try {
      // If parsing already populated options, include prompt for better downstream reporting.
      prompt = options?.prompt ?? null;
    } catch (e) {
      prompt = null;
    }
  }
  const payload = buildCliErrorPayload({
    message,
    code: opts.code,
    details: opts.details,
    hint: opts.hint,
    prompt
  });

  if (JSON_ERROR_MODE) {
    console.log(JSON.stringify(payload));
    if (!CLI_WANTS_JSON) {
      // OpenClaw expects JSON, but humans still benefit from stderr.
      console.error(`Error: ${payload.error}`);
      if (payload.hint) console.error(`Hint: ${payload.hint}`);
    }
  } else {
    console.error(`Error: ${payload.error}`);
    if (payload.hint) console.error(`Hint: ${payload.hint}`);
  }
  process.exit(1);
}

function normalizeVideoWorkflow(value) {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === 't2v' || normalized === 'text-to-video') return 't2v';
  if (normalized === 'i2v' || normalized === 'image-to-video') return 'i2v';
  if (normalized === 's2v' || normalized === 'sound-to-video') return 's2v';
  if (normalized === 'animate-move' || normalized === 'animate_move') return 'animate-move';
  if (normalized === 'animate-replace' || normalized === 'animate_replace') return 'animate-replace';
  return null;
}

function inferVideoWorkflowFromModel(modelId) {
  if (!modelId) return null;
  const id = modelId.toLowerCase();
  if (id.includes('animate-move')) return 'animate-move';
  if (id.includes('animate-replace')) return 'animate-replace';
  if (id.includes('_t2v') || id.includes('-t2v')) return 't2v';
  if (id.includes('_i2v') || id.includes('-i2v')) return 'i2v';
  if (id.includes('_s2v') || id.includes('-s2v')) return 's2v';
  return null;
}

function inferVideoWorkflowFromAssets(opts) {
  if (opts.refVideo) return 'animate-move';
  if (opts.refAudio) return 's2v';
  if (opts.refImage || opts.refImageEnd) return 'i2v';
  return null;
}

function workflowRequiresImage(workflow) {
  return workflow === 'i2v' || workflow === 's2v' || workflow === 'animate-move' || workflow === 'animate-replace';
}

function normalizeSeedStrategy(value) {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === 'random') return 'random';
  if (normalized === 'prompt-hash' || normalized === 'prompt_hash') return 'prompt-hash';
  return null;
}

function generateRandomSeed() {
  return randomBytes(4).readUInt32BE(0);
}

function computePromptHashSeed(opts) {
  const payload = {
    prompt: opts.prompt || '',
    model: opts.model || '',
    workflow: opts.video ? opts.videoWorkflow : 'image',
    width: opts.width,
    height: opts.height,
    azimuth: opts.azimuth || '',
    elevation: opts.elevation || '',
    distance: opts.distance || '',
    angleDescription: opts.angleDescription || '',
    outputFormat: opts.outputFormat || '',
    sampler: opts.sampler || '',
    scheduler: opts.scheduler || '',
    loras: opts.loras || [],
    loraStrengths: opts.loraStrengths || [],
    refImage: opts.refImage || '',
    refImageEnd: opts.refImageEnd || '',
    refAudio: opts.refAudio || '',
    refVideo: opts.refVideo || '',
    contextImages: opts.contextImages || [],
    autoResizeVideoAssets: opts.autoResizeVideoAssets,
    tokenType: opts.tokenType || '',
    steps: opts.steps ?? null,
    guidance: opts.guidance ?? null
  };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest();
  return hash.readUInt32BE(0);
}

function parseCsv(value) {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parseNumberValue(raw, flagName) {
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    fatalCliError(`${flagName} must be a number.`, {
      code: 'INVALID_ARGUMENT',
      details: { flag: flagName, value: raw }
    });
  }
  return num;
}

function parseNumberList(raw, flagName) {
  const entries = parseCsv(raw);
  return entries.map((entry) => parseNumberValue(entry, flagName));
}

function getModelDefaults(modelId, config) {
  if (!modelId || !config?.modelDefaults) return null;
  const entry = config.modelDefaults[modelId];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
}

function formatTokenValue(value) {
  if (!Number.isFinite(value)) return 'unknown';
  return value.toFixed(2);
}

function inferDefaultVideoSteps(modelId) {
  const id = (modelId || '').toLowerCase();
  if (id.includes('lightx2v')) return 4;
  if (id.includes('lightning') || id.includes('turbo') || id.includes('lcm')) return 4;
  return 20;
}

function resolveVideoSteps(modelId, modelDefaults, explicitSteps) {
  if (Number.isFinite(explicitSteps)) return explicitSteps;
  if (Number.isFinite(modelDefaults?.steps)) return modelDefaults.steps;
  return inferDefaultVideoSteps(modelId);
}

function parseCostEstimate(estimate, tokenType) {
  if (!estimate) return null;
  const raw = tokenType === 'sogni'
    ? estimate.sogni ?? estimate.token
    : estimate.spark ?? estimate.token;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function buildBalanceError(message, details) {
  const err = new Error(message);
  err.code = 'INSUFFICIENT_BALANCE';
  err.details = details || null;
  return err;
}

function gcdInt(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function isHttpUrl(value) {
  return typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'));
}

function getPngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47 ||
    buffer[4] !== 0x0D || buffer[5] !== 0x0A || buffer[6] !== 0x1A || buffer[7] !== 0x0A
  ) {
    return null;
  }
  try {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height) return null;
    return { width, height, type: 'png' };
  } catch {
    return null;
  }
}

function getJpegDimensions(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // JPEG SOI: FF D8
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;

  // Walk segments until we find a Start Of Frame marker that contains dimensions.
  // Common SOF markers: C0 (baseline), C1, C2 (progressive), C3, C5-C7, C9-CB, CD-CF
  let i = 2;
  while (i + 9 < buffer.length) {
    // Find marker prefix 0xFF
    if (buffer[i] !== 0xFF) {
      i++;
      continue;
    }
    // Skip fill bytes 0xFF
    while (i < buffer.length && buffer[i] === 0xFF) i++;
    if (i >= buffer.length) break;
    const marker = buffer[i];
    i++;

    // Markers without a length field
    if (marker === 0xD9 || marker === 0xDA) break; // EOI or SOS
    if (marker >= 0xD0 && marker <= 0xD7) continue; // RSTn

    if (i + 1 >= buffer.length) break;
    const segmentLength = buffer.readUInt16BE(i);
    if (segmentLength < 2) break;
    const segmentStart = i + 2;

    const isSof =
      (marker >= 0xC0 && marker <= 0xC3) ||
      (marker >= 0xC5 && marker <= 0xC7) ||
      (marker >= 0xC9 && marker <= 0xCB) ||
      (marker >= 0xCD && marker <= 0xCF);

    if (isSof) {
      if (segmentStart + 7 >= buffer.length) break;
      try {
        const height = buffer.readUInt16BE(segmentStart + 1);
        const width = buffer.readUInt16BE(segmentStart + 3);
        if (!width || !height) return null;
        return { width, height, type: 'jpg' };
      } catch {
        return null;
      }
    }

    i = segmentStart + (segmentLength - 2);
  }

  return null;
}

function getImageDimensionsFromBuffer(buffer) {
  return getPngDimensions(buffer) || getJpegDimensions(buffer);
}

/**
 * Resizes an image buffer to the nearest div-16 dimensions that maintain aspect ratio.
 * Uses sharp's fit:inside to preserve aspect, then rounds to div-16.
 */
async function resizeImageBufferToDiv16(buffer, originalWidth, originalHeight) {
  // Calculate target div-16 dimensions that maintain aspect ratio
  const roundToDiv16 = (n) => Math.round(n / 16) * 16;
  const targetWidth = Math.max(MIN_VIDEO_DIMENSION, Math.min(MAX_VIDEO_DIMENSION, roundToDiv16(originalWidth)));
  const targetHeight = Math.max(MIN_VIDEO_DIMENSION, Math.min(MAX_VIDEO_DIMENSION, roundToDiv16(originalHeight)));

  // Resize using sharp with fit:inside (maintains aspect ratio)
  const resizedBuffer = await sharp(buffer)
    .resize(targetWidth, targetHeight, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();

  // Get actual dimensions after resize
  const metadata = await sharp(resizedBuffer).metadata();
  const actualWidth = roundToDiv16(metadata.width);
  const actualHeight = roundToDiv16(metadata.height);

  // If dimensions aren't exactly div-16, do a final resize/crop
  if (metadata.width !== actualWidth || metadata.height !== actualHeight) {
    return await sharp(resizedBuffer)
      .resize(actualWidth, actualHeight, { fit: 'cover' })
      .toBuffer();
  }

  return resizedBuffer;
}

const MIN_VIDEO_DIMENSION = 480;
const MAX_VIDEO_DIMENSION = 1536;
const VIDEO_DIMENSION_MULTIPLE = 16;

function normalizeVideoDimensionsLikeWrapper(width, height) {
  let targetWidth = Number(width);
  let targetHeight = Number(height);
  let adjusted = false;

  const effectiveMin = MIN_VIDEO_DIMENSION;

  if (!Number.isFinite(targetWidth) || !Number.isFinite(targetHeight)) {
    return { width: targetWidth, height: targetHeight, adjusted: false };
  }

  if (targetWidth > MAX_VIDEO_DIMENSION || targetHeight > MAX_VIDEO_DIMENSION) {
    const scaleFactor = Math.min(MAX_VIDEO_DIMENSION / targetWidth, MAX_VIDEO_DIMENSION / targetHeight);
    targetWidth = Math.floor(targetWidth * scaleFactor);
    targetHeight = Math.floor(targetHeight * scaleFactor);
    adjusted = true;
  }

  if (targetWidth < effectiveMin || targetHeight < effectiveMin) {
    const scaleFactor = Math.max(effectiveMin / targetWidth, effectiveMin / targetHeight);
    targetWidth = Math.floor(targetWidth * scaleFactor);
    targetHeight = Math.floor(targetHeight * scaleFactor);
    adjusted = true;
    if (targetWidth > MAX_VIDEO_DIMENSION || targetHeight > MAX_VIDEO_DIMENSION) {
      const downscaleFactor = Math.min(MAX_VIDEO_DIMENSION / targetWidth, MAX_VIDEO_DIMENSION / targetHeight);
      targetWidth = Math.floor(targetWidth * downscaleFactor);
      targetHeight = Math.floor(targetHeight * downscaleFactor);
    }
  }

  const roundedWidth = Math.floor(targetWidth / VIDEO_DIMENSION_MULTIPLE) * VIDEO_DIMENSION_MULTIPLE;
  const roundedHeight = Math.floor(targetHeight / VIDEO_DIMENSION_MULTIPLE) * VIDEO_DIMENSION_MULTIPLE;
  if (roundedWidth !== targetWidth || roundedHeight !== targetHeight) {
    adjusted = true;
  }
  targetWidth = roundedWidth;
  targetHeight = roundedHeight;

  if (targetWidth < effectiveMin) {
    targetWidth = Math.ceil(effectiveMin / VIDEO_DIMENSION_MULTIPLE) * VIDEO_DIMENSION_MULTIPLE;
    adjusted = true;
  }
  if (targetHeight < effectiveMin) {
    targetHeight = Math.ceil(effectiveMin / VIDEO_DIMENSION_MULTIPLE) * VIDEO_DIMENSION_MULTIPLE;
    adjusted = true;
  }

  return { width: targetWidth, height: targetHeight, adjusted };
}

function predictSharpInsideResizeDims(refWidth, refHeight, targetWidth, targetHeight) {
  const rw = Number(refWidth);
  const rh = Number(refHeight);
  const tw = Number(targetWidth);
  const th = Number(targetHeight);
  if (!Number.isFinite(rw) || !Number.isFinite(rh) || !Number.isFinite(tw) || !Number.isFinite(th) || rw <= 0 || rh <= 0 || tw <= 0 || th <= 0) {
    return null;
  }

  // Matches sharp(vips) behavior in SogniClientWrapper.resizeImageBuffer(..., fit: 'inside'):
  // Choose limiting dimension; keep it exact; compute the other dimension with Math.round().
  const scaleW = tw / rw;
  const scaleH = th / rh;
  const widthLimited = scaleW <= scaleH;
  if (widthLimited) {
    return { width: tw, height: Math.round(rh * tw / rw) };
  }
  return { width: Math.round(rw * th / rh), height: th };
}

function pickCompatibleI2vBoundingBox(refWidth, refHeight, desiredWidth, desiredHeight, { allowImperfect = false } = {}) {
  const desiredW = Number.isFinite(Number(desiredWidth)) ? Number(desiredWidth) : 512;
  const desiredH = Number.isFinite(Number(desiredHeight)) ? Number(desiredHeight) : 512;
  const desiredMax = Math.max(MIN_VIDEO_DIMENSION, Math.min(MAX_VIDEO_DIMENSION, Math.max(desiredW, desiredH)));
  let best = null;
  let bestImperfect = null;

  for (let w = MIN_VIDEO_DIMENSION; w <= MAX_VIDEO_DIMENSION; w += VIDEO_DIMENSION_MULTIPLE) {
    for (let h = MIN_VIDEO_DIMENSION; h <= MAX_VIDEO_DIMENSION; h += VIDEO_DIMENSION_MULTIPLE) {
      const normalized = normalizeVideoDimensionsLikeWrapper(w, h);
      if (!Number.isFinite(normalized.width) || !Number.isFinite(normalized.height)) continue;
      const out = predictSharpInsideResizeDims(refWidth, refHeight, normalized.width, normalized.height);
      if (!out) continue;
      // Require both output dimensions >= MIN_VIDEO_DIMENSION for API compatibility
      if (out.width < MIN_VIDEO_DIMENSION || out.height < MIN_VIDEO_DIMENSION) continue;

      const isPerfect = out.width % VIDEO_DIMENSION_MULTIPLE === 0 && out.height % VIDEO_DIMENSION_MULTIPLE === 0;

      const outMax = Math.max(out.width, out.height);
      const distance = Math.abs(normalized.width - desiredW) + Math.abs(normalized.height - desiredH);
      // Prefer a bounding box close to what the user asked for, then output close to requested max, then maximize output area.
      const score = -distance * 1e9 - Math.abs(outMax - desiredMax) * 1e8 + out.width * out.height * 1e3 - (normalized.width * normalized.height);

      if (isPerfect) {
        if (!best || score > best.score) {
          best = { width: normalized.width, height: normalized.height, output: out, score, perfect: true };
        }
      } else if (allowImperfect) {
        // Track imperfect candidates: prefer those closest to div-16
        const widthRemainder = out.width % VIDEO_DIMENSION_MULTIPLE;
        const heightRemainder = out.height % VIDEO_DIMENSION_MULTIPLE;
        const div16Distance = Math.min(widthRemainder, VIDEO_DIMENSION_MULTIPLE - widthRemainder) +
                            Math.min(heightRemainder, VIDEO_DIMENSION_MULTIPLE - heightRemainder);
        const imperfectScore = -div16Distance * 1e10 + score;
        if (!bestImperfect || imperfectScore > bestImperfect.score) {
          // Calculate adjusted output dimensions (rounded to div-16)
          const adjustedWidth = Math.round(out.width / VIDEO_DIMENSION_MULTIPLE) * VIDEO_DIMENSION_MULTIPLE;
          const adjustedHeight = Math.round(out.height / VIDEO_DIMENSION_MULTIPLE) * VIDEO_DIMENSION_MULTIPLE;
          bestImperfect = {
            width: normalized.width,
            height: normalized.height,
            output: out,
            adjustedOutput: { width: adjustedWidth, height: adjustedHeight },
            score: imperfectScore,
            perfect: false
          };
        }
      }
    }
  }

  return best || (allowImperfect ? bestImperfect : null);
}

const MULTI_ANGLE_AZIMUTHS = [
  { key: 'front', prompt: 'front view' },
  { key: 'front-right', prompt: 'front-right quarter view' },
  { key: 'right', prompt: 'right side view' },
  { key: 'back-right', prompt: 'back-right quarter view' },
  { key: 'back', prompt: 'back view' },
  { key: 'back-left', prompt: 'back-left quarter view' },
  { key: 'left', prompt: 'left side view' },
  { key: 'front-left', prompt: 'front-left quarter view' }
];

const MULTI_ANGLE_ELEVATIONS = [
  { key: 'low-angle', prompt: 'low-angle shot' },
  { key: 'eye-level', prompt: 'eye-level shot' },
  { key: 'elevated', prompt: 'elevated shot' },
  { key: 'high-angle', prompt: 'high-angle shot' }
];

const MULTI_ANGLE_DISTANCES = [
  { key: 'close-up', prompt: 'close-up' },
  { key: 'medium', prompt: 'medium shot' },
  { key: 'wide', prompt: 'wide shot' }
];

const MULTI_ANGLE_AZIMUTH_ALIASES = new Map([
  ['front-right quarter', 'front-right'],
  ['front right quarter', 'front-right'],
  ['back-right quarter', 'back-right'],
  ['back right quarter', 'back-right'],
  ['back-left quarter', 'back-left'],
  ['back left quarter', 'back-left'],
  ['front-left quarter', 'front-left'],
  ['front left quarter', 'front-left']
]);

const MULTI_ANGLE_ELEVATION_ALIASES = new Map([
  ['low angle', 'low-angle'],
  ['eye level', 'eye-level'],
  ['high angle', 'high-angle']
]);

const MULTI_ANGLE_DISTANCE_ALIASES = new Map([
  ['close up', 'close-up'],
  ['medium shot', 'medium'],
  ['wide shot', 'wide']
]);

function normalizeMultiAngleValue(value, aliases, allowedKeys, label) {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/_/g, '-').replace(/\s+/g, ' ').trim();
  const aliased = aliases.get(normalized) || normalized;
  if (!allowedKeys.includes(aliased)) {
    fatalCliError(`Invalid ${label} "${value}".`, {
      code: 'INVALID_ARGUMENT',
      details: { field: label, value, allowed: allowedKeys }
    });
  }
  return aliased;
}

function buildMultiAnglePrompt({ azimuth, elevation, distance, description }) {
  const azimuthPrompt = MULTI_ANGLE_AZIMUTHS.find((a) => a.key === azimuth)?.prompt;
  const elevationPrompt = MULTI_ANGLE_ELEVATIONS.find((e) => e.key === elevation)?.prompt;
  const distancePrompt = MULTI_ANGLE_DISTANCES.find((d) => d.key === distance)?.prompt;
  const parts = ['<sks>', azimuthPrompt, elevationPrompt, distancePrompt].filter(Boolean);
  if (description) parts.push(description);
  return parts.join(' ');
}

function loadOpenClawPluginConfig() {
  if (process.env.OPENCLAW_PLUGIN_CONFIG) {
    try {
      return JSON5.parse(process.env.OPENCLAW_PLUGIN_CONFIG);
    } catch (e) {
      return null;
    }
  }
  if (!existsSync(OPENCLAW_CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    const parsed = JSON5.parse(raw);
    return parsed?.plugins?.entries?.['sogni-gen']?.config || null;
  } catch (e) {
    return null;
  }
}

// Parse arguments
const args = process.argv.slice(2);
const options = {
  prompt: null,
  output: null,
  model: null, // Will be set based on type
  width: 512,
  height: 512,
  count: 1,
  json: false,
  quiet: false,
  timeout: 30000,
  strictSize: false,
  tokenType: null,
  steps: null,
  guidance: null,
  outputFormat: null,
  sampler: null,
  scheduler: null,
  loras: [],
  loraStrengths: [],
  multiAngle: false,
  angles360: false,
  azimuth: 'front',
  elevation: 'eye-level',
  distance: 'medium',
  angleStrength: null,
  angleDescription: '',
  seed: null,
  lastSeed: false,
  seedStrategy: null,
  video: false,
  videoWorkflow: null,
  fps: 16,
  duration: 5,
  frames: null,
  autoResizeVideoAssets: null,
  estimateVideoCost: false,
  showBalance: false,
  angles360Video: null,
  refImage: null, // Reference image for video (start frame)
  refImageEnd: null, // End frame for video interpolation
  refAudio: null, // Reference audio for s2v
  refVideo: null, // Reference video for animate workflows
  contextImages: [], // Context images for image editing
  looping: false, // Create looping video (i2v only): generate A→B then B→A and concatenate
  photobooth: false, // Photobooth mode (InstantID face transfer)
  cnStrength: null, // ControlNet strength override
  cnGuidanceEnd: null // ControlNet guidance end override
};
const cliSet = {
  output: false,
  model: false,
  width: false,
  height: false,
  count: false,
  timeout: false,
  strictSize: false,
  tokenType: false,
  steps: false,
  guidance: false,
  outputFormat: false,
  sampler: false,
  scheduler: false,
  loras: false,
  loraStrengths: false,
  multiAngle: false,
  azimuth: false,
  elevation: false,
  distance: false,
  angleStrength: false,
  angleDescription: false,
  seed: false,
  seedStrategy: false,
  video: false,
  workflow: false,
  fps: false,
  duration: false,
  frames: false,
  autoResizeVideoAssets: false,
  angles360Video: false,
  refImage: false,
  refImageEnd: false,
  refAudio: false,
  refVideo: false,
  context: false,
  photobooth: false,
  cnStrength: false,
  cnGuidanceEnd: false
};

// Parse CLI args
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-o' || arg === '--output') {
    options.output = args[++i];
    cliSet.output = true;
  } else if (arg === '-m' || arg === '--model') {
    options.model = args[++i];
    cliSet.model = true;
  } else if (arg === '-w' || arg === '--width') {
    options.width = parseInt(args[++i]);
    cliSet.width = true;
  } else if (arg === '-h' || arg === '--height') {
    options.height = parseInt(args[++i]);
    cliSet.height = true;
  } else if (arg === '-n' || arg === '--count') {
    options.count = parseInt(args[++i]);
    cliSet.count = true;
  } else if (arg === '-t' || arg === '--timeout') {
    options.timeout = parseInt(args[++i]) * 1000;
    cliSet.timeout = true;
  } else if (arg === '--token-type' || arg === '--token') {
    options.tokenType = args[++i];
    cliSet.tokenType = true;
  } else if (arg === '--steps') {
    options.steps = parseInt(args[++i]);
    cliSet.steps = true;
  } else if (arg === '--guidance') {
    options.guidance = parseFloat(args[++i]);
    cliSet.guidance = true;
  } else if (arg === '--output-format' || arg === '--format') {
    options.outputFormat = args[++i];
    cliSet.outputFormat = true;
  } else if (arg === '--sampler') {
    options.sampler = args[++i];
    cliSet.sampler = true;
  } else if (arg === '--scheduler') {
    options.scheduler = args[++i];
    cliSet.scheduler = true;
  } else if (arg === '--multi-angle' || arg === '--multiple-angles') {
    options.multiAngle = true;
    cliSet.multiAngle = true;
  } else if (arg === '--angles-360') {
    options.angles360 = true;
    options.multiAngle = true;
    cliSet.multiAngle = true;
  } else if (arg === '--angles-360-video') {
    options.angles360Video = true;
    cliSet.angles360Video = true;
    if (args[i + 1] && !args[i + 1].startsWith('-')) {
      options.angles360Video = args[++i];
    }
  } else if (arg === '--video-model' || arg === '--i2v-model') {
    options.videoModel = args[++i];
    cliSet.videoModel = true;
  } else if (arg === '--azimuth') {
    options.azimuth = args[++i];
    cliSet.azimuth = true;
  } else if (arg === '--elevation') {
    options.elevation = args[++i];
    cliSet.elevation = true;
  } else if (arg === '--distance') {
    options.distance = args[++i];
    cliSet.distance = true;
  } else if (arg === '--angle-strength' || arg === '--strength') {
    options.angleStrength = parseNumberValue(args[++i], '--angle-strength');
    cliSet.angleStrength = true;
  } else if (arg === '--angle-description' || arg === '--angle-anchor' || arg === '--description' || arg === '--anchor') {
    options.angleDescription = args[++i];
    cliSet.angleDescription = true;
  } else if (arg === '--lora' || arg === '--lora-model') {
    options.loras.push(args[++i]);
    cliSet.loras = true;
  } else if (arg === '--loras') {
    options.loras.push(...parseCsv(args[++i]));
    cliSet.loras = true;
  } else if (arg === '--lora-strength') {
    options.loraStrengths.push(parseNumberValue(args[++i], '--lora-strength'));
    cliSet.loraStrengths = true;
  } else if (arg === '--lora-strengths') {
    options.loraStrengths.push(...parseNumberList(args[++i], '--lora-strengths'));
    cliSet.loraStrengths = true;
  } else if (arg === '-s' || arg === '--seed') {
    options.seed = parseInt(args[++i]);
    cliSet.seed = true;
  } else if (arg === '--seed-strategy') {
    options.seedStrategy = args[++i];
    cliSet.seedStrategy = true;
  } else if (arg === '--last-seed' || arg === '--reseed') {
    options.lastSeed = true;
  } else if (arg === '--video' || arg === '-v') {
    options.video = true;
    cliSet.video = true;
  } else if (arg === '--workflow') {
    options.videoWorkflow = args[++i];
    cliSet.workflow = true;
  } else if (arg === '--fps') {
    options.fps = parseInt(args[++i]);
    cliSet.fps = true;
  } else if (arg === '--duration') {
    options.duration = parseInt(args[++i]);
    cliSet.duration = true;
  } else if (arg === '--frames') {
    options.frames = parseInt(args[++i]);
    cliSet.frames = true;
  } else if (arg === '--auto-resize-assets') {
    options.autoResizeVideoAssets = true;
    cliSet.autoResizeVideoAssets = true;
  } else if (arg === '--no-auto-resize-assets') {
    options.autoResizeVideoAssets = false;
    cliSet.autoResizeVideoAssets = true;
  } else if (arg === '--ref' || arg === '--reference') {
    options.refImage = args[++i];
    cliSet.refImage = true;
  } else if (arg === '--ref-end' || arg === '--end') {
    options.refImageEnd = args[++i];
    cliSet.refImageEnd = true;
  } else if (arg === '--ref-audio' || arg === '--audio') {
    options.refAudio = args[++i];
    cliSet.refAudio = true;
  } else if (arg === '--ref-video') {
    options.refVideo = args[++i];
    cliSet.refVideo = true;
  } else if (arg === '--looping' || arg === '--loop') {
    options.looping = true;
    cliSet.looping = true;
  } else if (arg === '-c' || arg === '--context') {
    options.contextImages.push(args[++i]);
    cliSet.context = true;
  } else if (arg === '--photobooth') {
    options.photobooth = true;
    cliSet.photobooth = true;
  } else if (arg === '--cn-strength') {
    options.cnStrength = parseFloat(args[++i]);
    cliSet.cnStrength = true;
  } else if (arg === '--cn-guidance-end') {
    options.cnGuidanceEnd = parseFloat(args[++i]);
    cliSet.cnGuidanceEnd = true;
  } else if (arg === '--last-image') {
    // Use image from last render as reference/context
    if (existsSync(LAST_RENDER_PATH)) {
      const lastRender = JSON.parse(readFileSync(LAST_RENDER_PATH, 'utf8'));
      let lastImagePath = null;
      if (lastRender.localPath && existsSync(lastRender.localPath)) {
        lastImagePath = lastRender.localPath;
      } else if (lastRender.urls?.[0]) {
        lastImagePath = lastRender.urls[0];
      }
      if (lastImagePath) {
        // Will be resolved later: video uses refImage, image editing uses contextImages
        options._lastImagePath = lastImagePath;
      }
    }
  } else if (arg === '--last') {
    // Show last render info
    if (existsSync(LAST_RENDER_PATH)) {
      console.log(readFileSync(LAST_RENDER_PATH, 'utf8'));
    } else {
      console.error('No previous render found.');
    }
    process.exit(0);
  } else if (arg === '--json') {
    options.json = true;
  } else if (arg === '--strict-size') {
    options.strictSize = true;
    cliSet.strictSize = true;
  } else if (arg === '-q' || arg === '--quiet') {
    options.quiet = true;
  } else if (arg === '--estimate-video-cost') {
    options.estimateVideoCost = true;
  } else if (arg === '--balance' || arg === '--balances') {
    options.showBalance = true;
  } else if (arg === '--help') {
    console.log(`
sogni-gen - Generate images and videos using Sogni AI

Usage: sogni-gen [options] "prompt"

Image Options:
  -o, --output <path>   Save to file (otherwise prints URL)
  -m, --model <id>      Model (default: z_image_turbo_bf16)
  -w, --width <px>      Width (default: 512)
  -h, --height <px>     Height (default: 512)
  -n, --count <num>     Number of images (default: 1)
  -s, --seed <num>      Use specific seed
  --last-seed           Reuse seed from previous render
  --seed-strategy <s>   Seed strategy: random|prompt-hash
  --multi-angle         Multiple angles LoRA mode (Qwen Image Edit)
  --angles-360          Generate 8 azimuths (front -> front-left)
  --angles-360-video [path]  Assemble a looping 360 mp4 using i2v between angles (requires ffmpeg)
  --video-model <id>    Override i2v model for 360 video (e.g. wan_v2.2-14b-fp8_i2v for higher quality)
  --azimuth <key>       front|front-right|right|back-right|back|back-left|left|front-left
  --elevation <key>     low-angle|eye-level|elevated|high-angle
  --distance <key>      close-up|medium|wide
  --angle-strength <n>  LoRA strength for multiple_angles (default: 0.9)
  --angle-description <text>  Optional subject description
  --output-format <f>   Image output format: png|jpg
  --sampler <name>      Sampler (model-dependent)
  --scheduler <name>    Scheduler (model-dependent)
  --lora <id>           LoRA id (repeatable, edit only)
  --loras <ids>         Comma-separated LoRA ids
  --lora-strength <n>   LoRA strength (repeatable)
  --lora-strengths <n>  Comma-separated LoRA strengths
  -c, --context <path>  Context image for editing (can use multiple)
  --last-image          Use last generated image as context

Photobooth (Face Transfer):
  --photobooth            Face transfer mode (InstantID + SDXL Turbo)
  --ref <path|url>        Face image (required with --photobooth)
  --cn-strength <n>       ControlNet strength (default: 0.8)
  --cn-guidance-end <n>   ControlNet guidance end point (default: 0.3)

Video Options:
  --video, -v           Generate video instead of image
  --workflow <type>     Video workflow: t2v|i2v|s2v|animate-move|animate-replace
  --fps <num>           Frames per second (default: 16)
  --duration <sec>      Duration in seconds (default: 5)
  --frames <num>        Override total frames (optional)
  --auto-resize-assets  Auto-resize video reference assets (default)
  --no-auto-resize-assets  Disable auto-resize for video assets
  --estimate-video-cost Estimate video cost and exit (requires --steps)
  --ref <path|url>      Reference image for video (start frame)
  --ref-end <path|url>  End frame for interpolation/morphing
  --ref-audio <path>    Reference audio for s2v
  --ref-video <path>    Reference video for animate workflows
  --looping, --loop     Create seamless loop (i2v only): A→B→A
  --last-image          Use last generated image as reference

General:
  -t, --timeout <sec>   Timeout in seconds (default: 30, video: 300)
  --steps <num>         Override steps (model-dependent)
  --guidance <num>      Override guidance (model-dependent)
  --token-type <type>   Token type: spark|sogni (default: spark)
  --balance, --balances Show SPARK/SOGNI balances and exit
  --last                Show last render info (JSON)
  --json                Output JSON with all details
  --strict-size         Do not auto-adjust video size to satisfy i2v reference resizing constraints
  -q, --quiet           Suppress progress output

Image Models:
  z_image_turbo_bf16              Fast, general purpose (default)
  flux1-schnell-fp8               Very fast
  flux2_dev_fp8                   High quality (slow)
  qwen_image_edit_2511_fp8        Image editing with context (up to 3 images)
  qwen_image_edit_2511_fp8_lightning  Fast image editing

Video Models:
  wan_v2.2-14b-fp8_t2v_lightx2v   Text-to-video (fast)
  wan_v2.2-14b-fp8_i2v_lightx2v   Fast (default)
  wan_v2.2-14b-fp8_i2v            Higher quality
  wan_v2.2-14b-fp8_s2v_lightx2v   Sound-to-video (fast)
  wan_v2.2-14b-fp8_s2v            Sound-to-video (quality)
  wan_v2.2-14b-fp8_animate-move_lightx2v     Animate-move (fast)
  wan_v2.2-14b-fp8_animate-replace_lightx2v  Animate-replace (fast)

Examples:
  sogni-gen "a cat wearing a hat"
  sogni-gen -o cat.jpg "a cat" 
  sogni-gen --multi-angle -c subject.jpg --azimuth front-right --elevation eye-level --distance medium "studio portrait"
  sogni-gen --angles-360 -c subject.jpg "studio portrait"
  sogni-gen --video --ref cat.jpg -o cat.mp4 "cat walks around"
  sogni-gen --video "ocean waves at sunset"
  sogni-gen --video --ref cat.jpg --ref-audio speech.m4a -m wan_v2.2-14b-fp8_s2v_lightx2v "lip sync"
  sogni-gen --video --ref subject.jpg --ref-video motion.mp4 --workflow animate-move "transfer motion"
  sogni-gen --video --last-image "gentle camera pan"
  sogni-gen -c photo.jpg "make the background a beach" -m qwen_image_edit_2511_fp8
  sogni-gen -c subject.jpg -c style.jpg "apply the style to the subject"
  sogni-gen --photobooth --ref face.jpg "80s fashion portrait"
  sogni-gen --photobooth --ref face.jpg -n 4 "LinkedIn professional headshot"
`);
    process.exit(0);
  } else if (!arg.startsWith('-') && !options.prompt) {
    options.prompt = arg;
  }
}

const openclawConfig = loadOpenClawPluginConfig();
let timeoutFromConfig = false;
if (openclawConfig) {
  const isNumber = (value) => Number.isFinite(value);
  if (!cliSet.width && isNumber(openclawConfig.defaultWidth)) {
    options.width = openclawConfig.defaultWidth;
  }
  if (!cliSet.height && isNumber(openclawConfig.defaultHeight)) {
    options.height = openclawConfig.defaultHeight;
  }
  if (!cliSet.count && isNumber(openclawConfig.defaultCount)) {
    options.count = openclawConfig.defaultCount;
  }
  if (!cliSet.tokenType && openclawConfig.defaultTokenType) {
    options.tokenType = openclawConfig.defaultTokenType;
  }
  if (!cliSet.seedStrategy && openclawConfig.seedStrategy) {
    options.seedStrategy = openclawConfig.seedStrategy;
  }
  if (options.video) {
    if (!cliSet.workflow && openclawConfig.defaultVideoWorkflow) {
      options.videoWorkflow = openclawConfig.defaultVideoWorkflow;
    }
    if (!cliSet.fps && isNumber(openclawConfig.defaultFps)) {
      options.fps = openclawConfig.defaultFps;
    }
    if (!cliSet.frames && !cliSet.duration && isNumber(openclawConfig.defaultDurationSec)) {
      options.duration = openclawConfig.defaultDurationSec;
    }
    if (!cliSet.timeout && isNumber(openclawConfig.defaultVideoTimeoutSec)) {
      options.timeout = openclawConfig.defaultVideoTimeoutSec * 1000;
      timeoutFromConfig = true;
    }
  } else if (!cliSet.timeout && isNumber(openclawConfig.defaultImageTimeoutSec)) {
    options.timeout = openclawConfig.defaultImageTimeoutSec * 1000;
    timeoutFromConfig = true;
  }
}

if (options.tokenType) {
  const token = options.tokenType.toLowerCase();
  if (token !== 'spark' && token !== 'sogni') {
    fatalCliError('--token-type must be "spark" or "sogni".', {
      code: 'INVALID_ARGUMENT',
      details: { flag: '--token-type', value: options.tokenType }
    });
  }
  options.tokenType = token;
}

if (options.seedStrategy) {
  const normalizedStrategy = normalizeSeedStrategy(options.seedStrategy);
  if (!normalizedStrategy) {
    fatalCliError('--seed-strategy must be "random" or "prompt-hash".', {
      code: 'INVALID_ARGUMENT',
      details: { flag: '--seed-strategy', value: options.seedStrategy }
    });
  }
  options.seedStrategy = normalizedStrategy;
}

if (cliSet.steps && !Number.isFinite(options.steps)) {
  fatalCliError('--steps must be a number.', {
    code: 'INVALID_ARGUMENT',
    details: { flag: '--steps', value: options.steps }
  });
}

if (cliSet.guidance && !Number.isFinite(options.guidance)) {
  fatalCliError('--guidance must be a number.', {
    code: 'INVALID_ARGUMENT',
    details: { flag: '--guidance', value: options.guidance }
  });
}

if (options.multiAngle) {
  if (options.video) {
    fatalCliError('--multi-angle is only for image editing.', { code: 'INVALID_ARGUMENT' });
  }
  if (options.angles360Video && !options.angles360) {
    fatalCliError('--angles-360-video requires --angles-360.', { code: 'INVALID_ARGUMENT' });
  }
  if (options.angles360Video && options.count !== 1) {
    fatalCliError('--angles-360-video requires --count 1.', {
      code: 'INVALID_ARGUMENT',
      details: { count: options.count }
    });
  }
  if (options._lastImagePath && options.contextImages.length === 0) {
    options.contextImages.push(options._lastImagePath);
    delete options._lastImagePath;
  }
  if (options.contextImages.length === 0) {
    fatalCliError('--multi-angle requires a reference image (--context or --last-image).', {
      code: 'INVALID_ARGUMENT'
    });
  }
  const azimuthKeys = MULTI_ANGLE_AZIMUTHS.map((a) => a.key);
  const elevationKeys = MULTI_ANGLE_ELEVATIONS.map((e) => e.key);
  const distanceKeys = MULTI_ANGLE_DISTANCES.map((d) => d.key);

  if (!options.angles360) {
    options.azimuth = normalizeMultiAngleValue(options.azimuth, MULTI_ANGLE_AZIMUTH_ALIASES, azimuthKeys, 'azimuth');
  } else if (!options.quiet && cliSet.azimuth) {
    console.error('Warning: --azimuth ignored for --angles-360.');
  }
  options.elevation = normalizeMultiAngleValue(options.elevation, MULTI_ANGLE_ELEVATION_ALIASES, elevationKeys, 'elevation');
  options.distance = normalizeMultiAngleValue(options.distance, MULTI_ANGLE_DISTANCE_ALIASES, distanceKeys, 'distance');

  if (options.model && !options.model.includes('qwen_image_edit_2511')) {
    fatalCliError('--multi-angle requires a Qwen Image Edit 2511 model.', {
      code: 'INVALID_ARGUMENT',
      details: { model: options.model }
    });
  }
  if (!options.model) {
    options.model = 'qwen_image_edit_2511_fp8_lightning';
  }
  if (!options.outputFormat) {
    options.outputFormat = 'jpg';
  }
  if (!options.sampler) {
    options.sampler = 'euler';
  }
  if (!options.scheduler) {
    options.scheduler = 'simple';
  }
  if (!options.angleDescription && options.prompt) {
    options.angleDescription = options.prompt;
  }
  if (options.loras.length === 0 && options.loraStrengths.length > 0) {
    if (options.loraStrengths.length > 1) {
      fatalCliError('--lora-strengths requires explicit --loras when using --multi-angle.', {
        code: 'INVALID_ARGUMENT'
      });
    }
    if (options.angleStrength === null || options.angleStrength === undefined) {
      options.angleStrength = options.loraStrengths[0];
    }
    options.loraStrengths = [];
  }
  if (!cliSet.guidance && (options.guidance === null || options.guidance === undefined)) {
    options.guidance = options.model.includes('lightning') ? 1.0 : 4.0;
  }
  if (options.angleStrength === null || options.angleStrength === undefined) {
    options.angleStrength = 0.9;
  }

  const multiAngleStrength = options.angleStrength;
  let multiAngleIndex = options.loras.indexOf('multiple_angles');
  if (multiAngleIndex === -1) {
    options.loras.push('multiple_angles');
    multiAngleIndex = options.loras.length - 1;
    if (options.loraStrengths.length > 0) {
      options.loraStrengths.push(multiAngleStrength);
    }
  }

  if (options.loraStrengths.length === 0 && options.loras.length > 0) {
    options.loraStrengths = options.loras.map((id) => (id === 'multiple_angles' ? multiAngleStrength : 1.0));
  } else if (options.loraStrengths.length === options.loras.length) {
    if (options.loraStrengths[multiAngleIndex] === undefined || options.loraStrengths[multiAngleIndex] === null) {
      options.loraStrengths[multiAngleIndex] = multiAngleStrength;
    }
  }
}

if (options.outputFormat) {
  const normalized = options.outputFormat.toLowerCase();
  options.outputFormat = normalized === 'jpeg' ? 'jpg' : normalized;
  if (options.video) {
    if (options.outputFormat !== 'mp4') {
      fatalCliError('Video output format must be "mp4".', {
        code: 'INVALID_ARGUMENT',
        details: { outputFormat: options.outputFormat }
      });
    }
  } else if (!['png', 'jpg'].includes(options.outputFormat)) {
    fatalCliError('Image output format must be "png" or "jpg".', {
      code: 'INVALID_ARGUMENT',
      details: { outputFormat: options.outputFormat }
    });
  }
}

if (options.loraStrengths.length > 0 && options.loras.length === 0) {
  fatalCliError('--lora-strength requires at least one --lora.', { code: 'INVALID_ARGUMENT' });
}

if (options.loraStrengths.length > 0 && options.loras.length > 0 &&
    options.loraStrengths.length !== options.loras.length) {
  fatalCliError('--lora-strengths count must match --loras count.', {
    code: 'INVALID_ARGUMENT',
    details: { loras: options.loras.length, loraStrengths: options.loraStrengths.length }
  });
}

if (options.video && options.loras.length > 0) {
  fatalCliError('--lora options are image-only.', { code: 'INVALID_ARGUMENT' });
}

if (options.video && (options.sampler || options.scheduler)) {
  fatalCliError('--sampler/--scheduler are image-only options.', { code: 'INVALID_ARGUMENT' });
}

if (!options.video && options.autoResizeVideoAssets !== null) {
  fatalCliError('--auto-resize-assets is only valid with --video.', { code: 'INVALID_ARGUMENT' });
}

if (options.estimateVideoCost && !options.video) {
  fatalCliError('--estimate-video-cost requires --video.', { code: 'INVALID_ARGUMENT' });
}

if (options.angles360Video && !options.angles360) {
  fatalCliError('--angles-360-video requires --angles-360.', { code: 'INVALID_ARGUMENT' });
}

// Normalize/validate video workflow before applying defaults
if (options.video) {
  if (options.videoWorkflow) {
    const normalized = normalizeVideoWorkflow(options.videoWorkflow);
    if (!normalized) {
      fatalCliError(`Unknown workflow "${options.videoWorkflow}". Use t2v|i2v|s2v|animate-move|animate-replace.`, {
        code: 'INVALID_ARGUMENT',
        details: { workflow: options.videoWorkflow }
      });
    }
    options.videoWorkflow = normalized;
  }

  const workflowFromModel = inferVideoWorkflowFromModel(options.model);
  if (options.videoWorkflow && workflowFromModel && options.videoWorkflow !== workflowFromModel) {
    fatalCliError(`Workflow "${options.videoWorkflow}" does not match model "${options.model}".`, {
      code: 'INVALID_ARGUMENT',
      details: { workflow: options.videoWorkflow, model: options.model }
    });
  }
  if (!options.videoWorkflow) {
    options.videoWorkflow = workflowFromModel || inferVideoWorkflowFromAssets(options) || openclawConfig?.defaultVideoWorkflow || 't2v';
  }
}

// Resolve --last-image after workflow is known
if (options._lastImagePath) {
  if (options.video) {
    if (workflowRequiresImage(options.videoWorkflow)) {
      if (!options.refImage) options.refImage = options._lastImagePath;
    } else if (!options.quiet) {
      console.error('Warning: --last-image ignored for text-to-video workflow.');
    }
  } else if (options.photobooth) {
    if (!options.refImage) options.refImage = options._lastImagePath;
  } else {
    options.contextImages.push(options._lastImagePath);
  }
  delete options._lastImagePath;
}

// Set defaults based on type and context
if (options.video) {
  const cfgVideoModels = openclawConfig?.videoModels || {};
  const cfgModel = options.videoWorkflow ? cfgVideoModels[options.videoWorkflow] : null;
  options.model = options.model || cfgModel || VIDEO_WORKFLOW_DEFAULT_MODELS[options.videoWorkflow] || 'wan_v2.2-14b-fp8_i2v_lightx2v';
  if (!cliSet.timeout && !timeoutFromConfig && options.timeout === 30000) {
    options.timeout = 300000; // 5 min for video
  }
} else if (options.photobooth) {
  // Photobooth uses SDXL Turbo + InstantID ControlNet
  options.model = options.model || openclawConfig?.defaultPhotoboothModel || 'coreml-sogniXLturbo_alpha1_ad';
  if (!cliSet.width) options.width = 1024;
  if (!cliSet.height) options.height = 1024;
  if (!cliSet.timeout && !timeoutFromConfig && options.timeout === 30000) {
    options.timeout = 60000;
  }
} else if (options.contextImages.length > 0) {
  // Use qwen edit model when context images provided (unless model explicitly set)
  options.model = options.model || openclawConfig?.defaultEditModel || 'qwen_image_edit_2511_fp8_lightning';
  if (!cliSet.timeout && !timeoutFromConfig && options.timeout === 30000) {
    options.timeout = 60000; // 1 min for editing
  }
} else {
  options.model = options.model || openclawConfig?.defaultImageModel || 'z_image_turbo_bf16';
}

if (!options.prompt && !options.estimateVideoCost && !options.multiAngle && !options.showBalance) {
  fatalCliError('No prompt provided. Use --help for usage.', { code: 'INVALID_ARGUMENT' });
}

if (!options.video && (options.refAudio || options.refVideo || options.videoWorkflow || options.frames)) {
  fatalCliError('Video-only options (--workflow/--frames/--ref-audio/--ref-video) require --video.', {
    code: 'INVALID_ARGUMENT'
  });
}

if (options.photobooth) {
  if (!options.refImage) {
    fatalCliError('--photobooth requires --ref <face-image>.', { code: 'INVALID_ARGUMENT' });
  }
  if (options.video) {
    fatalCliError('--photobooth cannot be combined with --video.', { code: 'INVALID_ARGUMENT' });
  }
  if (options.contextImages.length > 0) {
    fatalCliError('--photobooth cannot be combined with -c/--context.', { code: 'INVALID_ARGUMENT' });
  }
}

if (options.video) {
  if (options.videoWorkflow === 't2v') {
    if (options.refImage || options.refImageEnd || options.refAudio || options.refVideo) {
      fatalCliError('t2v does not accept reference image/audio/video.', {
        code: 'INVALID_ARGUMENT'
      });
    }
  } else if (options.videoWorkflow === 'i2v') {
    if (!options.refImage && !options.refImageEnd) {
      fatalCliError('i2v requires --ref and/or --ref-end.', { code: 'INVALID_ARGUMENT' });
    }
    if (options.refAudio || options.refVideo) {
      fatalCliError('i2v does not accept reference audio/video.', { code: 'INVALID_ARGUMENT' });
    }
  } else if (options.videoWorkflow === 's2v') {
    if (!options.refImage || !options.refAudio) {
      fatalCliError('s2v requires both --ref and --ref-audio.', { code: 'INVALID_ARGUMENT' });
    }
    if (options.refVideo) {
      fatalCliError('s2v does not accept reference video.', { code: 'INVALID_ARGUMENT' });
    }
  } else if (options.videoWorkflow === 'animate-move' || options.videoWorkflow === 'animate-replace') {
    if (!options.refImage || !options.refVideo) {
      fatalCliError('animate workflows require both --ref and --ref-video.', { code: 'INVALID_ARGUMENT' });
    }
    if (options.refAudio) {
      fatalCliError('animate workflows do not accept reference audio.', { code: 'INVALID_ARGUMENT' });
    }
  }

  // Validate looping flag
  if (options.looping) {
    if (!options.video) {
      fatalCliError('--looping requires --video.', { code: 'INVALID_ARGUMENT' });
    }
    if (options.videoWorkflow !== 'i2v') {
      fatalCliError('--looping is only supported with i2v workflow.', { code: 'INVALID_ARGUMENT' });
    }
    if (!options.refImage) {
      fatalCliError('--looping requires --ref (reference image).', { code: 'INVALID_ARGUMENT' });
    }
    if (options.refImageEnd) {
      fatalCliError('--looping cannot be used with --ref-end (end frame is auto-generated).', { code: 'INVALID_ARGUMENT' });
    }
  }
}

// Video dimensions:
// - Sogni video pipelines require dims within [480..1536] and divisible by 16.
// - When using i2v (or any ref-based workflow), the Sogni client wrapper will *resize the reference image*
//   with sharp `fit: inside` and then override the project width/height with the resized reference dims.
//   That means a "valid" requested size can still fail if the resized ref lands on a non-16-multiple (e.g. 1024x1535).
if (options.video) {
  if (!Number.isFinite(options.width) || options.width <= 0 || !Number.isFinite(options.height) || options.height <= 0) {
    fatalCliError('Video width/height must be positive numbers.', {
      code: 'INVALID_ARGUMENT',
      details: { width: options.width, height: options.height }
    });
  }

  const originalVideoWidth = options.width;
  const originalVideoHeight = options.height;
  const normalizedVideoDims = normalizeVideoDimensionsLikeWrapper(options.width, options.height);
  options.width = normalizedVideoDims.width;
  options.height = normalizedVideoDims.height;
  if (normalizedVideoDims.adjusted && !options.quiet) {
    console.error(
      `Auto-adjusted video dimensions from ${originalVideoWidth}x${originalVideoHeight} ` +
      `to ${options.width}x${options.height} to meet video requirements.`
    );
  }

  if (
    options.videoWorkflow === 'i2v' &&
    (options.refImage || options.refImageEnd) &&
    !isHttpUrl(options.refImage || options.refImageEnd)
  ) {
    const refPath = options.refImage || options.refImageEnd;
    if (refPath && existsSync(refPath)) {
      const buffer = readFileSync(refPath);
      const dims = getImageDimensionsFromBuffer(buffer);
      if (dims?.width && dims?.height) {
        const predicted = predictSharpInsideResizeDims(dims.width, dims.height, options.width, options.height);
        if (predicted) {
          options._effectiveVideoDims = {
            width: predicted.width,
            height: predicted.height,
            refWidth: dims.width,
            refHeight: dims.height,
            requestedWidth: options.width,
            requestedHeight: options.height
          };
        }

        // Check if we need to find a better bounding box for i2v:
        // - Output not divisible by 16, OR
        // - Either dimension below MIN_VIDEO_DIMENSION (480)
        const needsBetterBox = predicted && (
          predicted.width % VIDEO_DIMENSION_MULTIPLE !== 0 ||
          predicted.height % VIDEO_DIMENSION_MULTIPLE !== 0 ||
          predicted.width < MIN_VIDEO_DIMENSION ||
          predicted.height < MIN_VIDEO_DIMENSION
        );

        if (needsBetterBox) {
          // Try to find a compatible bounding box (allow imperfect matches for better portrait/landscape support)
          let candidate = pickCompatibleI2vBoundingBox(dims.width, dims.height, options.width, options.height, { allowImperfect: true });
          if (!candidate) {
            // No compatible match found - will need to pre-resize the reference image
            options._needsRefResize = true;
            if (!options.quiet) {
              console.error(
                `Reference image ${dims.width}x${dims.height} will be pre-resized to div-16 dimensions ` +
                `because no compatible bounding box exists for i2v workflow.`
              );
            }
            // Continue without adjusting bounding box - the pre-resized reference will work with current dims
          } else if (!cliSet.width && !cliSet.height) {
            const before = `${options.width}x${options.height}`;
            options.width = candidate.width;
            options.height = candidate.height;
            const predicted2 = predictSharpInsideResizeDims(dims.width, dims.height, options.width, options.height);
            if (predicted2) {
              options._effectiveVideoDims = {
                width: predicted2.width,
                height: predicted2.height,
                refWidth: dims.width,
                refHeight: dims.height,
                requestedWidth: options.width,
                requestedHeight: options.height
              };
            }
            options._adjustedVideoDims = {
              reason: 'i2v-ref-div16',
              requested: { width: originalVideoWidth, height: originalVideoHeight },
              adjusted: { width: options.width, height: options.height },
              resizedFrom: predicted,
              resizedTo: predicted2 || null
            };
            if (!options.quiet) {
              console.error(
                `Auto-adjusted i2v video size from ${before} to ${options.width}x${options.height} ` +
                `so the resized reference is divisible by 16 (would have been ${predicted.width}x${predicted.height}).`
              );
            }
          } else if (candidate && options.strictSize) {
            fatalCliError(
              `Reference image ${dims.width}x${dims.height} would resize to ${predicted.width}x${predicted.height}, ` +
              `but both dimensions must be divisible by 16.`,
              {
                code: 'INVALID_VIDEO_SIZE',
                details: {
                  reference: { width: dims.width, height: dims.height },
                  requested: { width: options.width, height: options.height },
                  resized: predicted
                },
                hint: `Try: --width ${candidate.width} --height ${candidate.height} (or omit --strict-size)`
              }
            );
          } else if (candidate) {
            const beforeW = options.width;
            const beforeH = options.height;
            options.width = candidate.width;
            options.height = candidate.height;
            const predicted2 = predictSharpInsideResizeDims(dims.width, dims.height, options.width, options.height);
            if (predicted2) {
              options._effectiveVideoDims = {
                width: predicted2.width,
                height: predicted2.height,
                refWidth: dims.width,
                refHeight: dims.height,
                requestedWidth: options.width,
                requestedHeight: options.height
              };
            }
            options._adjustedVideoDims = {
              reason: 'i2v-ref-div16',
              requested: { width: beforeW, height: beforeH },
              adjusted: { width: options.width, height: options.height },
              resizedFrom: predicted,
              resizedTo: predicted2 || null
            };
            if (!options.quiet) {
              console.error(
                `Warning: Adjusted i2v video size from ${beforeW}x${beforeH} to ${options.width}x${options.height} ` +
                `because the resized reference would be ${predicted.width}x${predicted.height} (not divisible by 16). ` +
                `Use --strict-size to fail instead.`
              );
            }
          }
        }
      }
    }
  }
}

// Validate context images against model limits
if (options.contextImages.length > 0 && !options.video) {
  const maxImages = getMaxContextImages(options.model);
  if (maxImages === 0) {
    fatalCliError(`Model ${options.model} does not support context images.`, {
      code: 'INVALID_ARGUMENT',
      details: { model: options.model },
      hint: 'Try: qwen_image_edit_2511_fp8 or qwen_image_edit_2511_fp8_lightning'
    });
  }
  if (options.contextImages.length > maxImages) {
    fatalCliError(`Model ${options.model} supports max ${maxImages} context images, got ${options.contextImages.length}.`, {
      code: 'INVALID_ARGUMENT',
      details: { model: options.model, maxImages, provided: options.contextImages.length }
    });
  }
}

// Load last render seed if requested
if (options.lastSeed) {
  if (existsSync(LAST_RENDER_PATH)) {
    try {
      const lastRender = JSON.parse(readFileSync(LAST_RENDER_PATH, 'utf8'));
      if (lastRender.seed) {
        options.seed = lastRender.seed;
        if (!options.quiet) console.error(`Using seed from last render: ${options.seed}`);
      }
    } catch (e) {
      console.error('Warning: Could not load last render seed');
    }
  } else {
    console.error('Warning: No previous render found, generating seed');
  }
}

if (!options.estimateVideoCost && (options.seed === null || options.seed === undefined)) {
  const strategy = options.seedStrategy || openclawConfig?.seedStrategy || 'prompt-hash';
  const normalized = normalizeSeedStrategy(strategy) || 'prompt-hash';
  options.seedStrategy = normalized;
  options.seed = normalized === 'random'
    ? generateRandomSeed()
    : computePromptHashSeed(options);
  if (!options.quiet) console.error(`Using ${normalized} seed: ${options.seed}`);
}

// Load credentials
function loadCredentials() {
  const credPath = join(homedir(), '.config', 'sogni', 'credentials');
  
  if (existsSync(credPath)) {
    const content = readFileSync(credPath, 'utf8');
    const creds = {};
    for (const line of content.split('\n')) {
      const [key, val] = line.split('=');
      if (key && val) creds[key.trim()] = val.trim();
    }
    if (creds.SOGNI_USERNAME && creds.SOGNI_PASSWORD) {
      return creds;
    }
  }
  
  if (process.env.SOGNI_USERNAME && process.env.SOGNI_PASSWORD) {
    return {
      SOGNI_USERNAME: process.env.SOGNI_USERNAME,
      SOGNI_PASSWORD: process.env.SOGNI_PASSWORD
    };
  }

  const err = new Error('No Sogni credentials found.');
  err.code = 'MISSING_CREDENTIALS';
  err.hint = 'Set SOGNI_USERNAME/SOGNI_PASSWORD or create ~/.config/sogni/credentials.';
  err.details = {
    triedEnv: ['SOGNI_USERNAME', 'SOGNI_PASSWORD'],
    triedFile: credPath
  };
  throw err;
}

// Save last render info
function saveLastRender(info) {
  try {
    const dir = dirname(LAST_RENDER_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(LAST_RENDER_PATH, JSON.stringify(info, null, 2));
  } catch (e) {
    // Ignore save errors
  }
}

// Fetch image as buffer
async function fetchMediaBuffer(pathOrUrl) {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    const response = await fetch(pathOrUrl);
    if (!response.ok) {
      const err = new Error(`Failed to fetch media (${response.status} ${response.statusText})`);
      err.code = 'FETCH_FAILED';
      err.details = { url: pathOrUrl, status: response.status, statusText: response.statusText };
      throw err;
    }
    return Buffer.from(await response.arrayBuffer());
  }
  try {
    return readFileSync(pathOrUrl);
  } catch (e) {
    const err = new Error(`Failed to read media file: ${pathOrUrl}`);
    err.code = 'MISSING_FILE';
    err.hint = 'Check the path or use a URL.';
    err.details = { path: pathOrUrl, cause: e?.message || String(e) };
    throw err;
  }
}

function resolveMultiAngleOutputConfig(outputPath, outputFormat) {
  if (!outputPath) return null;
  const ext = extname(outputPath);
  const desiredExt = (outputFormat || 'jpg').replace('.', '');
  if (!ext) {
    return { dir: outputPath, prefix: '', ext: desiredExt };
  }
  const dir = dirname(outputPath);
  const prefix = basename(outputPath, ext);
  return { dir, prefix, ext: ext.replace('.', '') || desiredExt };
}

async function downloadUrlToFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(filePath, buffer);
}

function removeClientListener(client, event, handler) {
  if (typeof client.off === 'function') {
    client.off(event, handler);
  } else {
    client.removeListener(event, handler);
  }
}

function ensureFfmpegAvailable() {
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  const result = spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    const err = new Error('ffmpeg is required to assemble the 360 video.');
    err.code = 'MISSING_FFMPEG';
    err.hint = 'Install ffmpeg or set FFMPEG_PATH to a working ffmpeg binary.';
    err.details = { ffmpegPath };
    throw err;
  }
  return ffmpegPath;
}

function writeConcatList(filePath, frames, frameDuration) {
  const lines = [];
  frames.forEach((frame) => {
    lines.push(`file '${frame.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${frameDuration}`);
  });
  if (frames.length > 0) {
    const last = frames[frames.length - 1];
    lines.push(`file '${last.replace(/'/g, "'\\''")}'`);
  }
  writeFileSync(filePath, lines.join('\n'));
}

function isNonEmptyFile(filePath) {
  try {
    if (!existsSync(filePath)) return false;
    const stat = statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function buildAngles360Video(outputPath, frames, fps) {
  const ffmpegPath = ensureFfmpegAvailable();
  const tempListPath = outputPath.replace(/\.mp4$/i, '') + '.concat.txt';
  const frameDuration = 1 / fps;
  writeConcatList(tempListPath, frames, frameDuration);

  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', tempListPath,
    '-r', String(fps),
    '-pix_fmt', 'yuv420p',
    outputPath
  ];
  const result = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    // ffmpeg sometimes exits non-zero even when the output file is usable.
    // Treat it as success if the output exists and is non-empty.
    if (isNonEmptyFile(outputPath)) {
      console.warn('Warning: ffmpeg exited non-zero, but output video exists and is non-empty. Continuing.');
      return;
    }
    const err = new Error('ffmpeg failed to build 360 video.');
    err.code = 'FFMPEG_FAILED';
    err.details = { outputPath };
    throw err;
  }
}

function extractLastFrameFromVideo(videoPath, outputImagePath) {
  const ffmpegPath = ensureFfmpegAvailable();

  // Extract the last frame by reading through the video with update mode
  // This processes all frames but only keeps the last one
  const args = [
    '-i', videoPath,
    '-vf', 'select=gte(n\\,0)',  // Select all frames (just pass-through)
    '-vsync', '0',
    '-update', '1',  // Update same output file (keeps only last frame)
    '-q:v', '1',  // Best quality
    '-y',
    outputImagePath
  ];

  const result = spawnSync(ffmpegPath, args, { stdio: 'pipe' });

  if (result.error || result.status !== 0 || !isNonEmptyFile(outputImagePath)) {
    const stderr = result.stderr?.toString() || '';
    const stdout = result.stdout?.toString() || '';
    console.error('FFmpeg extraction failed:');
    console.error('  Video path:', videoPath);
    console.error('  Output path:', outputImagePath);
    console.error('  Exit code:', result.status);
    console.error('  Error:', result.error?.message || 'none');
    if (stderr) console.error('  Stderr:', stderr);
    if (stdout) console.error('  Stdout:', stdout);
    console.error('  Output file exists:', existsSync(outputImagePath));
    if (existsSync(outputImagePath)) {
      console.error('  Output file size:', statSync(outputImagePath).size);
    }

    const err = new Error('Failed to extract last frame from video.');
    err.code = 'FFMPEG_EXTRACT_FAILED';
    err.details = { videoPath, outputImagePath, stderr, stdout, status: result.status };
    throw err;
  }
}

function buildConcatVideoFromClips(outputPath, clips) {
  const ffmpegPath = ensureFfmpegAvailable();
  const tempListPath = outputPath.replace(/\.mp4$/i, '') + '.concat.txt';
  const lines = clips.map((clip) => `file '${clip.replace(/'/g, "'\\''")}'`);
  writeFileSync(tempListPath, lines.join('\n'));

  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', tempListPath,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    outputPath
  ];
  const result = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    if (isNonEmptyFile(outputPath)) {
      console.warn('Warning: ffmpeg exited non-zero, but output video exists and is non-empty. Continuing.');
      return;
    }
    const err = new Error('ffmpeg failed to concatenate 360 video clips.');
    err.code = 'FFMPEG_FAILED';
    err.details = { outputPath, clips: clips?.length ?? null };
    throw err;
  }
}

async function runImageEditProjectWithEvents(client, editConfig, expectedCount, log, timeoutMs, label) {
  const results = [];
  let completed = 0;
  let projectId = null;

  let resolvePromise;
  let rejectPromise;
  const completionPromise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const onCompleted = (data) => {
    if (projectId && data.projectId !== projectId) return;
    if (!projectId) projectId = data.projectId;
    const jobData = data.job?.data || {};
    results.push({
      imageUrl: data.imageUrl,
      seed: jobData.seed,
      jobIndex: data.jobIndex,
      projectId: data.projectId
    });
    completed++;
    log(`Image ${completed}/${expectedCount}${label ? ` (${label})` : ''} completed`);
    if (completed >= expectedCount) {
      cleanup();
      resolvePromise({ results, projectId });
    }
  };

  const onFailed = (data) => {
    if (projectId && data.projectId !== projectId) return;
    if (!projectId) projectId = data.projectId;
    cleanup();
    rejectPromise(new Error(data.error || 'Job failed'));
  };

  const cleanup = () => {
    clearTimeout(timeout);
    removeClientListener(client, ClientEvent.JOB_COMPLETED, onCompleted);
    removeClientListener(client, ClientEvent.JOB_FAILED, onFailed);
  };

  const timeout = setTimeout(() => {
    cleanup();
    rejectPromise(new Error(`Timeout after ${timeoutMs / 1000}s`));
  }, timeoutMs);

  client.on(ClientEvent.JOB_COMPLETED, onCompleted);
  client.on(ClientEvent.JOB_FAILED, onFailed);

  try {
    const projectResult = await client.createImageEditProject(editConfig);
    projectId = projectResult?.project?.id || projectId;

    // Check for errors in the response (e.g., insufficient tokens)
    if (projectResult?.error || projectResult?.message) {
      cleanup();
      throw new Error(projectResult.error || projectResult.message);
    }
    if (!projectId) {
      cleanup();
      throw new Error('Failed to create project: no project ID returned');
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  return completionPromise;
}

async function runMultiAngleFlow(client, log) {
  const contextBuffer = await fetchMediaBuffer(options.contextImages[0]);
  const azimuths = options.angles360
    ? MULTI_ANGLE_AZIMUTHS.map((a) => a.key)
    : [options.azimuth];
  const modelDefaults = getModelDefaults(options.model, openclawConfig);
  const steps = options.steps ?? modelDefaults?.steps ?? (options.model.includes('lightning') ? 4 : 20);
  const guidance = options.guidance ?? modelDefaults?.guidance ?? (options.model.includes('lightning') ? 1.0 : 4.0);

  let outputConfig = resolveMultiAngleOutputConfig(options.output, options.outputFormat);
  let tempOutputDir = null;
  if (options.output && !outputConfig && !options.quiet) {
    console.error('Warning: Could not resolve output path for multi-angle output.');
  }
  if (options.angles360Video && !outputConfig) {
    tempOutputDir = mkdtempSync(join(tmpdir(), 'sogni-angles-'));
    outputConfig = {
      dir: tempOutputDir,
      prefix: 'angles-360',
      ext: (options.outputFormat || 'jpg').replace('.', '')
    };
  }
  let videoOutputPath = null;
  if (options.angles360Video) {
    if (typeof options.angles360Video === 'string') {
      videoOutputPath = options.angles360Video;
    } else if (options.output && outputConfig && outputConfig.ext === 'mp4') {
      videoOutputPath = options.output;
    } else if (outputConfig) {
      const baseName = outputConfig.prefix ? outputConfig.prefix : 'angles-360';
      videoOutputPath = join(outputConfig.dir, `${baseName}.mp4`);
    } else {
      videoOutputPath = join(process.cwd(), 'angles-360.mp4');
    }
    if (!videoOutputPath.toLowerCase().endsWith('.mp4')) {
      videoOutputPath += '.mp4';
    }
  }
  if (outputConfig) {
    if (outputConfig.ext === 'mp4') {
      outputConfig.ext = (options.outputFormat || 'jpg').replace('.', '');
    }
    if (!existsSync(outputConfig.dir)) {
      mkdirSync(outputConfig.dir, { recursive: true });
    }
  }

  const angleResults = [];
  const videoFrames = [];
  for (const azimuth of azimuths) {
    const prompt = buildMultiAnglePrompt({
      azimuth,
      elevation: options.elevation,
      distance: options.distance,
      description: options.angleDescription
    });
    const editConfig = {
      modelId: options.model,
      positivePrompt: prompt,
      contextImages: [contextBuffer],
      numberOfMedia: options.count,
      width: options.width,
      height: options.height,
      steps,
      guidance,
      tokenType: options.tokenType || 'spark',
      waitForCompletion: false,
      disableNSFWFilter: true
    };
    if (options.outputFormat) {
      editConfig.outputFormat = options.outputFormat;
    }
    if (options.sampler) {
      editConfig.sampler = options.sampler;
    }
    if (options.scheduler) {
      editConfig.scheduler = options.scheduler;
    }
    if (options.loras.length > 0) {
      editConfig.loras = options.loras;
    }
    if (options.loraStrengths.length > 0) {
      editConfig.loraStrengths = options.loraStrengths;
    }
    if (options.seed !== null && options.seed !== undefined) {
      editConfig.seed = options.seed;
    }

    const { results } = await runImageEditProjectWithEvents(
      client,
      editConfig,
      options.count,
      log,
      options.timeout,
      azimuth
    );
    const urls = results.map((r) => r.imageUrl).filter(Boolean);
    const seeds = results.map((r) => r.seed ?? options.seed);

    if (outputConfig) {
      const safeAzimuth = azimuth.replace(/[^a-z0-9-]/gi, '-');
      for (let i = 0; i < urls.length; i++) {
        const suffix = urls.length > 1 ? `-${i + 1}` : '';
        const prefix = outputConfig.prefix ? `${outputConfig.prefix}-` : '';
        const filename = `${prefix}${safeAzimuth}${suffix}.${outputConfig.ext}`;
        const filePath = join(outputConfig.dir, filename);
        await downloadUrlToFile(urls[i], filePath);
        if (options.angles360Video && i === 0) {
          videoFrames.push(filePath);
        }
      }
    }

    angleResults.push({
      azimuth,
      elevation: options.elevation,
      distance: options.distance,
      prompt,
      urls,
      seeds
    });
  }

  const renderInfo = {
    timestamp: new Date().toISOString(),
    type: options.angles360 ? 'multi-angle-360' : 'multi-angle',
    model: options.model,
    width: options.width,
    height: options.height,
    count: options.count,
    tokenType: options.tokenType || 'spark',
    seed: options.seed,
    seedStrategy: options.seedStrategy || null,
    outputFormat: options.outputFormat || null,
    sampler: options.sampler || null,
    scheduler: options.scheduler || null,
    loras: options.loras.length > 0 ? options.loras : null,
    loraStrengths: options.loraStrengths.length > 0 ? options.loraStrengths : null,
    angles: angleResults,
    localPath: options.output || null
  };

  let videoModelId = null;
  if (videoOutputPath) {
    if (videoFrames.length === 0) {
      const err = new Error('No local frames available to assemble 360 video.');
      err.code = 'MISSING_FRAMES';
      err.hint = 'Ensure the frames were downloaded locally (provide --output dir or check permissions).';
      throw err;
    }
    const clipDir = mkdtempSync(join(tmpdir(), 'sogni-angles-clips-'));
    videoModelId = options.videoModel || openclawConfig?.videoModels?.i2v || VIDEO_WORKFLOW_DEFAULT_MODELS.i2v;
    const videoDefaults = getModelDefaults(videoModelId, openclawConfig);
    const videoSteps = options.steps ?? videoDefaults?.steps;
    const videoGuidance = options.guidance ?? videoDefaults?.guidance;
    const segmentCount = videoFrames.length;
    let segmentDuration = options.duration;
    let segmentFrames = null;
    if (options.frames) {
      segmentFrames = Math.max(17, Math.round(options.frames / segmentCount));
    } else {
      segmentDuration = Math.max(1, Math.round(options.duration / segmentCount));
    }
    const videoPrompt = options.angleDescription || options.prompt || 'smooth camera rotation';
    const clipPaths = [];

    for (let i = 0; i < videoFrames.length; i++) {
      const startPath = videoFrames[i];
      const endPath = videoFrames[(i + 1) % videoFrames.length];

      // Validate i2v reference resizing constraints for this clip
      let startBuffer = readFileSync(startPath);
      let endBuffer = readFileSync(endPath);
      const startDims = getImageDimensionsFromBuffer(startBuffer);
      let clipWidth = options.width;
      let clipHeight = options.height;
      let needsResize = false;

      if (startDims?.width && startDims?.height) {
        const predicted = predictSharpInsideResizeDims(startDims.width, startDims.height, clipWidth, clipHeight);
        if (predicted && (predicted.width % VIDEO_DIMENSION_MULTIPLE !== 0 || predicted.height % VIDEO_DIMENSION_MULTIPLE !== 0)) {
          // The resized reference won't be divisible by 16, need to adjust
          const candidate = pickCompatibleI2vBoundingBox(startDims.width, startDims.height, clipWidth, clipHeight);
          if (!candidate) {
            // No perfect match - will pre-resize the reference frames
            needsResize = true;
            if (i === 0 && !options.quiet) {
              console.error(
                `360 video reference frames will be pre-resized to div-16 dimensions ` +
                `because no compatible bounding box exists.`
              );
            }
          } else {
            // Auto-adjust to compatible size
            if (!cliSet.width && !cliSet.height && !options.strictSize) {
              clipWidth = candidate.width;
              clipHeight = candidate.height;
              if (i === 0 && !options.quiet) {
                console.error(
                  `Auto-adjusted 360 video clip size from ${options.width}x${options.height} ` +
                  `to ${clipWidth}x${clipHeight} so resized reference is divisible by 16 ` +
                  `(would have been ${predicted.width}x${predicted.height}).`
                );
              }
            } else if (options.strictSize) {
              fatalCliError(
                `Reference frame ${startDims.width}x${startDims.height} would resize to ${predicted.width}x${predicted.height}, ` +
                `but both dimensions must be divisible by 16.`,
                {
                  code: 'INVALID_VIDEO_SIZE',
                  details: {
                    clipIndex: i + 1,
                    reference: { width: startDims.width, height: startDims.height },
                    requested: { width: clipWidth, height: clipHeight },
                    resized: predicted
                  },
                  hint: `Try: --width ${candidate.width} --height ${candidate.height} (or omit --strict-size)`
                }
              );
            } else {
              // User specified explicit dimensions but not --strict-size, auto-adjust anyway
              clipWidth = candidate.width;
              clipHeight = candidate.height;
              if (i === 0 && !options.quiet) {
                console.error(
                  `Warning: Adjusted 360 video clip size from ${options.width}x${options.height} ` +
                  `to ${clipWidth}x${clipHeight} because resized reference would be ${predicted.width}x${predicted.height} ` +
                  `(not divisible by 16). Use --strict-size to fail instead.`
                );
              }
            }
          }
        }
      }

      // Pre-resize reference frames if needed
      if (needsResize && startDims?.width && startDims?.height) {
        startBuffer = await resizeImageBufferToDiv16(startBuffer, startDims.width, startDims.height);
        const endDims = getImageDimensionsFromBuffer(endBuffer);
        if (endDims?.width && endDims?.height) {
          endBuffer = await resizeImageBufferToDiv16(endBuffer, endDims.width, endDims.height);
        }
        const resizedDims = getImageDimensionsFromBuffer(startBuffer);
        if (i === 0 && !options.quiet) {
          console.error(
            `Pre-resized 360 video frames from ${startDims.width}x${startDims.height} to ${resizedDims.width}x${resizedDims.height} ` +
            `(divisible by 16) to ensure i2v compatibility.`
          );
        }
      }

      const clipConfig = {
        modelId: videoModelId,
        positivePrompt: videoPrompt,
        negativePrompt: '',
        stylePrompt: '',
        numberOfMedia: 1,
        referenceImage: startBuffer,
        referenceImageEnd: endBuffer,
        fps: options.fps,
        width: clipWidth,
        height: clipHeight,
        tokenType: options.tokenType || 'spark',
        waitForCompletion: true,
        disableNSFWFilter: true
      };
      if (segmentFrames) {
        clipConfig.frames = segmentFrames;
      } else {
        clipConfig.duration = segmentDuration;
      }
      if (videoSteps) {
        clipConfig.steps = videoSteps;
      }
      if (videoGuidance !== null && videoGuidance !== undefined) {
        clipConfig.guidance = videoGuidance;
      }
      if (options.autoResizeVideoAssets !== null) {
        clipConfig.autoResizeVideoAssets = options.autoResizeVideoAssets;
      }
      const clipResult = await client.createVideoProject(clipConfig);

      // Check for errors in the response (e.g., insufficient tokens)
      if (clipResult?.error || clipResult?.message) {
        throw new Error(clipResult.error || clipResult.message);
      }

      const clipUrl = clipResult?.videoUrls?.[0];
      if (!clipUrl) {
        throw new Error('No video URL returned for 360 segment.');
      }
      const clipPath = join(clipDir, `segment-${i + 1}.mp4`);
      await downloadUrlToFile(clipUrl, clipPath);
      clipPaths.push(clipPath);
    }

    buildConcatVideoFromClips(videoOutputPath, clipPaths);
    if (!options.quiet) {
      console.error(`Saved 360 video: ${videoOutputPath}`);
    }
  }
  if (videoOutputPath) {
    renderInfo.videoPath = videoOutputPath;
    renderInfo.videoModel = videoModelId;
  }
  saveLastRender(renderInfo);

  if (options.json) {
    console.log(JSON.stringify({
      success: true,
      type: renderInfo.type,
      model: renderInfo.model,
      width: renderInfo.width,
      height: renderInfo.height,
      count: renderInfo.count,
      tokenType: renderInfo.tokenType,
      seed: renderInfo.seed,
      seedStrategy: renderInfo.seedStrategy,
      outputFormat: renderInfo.outputFormat,
      sampler: renderInfo.sampler,
      scheduler: renderInfo.scheduler,
      loras: renderInfo.loras,
      loraStrengths: renderInfo.loraStrengths,
      videoPath: renderInfo.videoPath || null,
      videoModel: renderInfo.videoModel || null,
      angles: angleResults
    }));
  } else {
    if (videoOutputPath) {
      console.log(`video: ${videoOutputPath}`);
    }
    angleResults.forEach((angle) => {
      angle.urls.forEach((url, index) => {
        const suffix = angle.urls.length > 1 ? `#${index + 1}` : '';
        console.log(`${angle.azimuth}${suffix}: ${url}`);
      });
    });
  }
}

async function ensureSufficientVideoBalance(client, log) {
  if (!options.video || options.estimateVideoCost) return;
  const tokenType = options.tokenType || 'spark';
  const tokenLabel = tokenType.toUpperCase();
  let balance;
  try {
    balance = await client.getBalance();
  } catch (err) {
    if (!options.quiet) {
      log(`Warning: Could not fetch balance (${err?.message || 'error'})`);
    }
    return;
  }
  const available = tokenType === 'sogni' ? balance.sogni : balance.spark;
  if (!Number.isFinite(available)) return;
  if (available <= 0) {
    throw buildBalanceError(
      `Insufficient ${tokenLabel} balance (have ${formatTokenValue(available)}).`,
      { tokenType, available }
    );
  }

  const modelDefaults = getModelDefaults(options.model, openclawConfig);
  const steps = resolveVideoSteps(options.model, modelDefaults, options.steps);
  if (!Number.isFinite(steps) || steps <= 0) return;

  let estimate;
  try {
    estimate = await client.estimateVideoCost({
      modelId: options.model,
      width: options.width,
      height: options.height,
      fps: options.fps,
      steps,
      numberOfMedia: options.count,
      tokenType,
      ...(options.frames ? { frames: options.frames } : { duration: options.duration })
    });
  } catch (err) {
    if (!options.quiet) {
      log(`Warning: Could not estimate video cost (${err?.message || 'error'})`);
    }
    return;
  }
  const required = parseCostEstimate(estimate, tokenType);
  if (Number.isFinite(required) && available < required) {
    throw buildBalanceError(
      `Insufficient ${tokenLabel} balance for video render (need ~${formatTokenValue(required)}, ` +
      `have ${formatTokenValue(available)}).`,
      { tokenType, available, required }
    );
  }
}

async function main() {
  let exitCode = 0;
  const log = options.quiet ? () => {} : console.error.bind(console);
  let client = null;
  
  try {
    const creds = loadCredentials();
    log('Connecting to Sogni...');
    client = new SogniClientWrapper({
      username: creds.SOGNI_USERNAME,
      password: creds.SOGNI_PASSWORD,
      network: openclawConfig?.defaultNetwork || 'fast',
      autoConnect: false,
      authType: 'token'
    });

    await client.connect();
    log('Connected.');

    if (options.showBalance) {
      const balance = await client.getBalance();
      const spark = Number.parseFloat(balance?.spark);
      const sogni = Number.parseFloat(balance?.sogni);
      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          type: 'balance',
          spark: Number.isFinite(spark) ? spark : null,
          sogni: Number.isFinite(sogni) ? sogni : null,
          tokenType: options.tokenType || 'spark',
          timestamp: new Date().toISOString()
        }));
      } else {
        console.log(`SPARK: ${formatTokenValue(spark)}`);
        console.log(`SOGNI: ${formatTokenValue(sogni)}`);
      }
      return;
    }

    await ensureSufficientVideoBalance(client, log);

    if (options.estimateVideoCost) {
      const modelDefaults = getModelDefaults(options.model, openclawConfig);
      const steps = resolveVideoSteps(options.model, modelDefaults, options.steps);
      if (!Number.isFinite(steps) || steps <= 0) {
        const err = new Error('--estimate-video-cost requires --steps (or modelDefaults for this model).');
        err.code = 'MISSING_STEPS';
        err.hint = 'Pass --steps explicitly (e.g. --steps 4 for lightx2v models).';
        throw err;
      }
      const estimateParams = {
        modelId: options.model,
        width: options.width,
        height: options.height,
        fps: options.fps,
        steps,
        numberOfMedia: options.count,
        tokenType: options.tokenType || 'spark'
      };
      if (options.frames) {
        estimateParams.frames = options.frames;
      } else {
        estimateParams.duration = options.duration;
      }
      const estimate = await client.estimateVideoCost(estimateParams);
      if (options.json) {
        const duration = options.frames ? Math.max(1, Math.round((options.frames - 1) / options.fps)) : options.duration;
        console.log(JSON.stringify({
          success: true,
          type: 'video-cost',
          model: options.model,
          width: options.width,
          height: options.height,
          fps: options.fps,
          frames: options.frames ?? null,
          duration,
          steps,
          tokenType: options.tokenType || 'spark',
          count: options.count,
          estimate
        }));
      } else {
        console.log(`Estimated cost: ${JSON.stringify(estimate)}`);
      }
      return;
    }

    if (options.multiAngle) {
      if (options.contextImages.length > 1 && !options.quiet) {
        console.error('Warning: --multi-angle uses the first context image only.');
      }
      await runMultiAngleFlow(client, log);
      return;
    }
    
    const results = [];
    let completedJobs = 0;
    
    const completionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout after ${options.timeout / 1000}s`));
      }, options.timeout);
      
      client.on(ClientEvent.JOB_COMPLETED, (data) => {
        const jobData = data.job?.data || {};
        results.push({
          imageUrl: data.imageUrl,
          videoUrl: data.videoUrl,
          seed: jobData.seed,
          jobIndex: data.jobIndex,
          projectId: data.projectId
        });
        completedJobs++;
        log(`${options.video ? 'Video' : 'Image'} ${completedJobs}/${options.count} completed`);
        
        if (completedJobs >= options.count) {
          clearTimeout(timeout);
          resolve();
        }
      });
      
      client.on(ClientEvent.JOB_FAILED, (data) => {
        clearTimeout(timeout);
        reject(new Error(data.error || 'Job failed'));
      });

      client.on(ClientEvent.PROJECT_FAILED, (data) => {
        clearTimeout(timeout);
        const message = data?.message || data?.error || 'Project failed';
        reject(new Error(message));
      });

      client.on(ClientEvent.PROJECT_EVENT, (event) => {
        if (event?.type !== 'error') return;
        clearTimeout(timeout);
        const message = event?.error?.message || event?.error?.error || 'Project failed';
        reject(new Error(message));
      });

      client.on(ClientEvent.JOB_EVENT, (event) => {
        if (event?.type !== 'error') return;
        clearTimeout(timeout);
        const message = event?.error?.message || event?.error?.error || 'Job failed';
        reject(new Error(message));
      });
      
      // Progress for video
      if (options.video) {
        client.on(ClientEvent.PROJECT_PROGRESS, (data) => {
          if (data.percentage && data.percentage > 0) {
            log(`Progress: ${Math.round(data.percentage)}%`);
          }
        });
      }
    });
    
    if (options.video) {
      // Video generation
      log(`Generating video (${options.videoWorkflow}) with ${options.model}...`);
      if (options.refImage) log(`Reference image: ${options.refImage}`);
      if (options.refImageEnd) log(`End frame: ${options.refImageEnd}`);
      if (options.refAudio) log(`Reference audio: ${options.refAudio}`);
      if (options.refVideo) log(`Reference video: ${options.refVideo}`);
      
      let imageBuffer = options.refImage ? await fetchMediaBuffer(options.refImage) : undefined;
      let endImageBuffer = options.refImageEnd ? await fetchMediaBuffer(options.refImageEnd) : undefined;
      const audioBuffer = options.refAudio ? await fetchMediaBuffer(options.refAudio) : undefined;
      const videoBuffer = options.refVideo ? await fetchMediaBuffer(options.refVideo) : undefined;

      // Pre-resize reference images to div-16 dimensions if needed for i2v workflow
      if (options.videoWorkflow === 'i2v' && imageBuffer && options._needsRefResize) {
        const dims = getImageDimensionsFromBuffer(imageBuffer);
        if (dims?.width && dims?.height) {
          const resizedBuffer = await resizeImageBufferToDiv16(imageBuffer, dims.width, dims.height);
          const resizedDims = getImageDimensionsFromBuffer(resizedBuffer);
          if (!options.quiet) {
            console.error(
              `Pre-resized reference image from ${dims.width}x${dims.height} to ${resizedDims.width}x${resizedDims.height} ` +
              `(divisible by 16) to ensure i2v compatibility.`
            );
          }
          imageBuffer = resizedBuffer;
        }
      }
      if (options.videoWorkflow === 'i2v' && endImageBuffer && options._needsRefEndResize) {
        const dims = getImageDimensionsFromBuffer(endImageBuffer);
        if (dims?.width && dims?.height) {
          const resizedBuffer = await resizeImageBufferToDiv16(endImageBuffer, dims.width, dims.height);
          const resizedDims = getImageDimensionsFromBuffer(resizedBuffer);
          if (!options.quiet) {
            console.error(
              `Pre-resized end reference image from ${dims.width}x${dims.height} to ${resizedDims.width}x${resizedDims.height} ` +
              `(divisible by 16) to ensure i2v compatibility.`
            );
          }
          endImageBuffer = resizedBuffer;
        }
      }
      const modelDefaults = getModelDefaults(options.model, openclawConfig);
      const steps = resolveVideoSteps(options.model, modelDefaults, options.steps);
      const guidance = options.guidance ?? modelDefaults?.guidance;
      
      const projectConfig = {
        modelId: options.model,
        positivePrompt: options.prompt,
        negativePrompt: '',
        stylePrompt: '',
        numberOfMedia: options.count,
        referenceImage: imageBuffer,
        fps: options.fps,
        width: options.width,
        height: options.height,
        tokenType: options.tokenType || 'spark',
        waitForCompletion: false,
        disableNSFWFilter: true
      };

      if (options.outputFormat) {
        projectConfig.outputFormat = options.outputFormat;
      }
      if (options.autoResizeVideoAssets !== null) {
        projectConfig.autoResizeVideoAssets = options.autoResizeVideoAssets;
      }

      if (options.frames) {
        projectConfig.frames = options.frames;
      } else {
        projectConfig.duration = options.duration;
      }
      
      // Add end frame for interpolation if provided
      if (endImageBuffer) {
        projectConfig.referenceImageEnd = endImageBuffer;
      }
      if (audioBuffer) {
        projectConfig.referenceAudio = audioBuffer;
      }
      if (videoBuffer) {
        projectConfig.referenceVideo = videoBuffer;
      }
      if (options.seed !== null && options.seed !== undefined) {
        projectConfig.seed = options.seed;
      }
      if (Number.isFinite(steps)) {
        projectConfig.steps = steps;
      }
      if (guidance !== null && guidance !== undefined) {
        projectConfig.guidance = guidance;
      }

      const videoResult = await client.createVideoProject(projectConfig);

      // Check for errors in the response (e.g., insufficient tokens)
      if (videoResult?.error || videoResult?.message) {
        throw new Error(videoResult.error || videoResult.message);
      }
    } else if (options.contextImages.length > 0) {
      // Image editing with context images
      log(`Editing with ${options.model}...`);
      log(`Context images: ${options.contextImages.length}`);
      if (options.seed !== null && options.seed !== undefined) log(`Using seed: ${options.seed}`);
      
      // Load all context images as buffers
      const contextBuffers = await Promise.all(
        options.contextImages.map(img => fetchMediaBuffer(img))
      );
      const modelDefaults = getModelDefaults(options.model, openclawConfig);
      const steps = options.steps ?? modelDefaults?.steps ?? (options.model.includes('lightning') ? 4 : 20);
      const guidance = options.guidance ?? modelDefaults?.guidance ?? (options.model.includes('lightning') ? 3.5 : 7.5);
      
      const editConfig = {
        modelId: options.model,
        positivePrompt: options.prompt,
        contextImages: contextBuffers,
        numberOfMedia: options.count,
        width: options.width,
        height: options.height,
        steps,
        guidance,
        tokenType: options.tokenType || 'spark',
        disableNSFWFilter: true
      };

      if (options.outputFormat) {
        editConfig.outputFormat = options.outputFormat;
      }
      if (options.sampler) {
        editConfig.sampler = options.sampler;
      }
      if (options.scheduler) {
        editConfig.scheduler = options.scheduler;
      }
      if (options.loras.length > 0) {
        editConfig.loras = options.loras;
      }
      if (options.loraStrengths.length > 0) {
        editConfig.loraStrengths = options.loraStrengths;
      }
      
      if (options.seed !== null && options.seed !== undefined) {
        editConfig.seed = options.seed;
      }
      
      await client.createImageEditProject(editConfig);
    } else if (options.photobooth) {
      // Photobooth: face transfer with InstantID ControlNet
      log(`Photobooth with ${options.model}...`);
      if (options.seed !== null && options.seed !== undefined) log(`Using seed: ${options.seed}`);

      const faceBuffer = await fetchMediaBuffer(options.refImage);
      const modelDefaults = getModelDefaults(options.model, openclawConfig);
      const steps = options.steps ?? modelDefaults?.steps ?? 7;
      const guidance = options.guidance ?? modelDefaults?.guidance ?? 2;

      const projectConfig = {
        modelId: options.model,
        positivePrompt: options.prompt,
        negativePrompt: '',
        stylePrompt: '',
        numberOfMedia: options.count,
        tokenType: options.tokenType || 'spark',
        waitForCompletion: false,
        sizePreset: 'custom',
        width: options.width,
        height: options.height,
        steps,
        guidance,
        disableNSFWFilter: true,
        sampler: options.sampler || 'dpmpp_sde',
        scheduler: options.scheduler || 'karras',
        controlNet: {
          name: 'instantid',
          image: faceBuffer,
          strength: options.cnStrength ?? 0.7,
          mode: 'balanced',
          guidanceStart: 0,
          guidanceEnd: options.cnGuidanceEnd ?? 0.6,
        }
      };

      if (options.outputFormat) projectConfig.outputFormat = options.outputFormat;
      if (options.seed !== null && options.seed !== undefined) projectConfig.seed = options.seed;
      if (options.loras.length > 0) projectConfig.loras = options.loras;
      if (options.loraStrengths.length > 0) projectConfig.loraStrengths = options.loraStrengths;

      const projectResult = await client.createImageProject(projectConfig);

      // Check for errors in the response (e.g., insufficient tokens)
      if (projectResult?.error || projectResult?.message) {
        throw new Error(projectResult.error || projectResult.message);
      }
    } else {
      // Standard image generation
      log(`Generating with ${options.model}...`);
      if (options.seed !== null && options.seed !== undefined) log(`Using seed: ${options.seed}`);
      const modelDefaults = getModelDefaults(options.model, openclawConfig);
      const guidance = options.guidance ?? modelDefaults?.guidance ?? 1.0;
      const steps = options.steps ?? modelDefaults?.steps;
      
      const projectConfig = {
        modelId: options.model,
        positivePrompt: options.prompt,
        negativePrompt: '',
        stylePrompt: '',
        numberOfMedia: options.count,
        tokenType: options.tokenType || 'spark',
        waitForCompletion: false,
        sizePreset: 'custom',
        width: options.width,
        height: options.height,
        guidance,
        disableNSFWFilter: true
      };
      if (options.outputFormat) {
        projectConfig.outputFormat = options.outputFormat;
      }
      if (options.sampler) {
        projectConfig.sampler = options.sampler;
      }
      if (options.scheduler) {
        projectConfig.scheduler = options.scheduler;
      }
      if (steps) {
        projectConfig.steps = steps;
      }
      
      if (options.seed !== null && options.seed !== undefined) {
        projectConfig.seed = options.seed;
      }
      
      await client.createImageProject(projectConfig);
    }
    
    // Wait for completion via events
    await completionPromise;
    
    if (results.length > 0) {
      const urls = results.map(r => options.video ? r.videoUrl : r.imageUrl).filter(Boolean);
      const firstResult = results[0];
      
      // Save last render info
      const seeds = results.map(r => r.seed ?? options.seed);
      const renderInfo = {
        timestamp: new Date().toISOString(),
        type: options.video ? 'video' : 'image',
        prompt: options.prompt,
        model: options.model,
        width: options.width,
        height: options.height,
        seed: firstResult.seed ?? options.seed,
        seedStrategy: options.seedStrategy || null,
        seeds,
        projectId: firstResult.projectId,
        urls: urls,
        localPath: options.output || null,
        tokenType: options.tokenType || 'spark'
      };
      if (options.outputFormat) {
        renderInfo.outputFormat = options.outputFormat;
      }
      if (options.sampler) {
        renderInfo.sampler = options.sampler;
      }
      if (options.scheduler) {
        renderInfo.scheduler = options.scheduler;
      }
      if (options.loras.length > 0) {
        renderInfo.loras = options.loras;
      }
      if (options.loraStrengths.length > 0) {
        renderInfo.loraStrengths = options.loraStrengths;
      }
      if (options.video) {
        renderInfo.workflow = options.videoWorkflow;
        renderInfo.fps = options.fps;
        renderInfo.duration = options.frames ? options.frames / options.fps : options.duration;
        if (options.frames) renderInfo.frames = options.frames;
        if (options.autoResizeVideoAssets !== null) {
          renderInfo.autoResizeVideoAssets = options.autoResizeVideoAssets;
        }
        renderInfo.refImage = options.refImage;
        renderInfo.refImageEnd = options.refImageEnd;
        if (options.refAudio) renderInfo.refAudio = options.refAudio;
        if (options.refVideo) renderInfo.refVideo = options.refVideo;
      }
      if (options.contextImages.length > 0) {
        renderInfo.contextImages = options.contextImages;
      }
      if (options.photobooth) {
        renderInfo.photobooth = true;
        renderInfo.refImage = options.refImage;
      }
      saveLastRender(renderInfo);
      
      // Save to file if requested
      if (options.output && urls[0]) {
        const response = await fetch(urls[0]);
        const buffer = Buffer.from(await response.arrayBuffer());

        const dir = dirname(options.output);
        if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });

        // Handle looping for i2v workflow
        if (options.looping && options.videoWorkflow === 'i2v' && options.refImage) {
          log('Creating looping video (A→B→A)...');

          // Save first clip temporarily
          const tempDir = mkdtempSync(join(tmpdir(), 'sogni-loop-'));
          const clip1Path = join(tempDir, 'clip1.mp4');
          const lastFramePath = join(tempDir, 'last-frame.png');
          const clip2Path = join(tempDir, 'clip2.mp4');

          writeFileSync(clip1Path, buffer);
          log('Extracting last frame...');
          extractLastFrameFromVideo(clip1Path, lastFramePath);

          // Generate second clip (last frame → original image)
          log('Generating return clip (B→A)...');

          // Get model defaults for steps and guidance
          const modelDefaults2 = getModelDefaults(options.model, openclawConfig);
          const steps2 = resolveVideoSteps(options.model, modelDefaults2, options.steps);
          const guidance2 = options.guidance ?? modelDefaults2?.guidance;

          const projectConfig2 = {
            modelId: options.model,
            positivePrompt: options.prompt,
            negativePrompt: '',
            stylePrompt: '',
            numberOfMedia: 1,
            referenceImage: readFileSync(lastFramePath),
            referenceImageEnd: readFileSync(options.refImage),
            fps: options.fps,
            width: options.width,
            height: options.height,
            tokenType: options.tokenType || 'spark',
            waitForCompletion: false,
            disableNSFWFilter: true
          };

          if (options.frames) projectConfig2.numberOfFrames = options.frames;
          else if (options.duration) projectConfig2.duration = options.duration;
          if (Number.isFinite(steps2)) projectConfig2.steps = steps2;
          if (guidance2 !== null && guidance2 !== undefined) projectConfig2.guidance = guidance2;

          // Create a new client for second clip to avoid event conflicts
          const creds = loadCredentials();
          const client2 = new SogniClientWrapper({
            username: creds.SOGNI_USERNAME,
            password: creds.SOGNI_PASSWORD,
            network: openclawConfig?.defaultNetwork || 'fast',
            autoConnect: false,
            authType: 'token'
          });
          await client2.connect();

          // Create second clip and wait for completion via events
          const clip2Promise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Second clip generation timed out'));
            }, options.timeout);

            client2.on(ClientEvent.JOB_COMPLETED, async (data) => {
              try {
                clearTimeout(timeout);
                const clip2Url = data.videoUrl;
                if (!clip2Url) {
                  reject(new Error('No video URL returned for second clip.'));
                  return;
                }

                // Download second clip
                const response2 = await fetch(clip2Url);
                const buffer2 = Buffer.from(await response2.arrayBuffer());
                writeFileSync(clip2Path, buffer2);

                await client2.disconnect();
                resolve();
              } catch (err) {
                clearTimeout(timeout);
                reject(err);
              }
            });

            client2.on(ClientEvent.JOB_FAILED, (data) => {
              clearTimeout(timeout);
              reject(new Error(data.error || 'Second clip generation failed'));
            });

            client2.on(ClientEvent.PROJECT_FAILED, (data) => {
              clearTimeout(timeout);
              reject(new Error(data?.message || 'Second clip project failed'));
            });

            // Show progress for second clip
            client2.on(ClientEvent.PROJECT_PROGRESS, (data) => {
              if (data.percentage && data.percentage > 0) {
                log(`Progress: ${Math.round(data.percentage)}%`);
              }
            });
          });

          const clip2Result = await client2.createVideoProject(projectConfig2);

          // Check for errors in the response (e.g., insufficient tokens)
          if (clip2Result?.error || clip2Result?.message) {
            throw new Error(clip2Result.error || clip2Result.message);
          }

          await clip2Promise;

          log('Concatenating clips...');
          buildConcatVideoFromClips(options.output, [clip1Path, clip2Path]);
          log(`Saved looping video to ${options.output}`);
        } else {
          writeFileSync(options.output, buffer);
          log(`Saved to ${options.output}`);
        }
      }
      
      // Output result
      if (options.json) {
        const output = {
          success: true,
          type: options.video ? 'video' : 'image',
          prompt: options.prompt,
          model: options.model,
          width: options.width,
          height: options.height,
          seed: firstResult.seed ?? options.seed,
          seedStrategy: options.seedStrategy || null,
          seeds,
          urls: urls,
          localPath: options.output || null,
          tokenType: options.tokenType || 'spark'
        };
        if (options.outputFormat) {
          output.outputFormat = options.outputFormat;
        }
        if (options.sampler) {
          output.sampler = options.sampler;
        }
        if (options.scheduler) {
          output.scheduler = options.scheduler;
        }
        if (options.loras.length > 0) {
          output.loras = options.loras;
        }
        if (options.loraStrengths.length > 0) {
          output.loraStrengths = options.loraStrengths;
        }
        if (options.video) {
          output.workflow = options.videoWorkflow;
          output.fps = options.fps;
          output.duration = options.frames ? options.frames / options.fps : options.duration;
          if (options.frames) output.frames = options.frames;
          output.strictSize = options.strictSize || false;
          if (options.autoResizeVideoAssets !== null) {
            output.autoResizeVideoAssets = options.autoResizeVideoAssets;
          }
          if (options.refImage) output.refImage = options.refImage;
          if (options.refImageEnd) output.refImageEnd = options.refImageEnd;
          if (options.refAudio) output.refAudio = options.refAudio;
          if (options.refVideo) output.refVideo = options.refVideo;
          if (options._effectiveVideoDims?.width && options._effectiveVideoDims?.height) {
            output.effectiveWidth = options._effectiveVideoDims.width;
            output.effectiveHeight = options._effectiveVideoDims.height;
            output.effectiveFromReference = {
              width: options._effectiveVideoDims.refWidth,
              height: options._effectiveVideoDims.refHeight
            };
          }
          if (options._adjustedVideoDims) {
            output.adjustedVideoDims = options._adjustedVideoDims;
          }
        }
        if (options.contextImages.length > 0) {
          output.contextImages = options.contextImages;
        }
        if (options.photobooth) {
          output.photobooth = true;
          output.refImage = options.refImage;
          output.controlNet = {
            name: 'instantid',
            strength: options.cnStrength ?? 0.7,
            guidanceEnd: options.cnGuidanceEnd ?? 0.6,
          };
        }
        console.log(JSON.stringify(output));
      } else {
        urls.forEach(url => console.log(url));
      }
    } else {
      throw new Error('No output generated - may have been filtered');
    }
    
  } catch (error) {
    exitCode = 1;
    const shouldJson = options.json || IS_OPENCLAW_INVOCATION;
    if (shouldJson) {
      const payload = {
        success: false,
        error: error.message,
        prompt: options.prompt ?? null
      };
      if (error.code) payload.errorCode = error.code;
      if (error.details) payload.errorDetails = error.details;
      if (error.hint) payload.hint = error.hint;
      payload.timestamp = new Date().toISOString();
      payload.node = process.versions.node;
      payload.cwd = process.cwd();
      payload.context = {
        video: options.video || false,
        workflow: options.video ? (options.videoWorkflow || null) : null,
        model: options.model || null,
        width: Number.isFinite(options.width) ? options.width : null,
        height: Number.isFinite(options.height) ? options.height : null,
        strictSize: options.video ? (options.strictSize || false) : null,
        count: Number.isFinite(options.count) ? options.count : null,
        tokenType: options.tokenType || 'spark',
        fps: options.video ? options.fps : null,
        duration: options.video ? (options.frames ? options.frames / options.fps : options.duration) : null,
        frames: options.video ? (options.frames ?? null) : null,
        autoResizeVideoAssets: options.video ? (options.autoResizeVideoAssets ?? null) : null,
        refImage: options.video ? (options.refImage ?? null) : null,
        refImageEnd: options.video ? (options.refImageEnd ?? null) : null,
        refAudio: options.video ? (options.refAudio ?? null) : null,
        refVideo: options.video ? (options.refVideo ?? null) : null,
        effectiveWidth: options.video ? (options._effectiveVideoDims?.width ?? null) : null,
        effectiveHeight: options.video ? (options._effectiveVideoDims?.height ?? null) : null,
        adjustedVideoDims: options.video ? (options._adjustedVideoDims ?? null) : null
      };
      if (IS_OPENCLAW_INVOCATION) payload.openclaw = true;
      console.log(JSON.stringify(payload));
      if (!options.json) {
        console.error(`Error: ${error.message}`);
        if (error.hint) console.error(`Hint: ${error.hint}`);
      }
    } else {
      console.error(`Error: ${error.message}`);
      if (error.hint) console.error(`Hint: ${error.hint}`);
    }
  } finally {
    try {
      if (client?.isConnected?.()) {
        await Promise.race([
          client.disconnect(),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
      }
    } catch (e) {}
  }
  process.exit(exitCode);
}

main();
