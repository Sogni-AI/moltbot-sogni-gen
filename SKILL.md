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
        command: "cd {{skillDir}} && npm install"
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

3. **Install dependencies:**
```bash
cd /path/to/sogni-gen
npm install
```

## Usage (Images & Video)

```bash
# Generate and get URL
node sogni-gen.mjs "a cat wearing a hat"

# Save to file
node sogni-gen.mjs -o /tmp/cat.png "a cat wearing a hat"

# JSON output (for scripting)
node sogni-gen.mjs --json "a cat wearing a hat"

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
| `-c, --context <path>` | Context image for editing | - |
| `--last-image` | Use last generated image as context/ref | - |
| `--video, -v` | Generate video instead of image | - |
| `--fps <num>` | Frames per second (video) | 16 |
| `--duration <sec>` | Duration in seconds (video) | 5 |
| `--ref <path>` | Reference image for video | required for video |
| `--last` | Show last render info | - |
| `--json` | JSON output | false |
| `-q, --quiet` | No progress output | false |

## Image Models

| Model | Speed | Use Case |
|-------|-------|----------|
| `z_image_turbo_bf16` | Fast (~5-10s) | General purpose, default |
| `flux1-schnell-fp8` | Very fast | Quick iterations |
| `flux2_dev_fp8` | Slow (~2min) | High quality |
| `chroma-v.46-flash_fp8` | Medium | Balanced |
| `qwen_image_edit_2511_fp8` | Medium | Image editing with context (up to 3) |
| `qwen_image_edit_2511_fp8_lightning` | Fast | Quick image editing |

## Video Models

| Model | Speed | Use Case |
|-------|-------|----------|
| `wan_v2.2-14b-fp8_i2v_lightx2v` | Fast | Default video generation |
| `wan_v2.2-14b-fp8_i2v` | Slow | Higher quality video |

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

## Video Generation

Generate videos from a reference image:

```bash
# Basic video from image
node sogni-gen.mjs --video --ref cat.jpg -o cat.mp4 "cat walks around"

# Use last generated image as reference
node sogni-gen.mjs --last-image --video "gentle camera pan"

# Custom duration and FPS
node sogni-gen.mjs --video --ref scene.png --duration 10 --fps 24 "zoom out slowly"
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

## Agent Usage

When user asks to generate/draw/create an image:

```bash
# Generate and save locally
node {{skillDir}}/sogni-gen.mjs -q -o /tmp/generated.png "user's prompt"

# Edit an existing image
node {{skillDir}}/sogni-gen.mjs -q -c /path/to/input.jpg -o /tmp/edited.png "make it pop art style"

# Generate video from image
node {{skillDir}}/sogni-gen.mjs -q --video --ref /path/to/image.png -o /tmp/video.mp4 "camera slowly zooms in"

# Then send via message tool with filePath
```

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

## Cost

Uses Spark tokens from your Sogni account. 512x512 images are most cost-efficient.

## Troubleshooting

- **Auth errors**: Check credentials in `~/.config/sogni/credentials`
- **Timeouts**: Try a faster model or increase `-t` timeout
- **No workers**: Check https://sogni.ai for network status
