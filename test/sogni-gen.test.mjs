import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIN_NODE_VERSION = [22, 11, 0];

function isVersionAtLeast(current, required) {
  for (let i = 0; i < required.length; i++) {
    const currentValue = current[i] ?? 0;
    const requiredValue = required[i] ?? 0;
    if (currentValue > requiredValue) return true;
    if (currentValue < requiredValue) return false;
  }
  return true;
}

const currentNodeVersion = process.versions.node.split('.').map((part) => Number(part));
if (!isVersionAtLeast(currentNodeVersion, MIN_NODE_VERSION)) {
  throw new Error(`Node >= ${MIN_NODE_VERSION.join('.')} is required. Current: ${process.versions.node}`);
}
const PACKAGE_VERSION = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;

function runCli(args) {
  const tempHome = mkdtempSync(join(tmpdir(), 'sogni-gen-test-'));
  const statePath = join(tempHome, 'state.json');
  const loaderPath = join(process.cwd(), 'test', 'loader.mjs');
  const cliPath = join(process.cwd(), 'sogni-gen.mjs');

  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_CONFIG_PATH: join(tempHome, 'openclaw.json'),
    OPENCLAW_PLUGIN_CONFIG: '',
    SOGNI_USERNAME: 'test-user',
    SOGNI_PASSWORD: 'test-pass',
    SOGNI_GEN_TEST_STATE_PATH: statePath,
    NODE_NO_WARNINGS: '1'
  };

  const result = spawnSync(
    process.execPath,
    ['--loader', loaderPath, cliPath, ...args],
    { env, encoding: 'utf8' }
  );

  if (result.error) {
    throw result.error;
  }

  let state = null;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (err) {
    state = null;
  }

  return {
    exitCode: result.status,
    state,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function expectCliError(args, messageIncludes) {
  const { exitCode, stderr } = runCli(args);
  assert.equal(exitCode, 1);
  if (messageIncludes) {
    assert.ok(
      stderr.includes(messageIncludes),
      `Expected stderr to include "${messageIncludes}", got: ${stderr}`
    );
  }
}

test('default image generation uses 512x512 and prompt', () => {
  const { exitCode, state } = runCli(['a cat wearing a hat']);
  assert.equal(exitCode, 0);
  assert.ok(state?.lastImageProject, 'createImageProject was called');
  assert.equal(state.lastImageProject.width, 512);
  assert.equal(state.lastImageProject.height, 512);
  assert.equal(state.lastImageProject.positivePrompt, 'a cat wearing a hat');
  assert.equal(state.lastImageProject.tokenType, 'spark');
  assert.equal(state.lastImageProject.sizePreset, 'custom');
});

test('unknown CLI flag returns a validation error', () => {
  const { exitCode, stderr } = runCli(['--not-a-real-flag', 'a cat wearing a hat']);
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes('Unknown option: --not-a-real-flag'));
});

test('invalid width returns a validation error', () => {
  const { exitCode, stderr } = runCli(['--width', 'foo', 'a cat wearing a hat']);
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes('--width must be an integer.'));
});

test('invalid seed returns a validation error', () => {
  const { exitCode, stderr } = runCli(['--seed', 'foo', 'a cat wearing a hat']);
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes('--seed must be an integer.'));
});

test('missing required value for --width returns a validation error', () => {
  expectCliError(['--width'], '--width requires a value.');
});

test('out-of-range seed returns a validation error', () => {
  expectCliError(['--seed', '4294967296', 'a cat'], '--seed must be between 0 and 4294967295.');
});

test('invalid token type returns a validation error', () => {
  expectCliError(['--token-type', 'gold', 'a cat'], '--token-type must be "spark" or "sogni".');
});

test('invalid seed strategy returns a validation error', () => {
  expectCliError(['--seed-strategy', 'foo', 'a cat'], '--seed-strategy must be "random" or "prompt-hash".');
});

test('invalid image output format returns a validation error', () => {
  expectCliError(['--output-format', 'webp', 'a cat'], 'Image output format must be "png" or "jpg".');
});

test('invalid video output format returns a validation error', () => {
  expectCliError(['--video', '--output-format', 'jpg', 'a cat'], 'Video output format must be "mp4".');
});

test('video-only options without --video return a validation error', () => {
  expectCliError(['--workflow', 'i2v', 'a cat'], 'Video-only options');
});

test('t2v rejects reference assets', () => {
  expectCliError(['--video', '--workflow', 't2v', '--ref', 'screenshot.jpg', 'a cat'], 't2v does not accept reference image/audio/video.');
});

test('i2v requires ref and/or ref-end', () => {
  expectCliError(['--video', '--workflow', 'i2v', 'a cat'], 'i2v requires --ref and/or --ref-end.');
});

test('s2v requires both ref and ref-audio', () => {
  expectCliError(['--video', '--workflow', 's2v', '--ref', 'screenshot.jpg', 'a cat'], 's2v requires both --ref and --ref-audio.');
});

test('looping is only supported with i2v workflow', () => {
  expectCliError(['--video', '--workflow', 't2v', '--looping', 'a cat'], '--looping is only supported with i2v workflow.');
});

test('photobooth requires ref image', () => {
  expectCliError(['--photobooth', 'portrait'], '--photobooth requires --ref <face-image>.');
});

test('photobooth cannot be combined with video', () => {
  expectCliError(['--photobooth', '--video', '--ref', 'screenshot.jpg', 'portrait'], '--photobooth cannot be combined with --video.');
});

test('video rejects lora options', () => {
  expectCliError(['--video', '--lora', 'foo', 'a cat'], '--lora options are image-only.');
});

test('video rejects sampler/scheduler options', () => {
  expectCliError(['--video', '--sampler', 'euler', 'a cat'], '--sampler/--scheduler are image-only options.');
});

test('non-video rejects auto-resize-assets', () => {
  expectCliError(['--auto-resize-assets', 'a cat'], '--auto-resize-assets is only valid with --video.');
});

test('estimate-video-cost requires --video', () => {
  expectCliError(['--estimate-video-cost', 'a cat'], '--estimate-video-cost requires --video.');
});

test('unknown workflow returns a validation error', () => {
  expectCliError(['--video', '--workflow', 'foo', 'a cat'], 'Unknown workflow "foo".');
});

test('--version returns current package version', () => {
  const { exitCode, stdout } = runCli(['--version']);
  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), PACKAGE_VERSION);
});

test('--version with --json returns structured version information', () => {
  const { exitCode, stdout } = runCli(['--json', '--version']);
  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.success, true);
  assert.equal(payload.type, 'version');
  assert.equal(payload.name, 'sogni-gen');
  assert.equal(payload.version, PACKAGE_VERSION);
  assert.ok(payload.timestamp);
});

test('explicit 512x512, output format, and seed are applied', () => {
  const { exitCode, state } = runCli([
    '--width', '512',
    '--height', '512',
    '--output-format', 'jpg',
    '--seed', '42',
    'neon cyberpunk city'
  ]);
  assert.equal(exitCode, 0);
  assert.ok(state?.lastImageProject);
  assert.equal(state.lastImageProject.width, 512);
  assert.equal(state.lastImageProject.height, 512);
  assert.equal(state.lastImageProject.outputFormat, 'jpg');
  assert.equal(state.lastImageProject.seed, 42);
});

test('count is forwarded to image generation', () => {
  const { exitCode, state } = runCli([
    '--count', '2',
    'a watercolor landscape'
  ]);
  assert.equal(exitCode, 0);
  assert.ok(state?.lastImageProject);
  assert.equal(state.lastImageProject.numberOfMedia, 2);
});

test('i2v infers a 16-multiple video size from non-square reference when width/height not explicitly set', () => {
  const { exitCode, state } = runCli([
    '--video',
    '--workflow', 'i2v',
    '--ref', 'screenshot.jpg',
    '--duration', '1',
    'gentle camera pan'
  ]);
  assert.equal(exitCode, 0);
  assert.ok(state?.lastVideoProject, 'createVideoProject was called');
  // screenshot.jpg is 1170x1200. Default requested size is 512x512, but i2v would resize to 499x512 (499 not divisible by 16).
  // The CLI auto-picks a compatible bounding box (divisible by 16) so the resized reference is also divisible by 16.
  assert.equal(state.lastVideoProject.width, 608);
  assert.equal(state.lastVideoProject.height, 624);
});

test('video dims are normalized to 16-multiples instead of hard failing', () => {
  const { exitCode, stdout } = runCli([
    '--json',
    '--video',
    '--width', '500',
    '--height', '512',
    'ocean waves'
  ]);
  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.success, true);
  assert.equal(payload.width, 496);
  assert.equal(payload.height, 512);
});

test('json error: i2v rejects mismatched explicit size and suggests a compatible 16-multiple aspect', () => {
  const { exitCode, stdout } = runCli([
    '--json',
    '--strict-size',
    '--video',
    '--workflow', 'i2v',
    '--ref', 'screenshot.jpg',
    '--width', '512',
    '--height', '512',
    'gentle camera pan'
  ]);
  assert.equal(exitCode, 1);
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.success, false);
  assert.equal(payload.errorCode, 'INVALID_VIDEO_SIZE');
  assert.ok(String(payload.hint || '').includes('--width 608 --height 624'));
});

test('json error: i2v validates --ref-end sizing with strict-size', () => {
  const { exitCode, stdout } = runCli([
    '--json',
    '--strict-size',
    '--video',
    '--workflow', 'i2v',
    '--ref-end', 'screenshot.jpg',
    '--width', '512',
    '--height', '512',
    'gentle camera pan'
  ]);
  assert.equal(exitCode, 1);
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.success, false);
  assert.equal(payload.errorCode, 'INVALID_VIDEO_SIZE');
  assert.equal(payload.errorDetails.referenceType, 'refImageEnd');
});

test('i2v auto-adjust handles near-matching aspects that still round to a non-16 dimension', async () => {
  const { default: sharp } = await import('sharp');
  const tmp = mkdtempSync(join(tmpdir(), 'sogni-gen-ref-'));
  const refPath = join(tmp, 'ref-587x880.png');
  await sharp({
    create: { width: 587, height: 880, channels: 3, background: { r: 0, g: 0, b: 0 } }
  }).png().toFile(refPath);

  const { exitCode, state } = runCli([
    '--video',
    '--workflow', 'i2v',
    '--ref', refPath,
    '--duration', '1',
    'gentle camera pan'
  ]);
  assert.equal(exitCode, 0);
  assert.ok(state?.lastVideoProject);
  // CLI chooses a compatible bounding box; wrapper will resize the reference inside it (to 480x720).
  assert.equal(state.lastVideoProject.width, 512);
  assert.equal(state.lastVideoProject.height, 720);
});

test('--balance with --json returns balance information', () => {
  const { exitCode, stdout } = runCli(['--json', '--balance']);
  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.success, true);
  assert.equal(payload.type, 'balance');
  assert.equal(payload.spark, 100);
  assert.equal(payload.sogni, 100);
  assert.ok(payload.tokenType);
  assert.ok(payload.timestamp);
});

test('--balances (alias) with --json returns balance information', () => {
  const { exitCode, stdout } = runCli(['--json', '--balances']);
  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.success, true);
  assert.equal(payload.type, 'balance');
  assert.equal(payload.spark, 100);
  assert.equal(payload.sogni, 100);
});

test('--balance without --json displays human-readable output', () => {
  const { exitCode, stdout } = runCli(['--balance']);
  assert.equal(exitCode, 0);
  assert.ok(stdout.includes('SPARK:'));
  assert.ok(stdout.includes('SOGNI:'));
  assert.ok(stdout.includes('100'));
});

test('--balance does not require a prompt', () => {
  const { exitCode, stdout } = runCli(['--json', '--balance']);
  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.success, true);
  assert.equal(payload.type, 'balance');
});

test('json error: i2v explicit size that rounds to non-16 suggests a compatible bbox', async () => {
  const { default: sharp } = await import('sharp');
  const tmp = mkdtempSync(join(tmpdir(), 'sogni-gen-ref-'));
  const refPath = join(tmp, 'ref-587x880.png');
  await sharp({
    create: { width: 587, height: 880, channels: 3, background: { r: 0, g: 0, b: 0 } }
  }).png().toFile(refPath);

  const { exitCode, stdout } = runCli([
    '--json',
    '--strict-size',
    '--video',
    '--workflow', 'i2v',
    '--ref', refPath,
    '--width', '1024',
    '--height', '1536',
    '--duration', '1',
    'gentle camera pan'
  ]);
  assert.equal(exitCode, 1);
  const payload = JSON.parse(stdout.trim());
  assert.equal(payload.success, false);
  assert.equal(payload.errorCode, 'INVALID_VIDEO_SIZE');
  assert.ok(String(payload.hint || '').includes('--width 1024 --height 1296'));
});

// --- v2v workflow tests ---

test('v2v requires --ref-video', () => {
  expectCliError(
    ['--video', '--workflow', 'v2v', '--controlnet-name', 'canny', 'a cat'],
    'v2v requires --ref-video.'
  );
});

test('v2v requires --controlnet-name', () => {
  expectCliError(
    ['--video', '--workflow', 'v2v', '--ref-video', 'video.mp4', 'a cat'],
    'v2v requires --controlnet-name'
  );
});

test('v2v rejects reference audio', () => {
  expectCliError(
    ['--video', '--workflow', 'v2v', '--ref-video', 'video.mp4', '--controlnet-name', 'canny', '--ref-audio', 'audio.m4a', 'a cat'],
    'v2v does not accept reference audio.'
  );
});

test('v2v is recognized as a valid workflow', () => {
  // Should fail due to missing --ref-video, NOT unknown workflow
  const { exitCode, stderr } = runCli(['--video', '--workflow', 'v2v', '--controlnet-name', 'canny', 'a cat']);
  assert.equal(exitCode, 1);
  assert.ok(!stderr.includes('Unknown workflow'), `Should not report unknown workflow, got: ${stderr}`);
  assert.ok(stderr.includes('v2v requires --ref-video'), `Expected v2v validation error, got: ${stderr}`);
});

test('invalid --controlnet-name returns a validation error', () => {
  expectCliError(
    ['--video', '--workflow', 'v2v', '--ref-video', 'video.mp4', '--controlnet-name', 'invalid', 'a cat'],
    'Unknown --controlnet-name "invalid"'
  );
});

test('valid --controlnet-name values are accepted (canny)', () => {
  // This should fail due to missing ref-video file, NOT controlnet validation
  const { stderr } = runCli(['--video', '--workflow', 'v2v', '--ref-video', 'nonexistent.mp4', '--controlnet-name', 'canny', 'a cat']);
  assert.ok(!stderr.includes('Unknown --controlnet-name'), `Should accept canny, got: ${stderr}`);
});

test('--sam2-coordinates is only supported with animate-replace', () => {
  expectCliError(
    ['--video', '--workflow', 't2v', '--sam2-coordinates', '100,200', 'a cat'],
    '--sam2-coordinates is only supported with animate-replace'
  );
});

test('--trim-end-frame flag is recognized', () => {
  // Should not fail with unknown option
  const { stderr } = runCli(['--video', '--trim-end-frame', 'a cat']);
  assert.ok(!stderr.includes('Unknown option: --trim-end-frame'), `Should recognize --trim-end-frame, got: ${stderr}`);
});

test('--first-frame-strength and --last-frame-strength flags are recognized', () => {
  const { stderr } = runCli(['--video', '--first-frame-strength', '0.6', '--last-frame-strength', '0.8', 'a cat']);
  assert.ok(!stderr.includes('Unknown option'), `Should recognize frame strength flags, got: ${stderr}`);
});

test('--controlnet-strength flag is recognized', () => {
  const { stderr } = runCli(['--video', '--workflow', 'v2v', '--ref-video', 'vid.mp4', '--controlnet-name', 'canny', '--controlnet-strength', '0.7', 'a cat']);
  assert.ok(!stderr.includes('Unknown option: --controlnet-strength'), `Should recognize --controlnet-strength, got: ${stderr}`);
});
