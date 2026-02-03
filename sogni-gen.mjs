#!/usr/bin/env node
/**
 * sogni-gen - Generate images and videos using Sogni AI
 * Usage: sogni-gen [options] "prompt"
 */

import { SogniClientWrapper, ClientEvent, getMaxContextImages } from '@sogni-ai/sogni-client-wrapper';
import JSON5 from 'json5';
import { createHash, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const LAST_RENDER_PATH = join(homedir(), '.config', 'sogni', 'last-render.json');
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), '.openclaw', 'openclaw.json');
const VIDEO_WORKFLOW_DEFAULT_MODELS = {
  't2v': 'wan_v2.2-14b-fp8_t2v_lightx2v',
  'i2v': 'wan_v2.2-14b-fp8_i2v_lightx2v',
  's2v': 'wan_v2.2-14b-fp8_s2v_lightx2v',
  'animate-move': 'wan_v2.2-14b-fp8_animate-move_lightx2v',
  'animate-replace': 'wan_v2.2-14b-fp8_animate-replace_lightx2v'
};

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
    refImage: opts.refImage || '',
    refImageEnd: opts.refImageEnd || '',
    refAudio: opts.refAudio || '',
    refVideo: opts.refVideo || '',
    contextImages: opts.contextImages || []
  };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest();
  return hash.readUInt32BE(0);
}

function getModelDefaults(modelId, config) {
  if (!modelId || !config?.modelDefaults) return null;
  const entry = config.modelDefaults[modelId];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
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
  tokenType: null,
  steps: null,
  guidance: null,
  seed: null,
  lastSeed: false,
  seedStrategy: null,
  video: false,
  videoWorkflow: null,
  fps: 16,
  duration: 5,
  frames: null,
  refImage: null, // Reference image for video (start frame)
  refImageEnd: null, // End frame for video interpolation
  refAudio: null, // Reference audio for s2v
  refVideo: null, // Reference video for animate workflows
  contextImages: [] // Context images for image editing
};
const cliSet = {
  output: false,
  model: false,
  width: false,
  height: false,
  count: false,
  timeout: false,
  tokenType: false,
  steps: false,
  guidance: false,
  seed: false,
  seedStrategy: false,
  video: false,
  workflow: false,
  fps: false,
  duration: false,
  frames: false,
  refImage: false,
  refImageEnd: false,
  refAudio: false,
  refVideo: false,
  context: false
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
  } else if (arg === '-c' || arg === '--context') {
    options.contextImages.push(args[++i]);
    cliSet.context = true;
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
  } else if (arg === '-q' || arg === '--quiet') {
    options.quiet = true;
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
  -c, --context <path>  Context image for editing (can use multiple)
  --last-image          Use last generated image as context

Video Options:
  --video, -v           Generate video instead of image
  --workflow <type>     Video workflow: t2v|i2v|s2v|animate-move|animate-replace
  --fps <num>           Frames per second (default: 16)
  --duration <sec>      Duration in seconds (default: 5)
  --frames <num>        Override total frames (optional)
  --ref <path|url>      Reference image for video (start frame)
  --ref-end <path|url>  End frame for interpolation/morphing
  --ref-audio <path>    Reference audio for s2v
  --ref-video <path>    Reference video for animate workflows
  --last-image          Use last generated image as reference

General:
  -t, --timeout <sec>   Timeout in seconds (default: 30, video: 300)
  --steps <num>         Override steps (model-dependent)
  --guidance <num>      Override guidance (model-dependent)
  --token-type <type>   Token type: spark|sogni (default: spark)
  --last                Show last render info (JSON)
  --json                Output JSON with all details
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
  sogni-gen --video --ref cat.jpg -o cat.mp4 "cat walks around"
  sogni-gen --video "ocean waves at sunset"
  sogni-gen --video --ref cat.jpg --ref-audio speech.m4a -m wan_v2.2-14b-fp8_s2v_lightx2v "lip sync"
  sogni-gen --video --ref subject.jpg --ref-video motion.mp4 --workflow animate-move "transfer motion"
  sogni-gen --video --last-image "gentle camera pan"
  sogni-gen -c photo.jpg "make the background a beach" -m qwen_image_edit_2511_fp8
  sogni-gen -c subject.jpg -c style.jpg "apply the style to the subject"
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
    console.error('Error: --token-type must be "spark" or "sogni".');
    process.exit(1);
  }
  options.tokenType = token;
}

if (options.seedStrategy) {
  const normalizedStrategy = normalizeSeedStrategy(options.seedStrategy);
  if (!normalizedStrategy) {
    console.error('Error: --seed-strategy must be "random" or "prompt-hash".');
    process.exit(1);
  }
  options.seedStrategy = normalizedStrategy;
}

if (cliSet.steps && !Number.isFinite(options.steps)) {
  console.error('Error: --steps must be a number.');
  process.exit(1);
}

if (cliSet.guidance && !Number.isFinite(options.guidance)) {
  console.error('Error: --guidance must be a number.');
  process.exit(1);
}

// Normalize/validate video workflow before applying defaults
if (options.video) {
  if (options.videoWorkflow) {
    const normalized = normalizeVideoWorkflow(options.videoWorkflow);
    if (!normalized) {
      console.error(`Error: Unknown workflow "${options.videoWorkflow}". Use t2v|i2v|s2v|animate-move|animate-replace.`);
      process.exit(1);
    }
    options.videoWorkflow = normalized;
  }

  const workflowFromModel = inferVideoWorkflowFromModel(options.model);
  if (options.videoWorkflow && workflowFromModel && options.videoWorkflow !== workflowFromModel) {
    console.error(`Error: Workflow "${options.videoWorkflow}" does not match model "${options.model}".`);
    process.exit(1);
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
} else if (options.contextImages.length > 0) {
  // Use qwen edit model when context images provided (unless model explicitly set)
  options.model = options.model || openclawConfig?.defaultEditModel || 'qwen_image_edit_2511_fp8_lightning';
  if (!cliSet.timeout && !timeoutFromConfig && options.timeout === 30000) {
    options.timeout = 60000; // 1 min for editing
  }
} else {
  options.model = options.model || openclawConfig?.defaultImageModel || 'z_image_turbo_bf16';
}

if (!options.prompt) {
  console.error('Error: No prompt provided. Use --help for usage.');
  process.exit(1);
}

if (!options.video && (options.refAudio || options.refVideo || options.videoWorkflow || options.frames)) {
  console.error('Error: Video-only options (--workflow/--frames/--ref-audio/--ref-video) require --video');
  process.exit(1);
}

if (options.video) {
  if (options.videoWorkflow === 't2v') {
    if (options.refImage || options.refImageEnd || options.refAudio || options.refVideo) {
      console.error('Error: t2v does not accept reference image/audio/video.');
      process.exit(1);
    }
  } else if (options.videoWorkflow === 'i2v') {
    if (!options.refImage && !options.refImageEnd) {
      console.error('Error: i2v requires --ref and/or --ref-end.');
      process.exit(1);
    }
    if (options.refAudio || options.refVideo) {
      console.error('Error: i2v does not accept reference audio/video.');
      process.exit(1);
    }
  } else if (options.videoWorkflow === 's2v') {
    if (!options.refImage || !options.refAudio) {
      console.error('Error: s2v requires both --ref and --ref-audio.');
      process.exit(1);
    }
    if (options.refVideo) {
      console.error('Error: s2v does not accept reference video.');
      process.exit(1);
    }
  } else if (options.videoWorkflow === 'animate-move' || options.videoWorkflow === 'animate-replace') {
    if (!options.refImage || !options.refVideo) {
      console.error('Error: animate workflows require both --ref and --ref-video.');
      process.exit(1);
    }
    if (options.refAudio) {
      console.error('Error: animate workflows do not accept reference audio.');
      process.exit(1);
    }
  }
}

// Validate context images against model limits
if (options.contextImages.length > 0 && !options.video) {
  const maxImages = getMaxContextImages(options.model);
  if (maxImages === 0) {
    console.error(`Error: Model ${options.model} does not support context images.`);
    console.error('Try: qwen_image_edit_2511_fp8 or qwen_image_edit_2511_fp8_lightning');
    process.exit(1);
  }
  if (options.contextImages.length > maxImages) {
    console.error(`Error: Model ${options.model} supports max ${maxImages} context images, got ${options.contextImages.length}`);
    process.exit(1);
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

if (options.seed === null || options.seed === undefined) {
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
  
  console.error('Error: No Sogni credentials found.');
  console.error('Create ~/.config/sogni/credentials with:');
  console.error('  SOGNI_USERNAME=your_username');
  console.error('  SOGNI_PASSWORD=your_password');
  process.exit(1);
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
    return Buffer.from(await response.arrayBuffer());
  } else {
    return readFileSync(pathOrUrl);
  }
}

async function main() {
  const creds = loadCredentials();
  const log = options.quiet ? () => {} : console.error.bind(console);
  
  log('Connecting to Sogni...');
  
  const client = new SogniClientWrapper({
    username: creds.SOGNI_USERNAME,
    password: creds.SOGNI_PASSWORD,
    network: openclawConfig?.defaultNetwork || 'fast',
    autoConnect: false,
    authType: 'token'
  });
  
  try {
    await client.connect();
    log('Connected.');
    
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
      
      const imageBuffer = options.refImage ? await fetchMediaBuffer(options.refImage) : undefined;
      const endImageBuffer = options.refImageEnd ? await fetchMediaBuffer(options.refImageEnd) : undefined;
      const audioBuffer = options.refAudio ? await fetchMediaBuffer(options.refAudio) : undefined;
      const videoBuffer = options.refVideo ? await fetchMediaBuffer(options.refVideo) : undefined;
      const modelDefaults = getModelDefaults(options.model, openclawConfig);
      const steps = options.steps ?? modelDefaults?.steps;
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
        waitForCompletion: false
      };

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
      if (steps) {
        projectConfig.steps = steps;
      }
      if (guidance !== null && guidance !== undefined) {
        projectConfig.guidance = guidance;
      }
      
      await client.createVideoProject(projectConfig);
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
        tokenType: options.tokenType || 'spark'
      };
      
      if (options.seed !== null && options.seed !== undefined) {
        editConfig.seed = options.seed;
      }
      
      await client.createImageEditProject(editConfig);
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
        guidance
      };
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
      if (options.video) {
        renderInfo.workflow = options.videoWorkflow;
        renderInfo.fps = options.fps;
        renderInfo.duration = options.frames ? options.frames / options.fps : options.duration;
        if (options.frames) renderInfo.frames = options.frames;
        renderInfo.refImage = options.refImage;
        renderInfo.refImageEnd = options.refImageEnd;
        if (options.refAudio) renderInfo.refAudio = options.refAudio;
        if (options.refVideo) renderInfo.refVideo = options.refVideo;
      }
      if (options.contextImages.length > 0) {
        renderInfo.contextImages = options.contextImages;
      }
      saveLastRender(renderInfo);
      
      // Save to file if requested
      if (options.output && urls[0]) {
        const response = await fetch(urls[0]);
        const buffer = Buffer.from(await response.arrayBuffer());
        
        const dir = dirname(options.output);
        if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        
        writeFileSync(options.output, buffer);
        log(`Saved to ${options.output}`);
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
        if (options.video) {
          output.workflow = options.videoWorkflow;
          output.fps = options.fps;
          output.duration = options.frames ? options.frames / options.fps : options.duration;
          if (options.frames) output.frames = options.frames;
          if (options.refImage) output.refImage = options.refImage;
          if (options.refImageEnd) output.refImageEnd = options.refImageEnd;
          if (options.refAudio) output.refAudio = options.refAudio;
          if (options.refVideo) output.refVideo = options.refVideo;
        }
        if (options.contextImages.length > 0) {
          output.contextImages = options.contextImages;
        }
        console.log(JSON.stringify(output));
      } else {
        urls.forEach(url => console.log(url));
      }
    } else {
      throw new Error('No output generated - may have been filtered');
    }
    
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({
        success: false,
        error: error.message,
        prompt: options.prompt
      }));
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exit(1);
    
  } finally {
    try {
      if (client.isConnected?.()) await client.disconnect();
    } catch (e) {}
    process.exit(0);
  }
}

main();
