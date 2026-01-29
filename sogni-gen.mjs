#!/usr/bin/env node
/**
 * sogni-gen - Generate images and videos using Sogni AI
 * Usage: sogni-gen [options] "prompt"
 */

import { SogniClientWrapper, ClientEvent, supportsContextImages, getMaxContextImages } from '@sogni-ai/sogni-client-wrapper';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const LAST_RENDER_PATH = join(homedir(), '.config', 'sogni', 'last-render.json');

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
  seed: null,
  lastSeed: false,
  video: false,
  fps: 16,
  duration: 5,
  refImage: null, // Reference image for video (start frame)
  refImageEnd: null, // End frame for video interpolation
  contextImages: [] // Context images for image editing
};

// Parse CLI args
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-o' || arg === '--output') {
    options.output = args[++i];
  } else if (arg === '-m' || arg === '--model') {
    options.model = args[++i];
  } else if (arg === '-w' || arg === '--width') {
    options.width = parseInt(args[++i]);
  } else if (arg === '-h' || arg === '--height') {
    options.height = parseInt(args[++i]);
  } else if (arg === '-n' || arg === '--count') {
    options.count = parseInt(args[++i]);
  } else if (arg === '-t' || arg === '--timeout') {
    options.timeout = parseInt(args[++i]) * 1000;
  } else if (arg === '-s' || arg === '--seed') {
    options.seed = parseInt(args[++i]);
  } else if (arg === '--last-seed' || arg === '--reseed') {
    options.lastSeed = true;
  } else if (arg === '--video' || arg === '-v') {
    options.video = true;
  } else if (arg === '--fps') {
    options.fps = parseInt(args[++i]);
  } else if (arg === '--duration') {
    options.duration = parseInt(args[++i]);
  } else if (arg === '--ref' || arg === '--reference') {
    options.refImage = args[++i];
  } else if (arg === '--ref-end' || arg === '--end') {
    options.refImageEnd = args[++i];
  } else if (arg === '-c' || arg === '--context') {
    options.contextImages.push(args[++i]);
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
  -c, --context <path>  Context image for editing (can use multiple)
  --last-image          Use last generated image as context

Video Options:
  --video, -v           Generate video instead of image
  --fps <num>           Frames per second (default: 16)
  --duration <sec>      Duration in seconds (default: 5)
  --ref <path|url>      Reference image for video (start frame)
  --ref-end <path|url>  End frame for interpolation/morphing
  --last-image          Use last generated image as reference

General:
  -t, --timeout <sec>   Timeout in seconds (default: 30, video: 300)
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
  wan_v2.2-14b-fp8_i2v_lightx2v   Fast (default)
  wan_v2.2-14b-fp8_i2v            Higher quality

Examples:
  sogni-gen "a cat wearing a hat"
  sogni-gen -o cat.jpg "a cat" 
  sogni-gen --video --ref cat.jpg -o cat.mp4 "cat walks around"
  sogni-gen --video --last-image "gentle camera pan"
  sogni-gen -c photo.jpg "make the background a beach" -m qwen_image_edit_2511_fp8
  sogni-gen -c subject.jpg -c style.jpg "apply the style to the subject"
`);
    process.exit(0);
  } else if (!arg.startsWith('-') && !options.prompt) {
    options.prompt = arg;
  }
}

// Resolve --last-image: video uses refImage, image uses contextImages
if (options._lastImagePath) {
  if (options.video) {
    options.refImage = options._lastImagePath;
  } else {
    options.contextImages.push(options._lastImagePath);
  }
  delete options._lastImagePath;
}

// Set defaults based on type and context
if (options.video) {
  options.model = options.model || 'wan_v2.2-14b-fp8_i2v_lightx2v';
  options.timeout = options.timeout === 30000 ? 300000 : options.timeout; // 5 min for video
} else if (options.contextImages.length > 0) {
  // Use qwen edit model when context images provided (unless model explicitly set)
  options.model = options.model || 'qwen_image_edit_2511_fp8_lightning';
  options.timeout = options.timeout === 30000 ? 60000 : options.timeout; // 1 min for editing
} else {
  options.model = options.model || 'z_image_turbo_bf16';
}

if (!options.prompt) {
  console.error('Error: No prompt provided. Use --help for usage.');
  process.exit(1);
}

if (options.video && !options.refImage) {
  console.error('Error: Video generation requires a reference image (--ref or --last-image)');
  process.exit(1);
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
    console.error('Warning: No previous render found, using random seed');
  }
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
async function fetchImageBuffer(pathOrUrl) {
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
    network: 'fast',
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
      log(`Generating video with ${options.model}...`);
      log(`Reference: ${options.refImage}`);
      if (options.refImageEnd) log(`End frame: ${options.refImageEnd}`);
      
      const imageBuffer = await fetchImageBuffer(options.refImage);
      const endImageBuffer = options.refImageEnd ? await fetchImageBuffer(options.refImageEnd) : undefined;
      const frames = options.fps * options.duration;
      
      const projectConfig = {
        type: 'video',
        modelId: options.model,
        positivePrompt: options.prompt,
        negativePrompt: '',
        stylePrompt: '',
        numberOfMedia: options.count,
        referenceImage: imageBuffer,
        frames: frames,
        fps: options.fps,
        width: options.width,
        height: options.height,
        tokenType: 'spark',
        waitForCompletion: false
      };
      
      // Add end frame for interpolation if provided
      if (endImageBuffer) {
        projectConfig.referenceImageEnd = endImageBuffer;
      }
      
      await client.createProject(projectConfig);
    } else if (options.contextImages.length > 0) {
      // Image editing with context images
      log(`Editing with ${options.model}...`);
      log(`Context images: ${options.contextImages.length}`);
      if (options.seed) log(`Using seed: ${options.seed}`);
      
      // Load all context images as buffers
      const contextBuffers = await Promise.all(
        options.contextImages.map(img => fetchImageBuffer(img))
      );
      
      const editConfig = {
        modelId: options.model,
        positivePrompt: options.prompt,
        contextImages: contextBuffers,
        numberOfMedia: options.count,
        width: options.width,
        height: options.height,
        steps: options.model.includes('lightning') ? 4 : 20,
        guidance: options.model.includes('lightning') ? 3.5 : 7.5
      };
      
      if (options.seed) {
        editConfig.seed = options.seed;
      }
      
      await client.createImageEditProject(editConfig);
    } else {
      // Standard image generation
      log(`Generating with ${options.model}...`);
      if (options.seed) log(`Using seed: ${options.seed}`);
      
      const projectConfig = {
        type: 'image',
        modelId: options.model,
        positivePrompt: options.prompt,
        negativePrompt: '',
        stylePrompt: '',
        numberOfImages: options.count,
        tokenType: 'spark',
        waitForCompletion: false,
        sizePreset: 'custom',
        width: options.width,
        height: options.height,
        guidance: 1.0
      };
      
      if (options.seed) {
        projectConfig.seed = options.seed;
      }
      
      await client.createProject(projectConfig);
    }
    
    // Wait for completion via events
    await completionPromise;
    
    if (results.length > 0) {
      const urls = results.map(r => options.video ? r.videoUrl : r.imageUrl).filter(Boolean);
      const firstResult = results[0];
      
      // Save last render info
      const renderInfo = {
        timestamp: new Date().toISOString(),
        type: options.video ? 'video' : 'image',
        prompt: options.prompt,
        model: options.model,
        width: options.width,
        height: options.height,
        seed: firstResult.seed,
        seeds: results.map(r => r.seed),
        projectId: firstResult.projectId,
        urls: urls,
        localPath: options.output || null
      };
      if (options.video) {
        renderInfo.fps = options.fps;
        renderInfo.duration = options.duration;
        renderInfo.refImage = options.refImage;
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
          seed: firstResult.seed,
          seeds: results.map(r => r.seed),
          urls: urls,
          localPath: options.output || null
        };
        if (options.video) {
          output.fps = options.fps;
          output.duration = options.duration;
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
