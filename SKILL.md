---
name: sogni-gen
description: Generate images **and videos** using Sogni AI's decentralized network. Ask the agent to "draw", "generate", "create an image", or "make a video/animate" from a prompt or reference image.
homepage: https://sogni.ai
metadata:
  clawdbot:
    emoji: "🎨"
    os: ["darwin", "linux", "win32"]
    requires:
      bins: ["node"]
    install:
      - id: npm
        kind: exec
        command: "cd {{skillDir}} && npm i"
        label: "Install dependencies"
---

# Sogni Image & Video Generation

Generate **images and videos** using Sogni AI's decentralized GPU network.

## Setup

1. **Get Sogni credentials** at https://sogni.ai
2. **Create credentials file:**
```bash
mkdir -p ~/.config/sogni
cat > ~/.config/sogni/credentials << 'EOF'
SOGNI_USERNAME=your_username
SOGNI_PASSWORD=your_password
EOF
chmod 600 ~/.config/sogni/credentials
```

3. **Install dependencies (if cloned):**
```bash
cd /path/to/sogni-gen
npm i
```

4. **Or install from npm (no git clone):**
```bash
mkdir -p ~/.clawdbot/skills
cd ~/.clawdbot/skills
npm i sogni-gen
ln -sfn node_modules/sogni-gen sogni-gen
```

## Usage (Images & Video)

```bash
# Generate and get URL
node sogni-gen.mjs "a cat wearing a hat"

# Save to file
node sogni-gen.mjs -o /tmp/cat.png "a cat wearing a hat"

# JSON output (for scripting)
node sogni-gen.mjs --json "a cat wearing a hat"

# Check token balances (no prompt required)
node sogni-gen.mjs --balance

# Check token balances in JSON
node sogni-gen.mjs --json --balance

# Quiet mode (suppress progress)
node sogni-gen.mjs -q -o /tmp/cat.png "a cat wearing a hat"
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-o, --output <path>` | Save to file | prints URL |
| `-m, --model <id>` | Model ID | z_image_turbo_bf16 |
| `-w, --width <px>` | Width | 512 |
| `-h, --height <px>` | Height | 512 |
| `-n, --count <num>` | Number of images | 1 |
| `-t, --timeout <sec>` | Timeout seconds | 30 (300 for video) |
| `-s, --seed <num>` | Specific seed | random |
| `--last-seed` | Reuse seed from last render | - |
| `--seed-strategy <s>` | Seed strategy: random\|prompt-hash | prompt-hash |
| `--multi-angle` | Multiple angles LoRA mode (Qwen Image Edit) | - |
| `--angles-360` | Generate 8 azimuths (front -> front-left) | - |
| `--angles-360-video` | Assemble looping 360 mp4 using i2v between angles (requires ffmpeg) | - |
| `--azimuth <key>` | front\|front-right\|right\|back-right\|back\|back-left\|left\|front-left | front |
| `--elevation <key>` | low-angle\|eye-level\|elevated\|high-angle | eye-level |
| `--distance <key>` | close-up\|medium\|wide | medium |
| `--angle-strength <n>` | LoRA strength for multiple_angles | 0.9 |
| `--angle-description <text>` | Optional subject description | - |
| `--steps <num>` | Override steps (model-dependent) | - |
| `--guidance <num>` | Override guidance (model-dependent) | - |
| `--output-format <f>` | Image output format: png\|jpg | png |
| `--sampler <name>` | Sampler (model-dependent) | - |
| `--scheduler <name>` | Scheduler (model-dependent) | - |
| `--lora <id>` | LoRA id (repeatable, edit only) | - |
| `--loras <ids>` | Comma-separated LoRA ids | - |
| `--lora-strength <n>` | LoRA strength (repeatable) | - |
| `--lora-strengths <n>` | Comma-separated LoRA strengths | - |
| `--token-type <type>` | Token type: spark\|sogni | spark |
| `--balance, --balances` | Show SPARK/SOGNI balances and exit | - |
| `-c, --context <path>` | Context image for editing | - |
| `--last-image` | Use last generated image as context/ref | - |
| `--video, -v` | Generate video instead of image | - |
| `--workflow <type>` | Video workflow (t2v|i2v|s2v|animate-move|animate-replace) | inferred |
| `--fps <num>` | Frames per second (video) | 16 |
| `--duration <sec>` | Duration in seconds (video) | 5 |
| `--frames <num>` | Override total frames (video) | - |
| `--auto-resize-assets` | Auto-resize video assets | true |
| `--no-auto-resize-assets` | Disable auto-resize | - |
| `--estimate-video-cost` | Estimate video cost and exit (requires --steps) | - |
| `--photobooth` | Face transfer mode (InstantID + SDXL Turbo) | - |
| `--cn-strength <n>` | ControlNet strength (photobooth) | 0.8 |
| `--cn-guidance-end <n>` | ControlNet guidance end point (photobooth) | 0.3 |
| `--ref <path>` | Reference image for video or photobooth face | required for video/photobooth |
| `--ref-end <path>` | End frame for i2v interpolation | - |
| `--ref-audio <path>` | Reference audio for s2v | - |
| `--ref-video <path>` | Reference video for animate workflows | - |
| `--last` | Show last render info | - |
| `--json` | JSON output | false |
| `--strict-size` | Do not auto-adjust i2v video size for reference resizing constraints | false |
| `-q, --quiet` | No progress output | false |

## OpenClaw Config Defaults

When installed as an OpenClaw plugin, `sogni-gen` will read defaults from:

`~/.openclaw/openclaw.json`

```json
{
  "plugins": {
    "entries": {
      "sogni-gen": {
        "enabled": true,
        "config": {
          "defaultImageModel": "z_image_turbo_bf16",
          "defaultEditModel": "qwen_image_edit_2511_fp8_lightning",
          "defaultPhotoboothModel": "coreml-sogniXLturbo_alpha1_ad",
          "videoModels": {
            "t2v": "wan_v2.2-14b-fp8_t2v_lightx2v",
            "i2v": "wan_v2.2-14b-fp8_i2v_lightx2v",
            "s2v": "wan_v2.2-14b-fp8_s2v_lightx2v",
            "animate-move": "wan_v2.2-14b-fp8_animate-move_lightx2v",
            "animate-replace": "wan_v2.2-14b-fp8_animate-replace_lightx2v"
          },
          "defaultVideoWorkflow": "t2v",
          "defaultNetwork": "fast",
          "defaultTokenType": "spark",
          "seedStrategy": "prompt-hash",
          "modelDefaults": {
            "flux1-schnell-fp8": { "steps": 4, "guidance": 3.5 },
            "flux2_dev_fp8": { "steps": 20, "guidance": 7.5 }
          },
          "defaultWidth": 768,
          "defaultHeight": 768,
          "defaultCount": 1,
          "defaultFps": 16,
          "defaultDurationSec": 5,
          "defaultImageTimeoutSec": 30,
          "defaultVideoTimeoutSec": 300
        }
      }
    }
  }
}
```

CLI flags always override these defaults.
If your OpenClaw config lives elsewhere, set `OPENCLAW_CONFIG_PATH`.
Seed strategies: `prompt-hash` (deterministic) or `random`.

## Image Models

| Model | Speed | Use Case |
|-------|-------|----------|
| `z_image_turbo_bf16` | Fast (~5-10s) | General purpose, default |
| `flux1-schnell-fp8` | Very fast | Quick iterations |
| `flux2_dev_fp8` | Slow (~2min) | High quality |
| `chroma-v.46-flash_fp8` | Medium | Balanced |
| `qwen_image_edit_2511_fp8` | Medium | Image editing with context (up to 3) |
| `qwen_image_edit_2511_fp8_lightning` | Fast | Quick image editing |
| `coreml-sogniXLturbo_alpha1_ad` | Fast | Photobooth face transfer (SDXL Turbo) |

## Video Models

| Model | Speed | Use Case |
|-------|-------|----------|
| `wan_v2.2-14b-fp8_i2v_lightx2v` | Fast | Default video generation |
| `wan_v2.2-14b-fp8_i2v` | Slow | Higher quality video |
| `wan_v2.2-14b-fp8_t2v_lightx2v` | Fast | Text-to-video |
| `wan_v2.2-14b-fp8_s2v_lightx2v` | Fast | Sound-to-video |
| `wan_v2.2-14b-fp8_animate-move_lightx2v` | Fast | Animate-move |
| `wan_v2.2-14b-fp8_animate-replace_lightx2v` | Fast | Animate-replace |

## Image Editing with Context

Edit images using reference images (Qwen models support up to 3):

```bash
# Single context image
node sogni-gen.mjs -c photo.jpg "make the background a beach"

# Multiple context images (subject + style)
node sogni-gen.mjs -c subject.jpg -c style.jpg "apply the style to the subject"

# Use last generated image as context
node sogni-gen.mjs --last-image "make it more vibrant"
```

When context images are provided without `-m`, defaults to `qwen_image_edit_2511_fp8_lightning`.

## Photobooth (Face Transfer)

Generate stylized portraits from a face photo using InstantID ControlNet. When a user mentions "photobooth", wants a stylized portrait of themselves, or asks to transfer their face into a style, use `--photobooth` with `--ref` pointing to their face image.

```bash
# Basic photobooth
node sogni-gen.mjs --photobooth --ref face.jpg "80s fashion portrait"

# Multiple outputs
node sogni-gen.mjs --photobooth --ref face.jpg -n 4 "LinkedIn professional headshot"

# Custom ControlNet tuning
node sogni-gen.mjs --photobooth --ref face.jpg --cn-strength 0.6 --cn-guidance-end 0.5 "oil painting"
```

Uses SDXL Turbo (`coreml-sogniXLturbo_alpha1_ad`) at 1024x1024 by default. The face image is passed via `--ref` and styled according to the prompt. Cannot be combined with `--video` or `-c/--context`.

**Agent usage:**
```bash
# Photobooth: stylize a face photo
node {{skillDir}}/sogni-gen.mjs -q --photobooth --ref /path/to/face.jpg -o /tmp/stylized.png "80s fashion portrait"

# Multiple photobooth outputs
node {{skillDir}}/sogni-gen.mjs -q --photobooth --ref /path/to/face.jpg -n 4 -o /tmp/stylized.png "LinkedIn professional headshot"
```

## Multiple Angles (Turnaround)

Generate specific camera angles from a single reference image using the Multiple Angles LoRA:

```bash
# Single angle
node sogni-gen.mjs --multi-angle -c subject.jpg \
  --azimuth front-right --elevation eye-level --distance medium \
  --angle-strength 0.9 \
  "studio portrait, same person"

# 360 sweep (8 azimuths)
node sogni-gen.mjs --angles-360 -c subject.jpg --distance medium --elevation eye-level \
  "studio portrait, same person"

# 360 sweep video (looping mp4, uses i2v between angles; requires ffmpeg)
node sogni-gen.mjs --angles-360 --angles-360-video /tmp/turntable.mp4 \
  -c subject.jpg --distance medium --elevation eye-level \
  "studio portrait, same person"
```

The prompt is auto-built with the required `<sks>` token plus the selected camera angle keywords.
`--angles-360-video` generates i2v clips between consecutive angles (including last→first) and concatenates them with ffmpeg for a seamless loop.

### 360 Video Best Practices

When a user requests a "360 video", follow this workflow:

1. **Default camera parameters** (do not ask unless they specify):
   - **Elevation**: default to **medium**
   - **Distance**: default to **medium**

2. **Map user terms to flags**:
   | User says | Flag value |
   |-----------|------------|
   | "high" angle | `--elevation high-angle` |
   | "medium" angle | `--elevation eye-level` |
   | "low" angle | `--elevation low-angle` |
   | "close" | `--distance close-up` |
   | "medium" distance | `--distance medium` |
   | "far" | `--distance wide` |

3. **Always use first-frame/last-frame stitching** - the `--angles-360-video` flag automatically handles this by generating i2v clips between consecutive angles including last→first for seamless looping.

4. **Example command**:
   ```bash
   node sogni-gen.mjs --angles-360 --angles-360-video /tmp/output.mp4 \
     -c /path/to/image.png --elevation eye-level --distance medium \
     "description of subject"
   ```

### Transition Video Rule

For **any transition video work**, always use the **Sogni skill/plugin** (not ffmpeg or other methods) unless explicitly told otherwise.

### Insufficient Funds Handling

When you see **"Debit Error: Insufficient funds"**, reply:

"Insufficient funds. Claim 50 free daily Spark points at https://app.sogni.ai/"

## Video Generation

Generate videos from a reference image:

```bash
# Text-to-video (t2v)
node sogni-gen.mjs --video "ocean waves at sunset"

# Basic video from image
node sogni-gen.mjs --video --ref cat.jpg -o cat.mp4 "cat walks around"

# Use last generated image as reference
node sogni-gen.mjs --last-image --video "gentle camera pan"

# Custom duration and FPS
node sogni-gen.mjs --video --ref scene.png --duration 10 --fps 24 "zoom out slowly"

# Sound-to-video (s2v)
node sogni-gen.mjs --video --ref face.jpg --ref-audio speech.m4a \
  -m wan_v2.2-14b-fp8_s2v_lightx2v "lip sync talking head"

# Animate (motion transfer)
node sogni-gen.mjs --video --ref subject.jpg --ref-video motion.mp4 \
  --workflow animate-move "transfer motion"
```

## Photo Restoration

Restore damaged vintage photos using Qwen image editing:

```bash
# Basic restoration
sogni-gen -c damaged_photo.jpg -o restored.png \
  "professionally restore this vintage photograph, remove damage and scratches"

# Detailed restoration with preservation hints
sogni-gen -c old_photo.jpg -o restored.png -w 1024 -h 1280 \
  "restore this vintage photo, remove peeling, tears and wear marks, \
  preserve natural features and expression, maintain warm nostalgic color tones"
```

**Tips for good restorations:**
- Describe the damage: "peeling", "scratches", "tears", "fading"
- Specify what to preserve: "natural features", "eye color", "hair", "expression"
- Mention the era for color tones: "1970s warm tones", "vintage sepia"

**Finding received images (Telegram/etc):**
```bash
ls -la ~/.clawdbot/media/inbound/*.jpg | tail -3
cp ~/.clawdbot/media/inbound/<latest>.jpg /tmp/to_restore.jpg
```

## IMPORTANT KEYWORD RULE

- If the user message includes the word "photobooth" (case-insensitive), always use `--photobooth` mode with `--ref` set to the user-provided face image.
- Prioritize this rule over generic image-edit flows (`-c`) for that request.

## Agent Usage

When user asks to generate/draw/create an image:

```bash
# Generate and save locally
node {{skillDir}}/sogni-gen.mjs -q -o /tmp/generated.png "user's prompt"

# Edit an existing image
node {{skillDir}}/sogni-gen.mjs -q -c /path/to/input.jpg -o /tmp/edited.png "make it pop art style"

# Generate video from image
node {{skillDir}}/sogni-gen.mjs -q --video --ref /path/to/image.png -o /tmp/video.mp4 "camera slowly zooms in"

# Generate text-to-video
node {{skillDir}}/sogni-gen.mjs -q --video -o /tmp/video.mp4 "ocean waves at sunset"

# Photobooth: stylize a face photo
node {{skillDir}}/sogni-gen.mjs -q --photobooth --ref /path/to/face.jpg -o /tmp/stylized.png "80s fashion portrait"

# Check current SPARK/SOGNI balances (no prompt required)
node {{skillDir}}/sogni-gen.mjs --json --balance

# Then send via message tool with filePath
```

## Animate Between Two Images (First-Frame / Last-Frame)

When a user asks to **animate between two images**, use `--ref` (first frame) and `--ref-end` (last frame) to create a creative interpolation video:

```bash
# Animate from image A to image B
node {{skillDir}}/sogni-gen.mjs -q --video --ref /tmp/imageA.png --ref-end /tmp/imageB.png -o /tmp/transition.mp4 "descriptive prompt of the transition"
```

### Animate a Video to an Image (Scene Continuation)

When a user asks to **animate from a video to an image** (or "continue" a video into a new scene):

1. **Extract the last frame** of the existing video:
   ```bash
   ffmpeg -y -sseof -0.1 -i /tmp/existing.mp4 -frames:v 1 -update 1 /tmp/lastframe.png
   ```
2. **Generate a new video** using the last frame as `--ref` and the target image as `--ref-end`:
   ```bash
   node {{skillDir}}/sogni-gen.mjs -q --video --ref /tmp/lastframe.png --ref-end /tmp/target.png -o /tmp/continuation.mp4 "scene transition prompt"
   ```
3. **Stitch the videos** together with ffmpeg:
   ```bash
   ffmpeg -y -i /tmp/existing.mp4 -i /tmp/continuation.mp4 \
     -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[outv]" \
     -map "[outv]" -c:v libx264 -crf 18 /tmp/full_sequence.mp4
   ```

This ensures visual continuity — the new clip picks up exactly where the previous one ended.

**Always apply this pattern when:**
- User says "animate image A to image B" → use `--ref A --ref-end B`
- User says "animate this video to this image" → extract last frame, use as `--ref`, target image as `--ref-end`, then stitch
- User says "continue this video" with a target image → same as above

## JSON Output

```json
{
  "success": true,
  "prompt": "a cat wearing a hat",
  "model": "z_image_turbo_bf16", 
  "width": 512,
  "height": 512,
  "urls": ["https://..."],
  "localPath": "/tmp/cat.png"
}
```

On error (with `--json`), the script returns a single JSON object like:

```json
{
  "success": false,
  "error": "Video width and height must be divisible by 16 (got 500x512).",
  "errorCode": "INVALID_VIDEO_SIZE",
  "hint": "Choose --width/--height divisible by 16. For i2v, also match the reference aspect ratio."
}
```

Balance check example (`--json --balance`):

```json
{
  "success": true,
  "type": "balance",
  "spark": 12.34,
  "sogni": 0.56
}
```

## Cost

Uses Spark tokens from your Sogni account. 512x512 images are most cost-efficient.

## Troubleshooting

- **Auth errors**: Check credentials in `~/.config/sogni/credentials`
- **i2v sizing gotchas**: Video sizes are constrained (min 480px, max 1536px, divisible by 16). For i2v, the client wrapper resizes the reference (`fit: inside`) and uses the resized dimensions as the final video size. Because this uses rounding, a requested size can still yield an invalid final size (example: `1024x1536` requested but ref becomes `1024x1535`).
- **Auto-adjustment**: With a local `--ref`, the script will auto-adjust the requested size to avoid non-16 resized reference dimensions.
- **If the script adjusts your size but you want to fail instead**: pass `--strict-size` and it will print a suggested `--width/--height`.
- **Timeouts**: Try a faster model or increase `-t` timeout
- **No workers**: Check https://sogni.ai for network status
