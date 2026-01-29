<p align="center">
  <img src="screenshot.jpg" alt="Telegram image render workflow" width="320" />
</p>

# Image & Video gen for 🦞 Moltbot

🎨 Generate **images and videos** using [Sogni AI](https://sogni.ai)'s decentralized GPU network.

A [Clawdbot](https://github.com/clawdbot/clawdbot) skill for AI image + video generation.

## Installation

### As a Clawdbot Skill

```bash
# Install from npm (no git clone)
mkdir -p ~/.clawdbot/skills
cd ~/.clawdbot/skills
npm i sogni-gen
ln -sfn node_modules/sogni-gen sogni-gen
```

```bash
# Or clone to your skills directory
git clone https://github.com/mauvis/sogni-gen ~/.clawdbot/skills/sogni-gen
cd ~/.clawdbot/skills/sogni-gen
npm install
```

### Standalone

```bash
git clone https://github.com/mauvis/sogni-gen
cd sogni-gen
npm install
```

## Setup

1. Create a Sogni account at https://sogni.ai
2. Create credentials file:

```bash
mkdir -p ~/.config/sogni
cat > ~/.config/sogni/credentials << 'EOF'
SOGNI_USERNAME=your_username
SOGNI_PASSWORD=your_password
EOF
chmod 600 ~/.config/sogni/credentials
```

## Usage

```bash
# Generate image, get URL
node sogni-gen.mjs "a dragon eating tacos"

# Save to file
node sogni-gen.mjs -o dragon.png "a dragon eating tacos"

# JSON output
node sogni-gen.mjs --json "a dragon eating tacos"

# Different model
node sogni-gen.mjs -m flux1-schnell-fp8 "a dragon eating tacos"
```

## Options

```
-o, --output <path>   Save image to file
-m, --model <id>      Model (default: z_image_turbo_bf16)
-w, --width <px>      Width (default: 512)
-h, --height <px>     Height (default: 512)
-n, --count <num>     Number of images (default: 1)
-t, --timeout <sec>   Timeout (default: 30)
--json                JSON output
-q, --quiet           Suppress progress
```

## Models

| Model | Speed | Notes |
|-------|-------|-------|
| `z_image_turbo_bf16` | ~5-10s | Default, general purpose |
| `flux1-schnell-fp8` | ~3-5s | Fast iterations |
| `flux2_dev_fp8` | ~2min | High quality |
| `chroma-v.46-flash_fp8` | ~30s | Balanced |

## With Clawdbot

Once installed, just ask your agent:

> "Draw me a picture of a slothicorn eating a banana"

The agent will generate the image and send it to your chat.

## License

MIT
