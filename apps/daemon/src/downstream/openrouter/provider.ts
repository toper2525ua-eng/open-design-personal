// OpenRouter media provider (image + video).
//
// Image: POST /chat/completions with modalities=[image,text]; the
//   response carries images at choices[0].message.images[].image_url.url
//   as a `data:image/...;base64,…` URL we decode to bytes.
// Video: POST /videos returns { id, polling_url, status }; we poll
//   polling_url until status='completed', then download
//   unsigned_urls[0] with Bearer auth (OpenRouter's unsigned URLs still
//   require the API key when the host is openrouter.ai). The same job
//   schema drives every video model (Veo 3.1, Seedance 2.0, …); we map
//   our registry ids to OpenRouter wire ids below and forward an optional
//   `--image` as an `input_references` entry for reference-to-video.
//
// Defaults: base URL https://openrouter.ai/api/v1, auth via
// `Authorization: Bearer <OPENROUTER_API_KEY>`. We also send HTTP-Referer
// / X-Title headers OpenRouter uses for app attribution.

import { Buffer } from 'node:buffer';

import type {
  DownstreamMediaContext,
  DownstreamProgressFn,
  DownstreamProviderConfig,
  DownstreamRenderResult,
} from '../api.js';

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const OPENROUTER_VIDEO_MODEL_MAP: Record<string, string> = {
  'openrouter-veo-3.1': 'google/veo-3.1',
  'openrouter-veo-3.1-fast': 'google/veo-3.1-fast',
  'openrouter-seedance-2.0': 'bytedance/seedance-2.0',
  'openrouter-seedance-2.0-fast': 'bytedance/seedance-2.0-fast',
};

const OPENROUTER_IMAGE_MODEL_MAP: Record<string, string> = {
  'openrouter-nano-banana-2': 'google/gemini-3.1-flash-image-preview',
};

function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    'authorization': `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'http-referer': 'https://github.com/nexu-io/open-design',
    'x-title': 'Open Design',
  };
}

function openRouterAspect(aspect?: string): string {
  if (
    aspect === '1:1'
    || aspect === '16:9'
    || aspect === '9:16'
    || aspect === '4:3'
    || aspect === '3:4'
  ) {
    return aspect;
  }
  return '16:9';
}

function truncate(s: unknown, n: number): string {
  const v = String(s || '');
  if (v.length <= n) return v;
  return v.slice(0, n - 1) + '…';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sniffImageExt(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg';
  }
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return '.png';
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return '.webp';
  }
  return '.png';
}

function pickFirstString(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry) return entry;
    }
  }
  return null;
}

export async function renderOpenRouterImage(
  ctx: DownstreamMediaContext,
  credentials: DownstreamProviderConfig,
): Promise<DownstreamRenderResult> {
  if (!credentials.apiKey) {
    throw new Error(
      'no OpenRouter API key — configure it in Settings or set OD_OPENROUTER_API_KEY',
    );
  }
  const baseUrl = (credentials.baseUrl || OPENROUTER_DEFAULT_BASE_URL).replace(/\/$/, '');
  // Precedence: stored model override > registry-id mapping > raw id.
  const wireModel =
    (credentials.model && credentials.model.trim())
    || OPENROUTER_IMAGE_MODEL_MAP[ctx.model]
    || ctx.model;

  const body = {
    model: wireModel,
    messages: [{ role: 'user', content: ctx.prompt || 'A high-quality reference image.' }],
    modalities: ['image', 'text'],
  };

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(credentials.apiKey),
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`openrouter image ${resp.status}: ${truncate(text, 240)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`openrouter image non-JSON: ${truncate(text, 200)}`);
  }
  const message = data?.choices?.[0]?.message;
  const images = Array.isArray(message?.images) ? message.images : null;
  const dataUrl = images && images.length > 0 ? images[0]?.image_url?.url : null;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error(
      `openrouter image response missing choices[0].message.images[0].image_url.url (got: ${truncate(text, 200)})`,
    );
  }
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) {
    throw new Error('openrouter image data URL missing payload separator');
  }
  const bytes = Buffer.from(dataUrl.slice(commaIdx + 1), 'base64');
  return {
    bytes,
    providerNote: `openrouter/${wireModel} · ${bytes.length} bytes`,
    suggestedExt: sniffImageExt(bytes),
  };
}

export async function renderOpenRouterVideo(
  ctx: DownstreamMediaContext,
  credentials: DownstreamProviderConfig,
  onProgress?: DownstreamProgressFn,
): Promise<DownstreamRenderResult> {
  if (!credentials.apiKey) {
    throw new Error(
      'no OpenRouter API key — configure it in Settings or set OD_OPENROUTER_API_KEY',
    );
  }
  const baseUrl = (credentials.baseUrl || OPENROUTER_DEFAULT_BASE_URL).replace(/\/$/, '');
  const wireModel =
    (credentials.model && credentials.model.trim())
    || OPENROUTER_VIDEO_MODEL_MAP[ctx.model]
    || ctx.model;

  const aspectRatio = openRouterAspect(ctx.aspect);
  const requested = ctx.length || 8;
  // Each model family on OpenRouter accepts a different duration domain;
  // an out-of-range integer 422s the job after the user has already paid
  // the submit round-trip. Snap the pick from VIDEO_LENGTHS_SEC
  // (3 / 5 / 8 / 10 / 15 / 30) into the family's allowed set:
  //   * Veo 3.1  → {4, 6, 8}s only.    https://openrouter.ai/google/veo-3.1
  //   * Seedance → any integer 4–15s.  https://openrouter.ai/bytedance/seedance-2.0
  const isVeo = /^google\/veo-/.test(wireModel);
  const isSeedance = /^bytedance\/seedance-/.test(wireModel);
  const clamped = Math.min(Math.max(requested, 1), 30);
  let durationSec: number;
  if (isVeo) {
    durationSec = [4, 6, 8].reduce(
      (best, n) => (Math.abs(n - clamped) < Math.abs(best - clamped) ? n : best),
      8,
    );
  } else if (isSeedance) {
    durationSec = Math.min(Math.max(clamped, 4), 15);
  } else {
    durationSec = clamped;
  }

  const body: Record<string, unknown> = {
    model: wireModel,
    prompt: ctx.prompt || 'A short cinematic clip.',
    aspect_ratio: aspectRatio,
    duration: durationSec,
    resolution: '720p',
    generate_audio: true,
  };
  // Image-to-video: when the caller passes --image, pin it as the FIRST
  // FRAME via `frame_images` (frame_type:'first_frame') so the clip starts
  // from the exact uploaded image and animates forward. That is what users
  // mean by "make a video FROM this photo" — the character/scene is
  // reproduced faithfully, rather than merely nudged toward it (which is
  // what `input_references` does — loose style/identity guidance, fresh
  // pixels). Both Seedance 2.0 and Veo 3.1 accept this on OpenRouter's
  // unified /videos schema. Verified end-to-end 2026-05-31 against
  // bytedance/seedance-2.0-fast (queued → processing → completed, real mp4).
  //
  // Provider moderation heads-up: ByteDance/Google REJECT reference images
  // that look like a real human face/person (anti-deepfake) — this fires
  // even on photoreal 3D renders. Flat 2D / cartoon illustrations pass. On
  // rejection the submit returns HTTP 202 with an `error` body, which the
  // guard right after the submit parse surfaces verbatim instead of the
  // generic "no polling_url" message.
  if (ctx.imageRef?.dataUrl) {
    body.frame_images = [
      {
        type: 'image_url',
        image_url: { url: ctx.imageRef.dataUrl },
        frame_type: 'first_frame',
      },
    ];
  }

  const submitResp = await fetch(`${baseUrl}/videos`, {
    method: 'POST',
    headers: openRouterHeaders(credentials.apiKey),
    body: JSON.stringify(body),
  });
  const submitText = await submitResp.text();
  if (!submitResp.ok) {
    throw new Error(`openrouter video submit ${submitResp.status}: ${truncate(submitText, 240)}`);
  }
  let submitData: any;
  try {
    submitData = JSON.parse(submitText);
  } catch {
    throw new Error(`openrouter video non-JSON: ${truncate(submitText, 200)}`);
  }
  // OpenRouter can answer the submit with HTTP 202 yet carry an upstream
  // rejection in the body — most notably a provider moderation block for
  // "input image may contain real person" on i2v. Surface that real reason
  // here; otherwise the no-id/no-polling_url branch below masks it as a
  // generic "no polling_url" error and the agent silently falls back to
  // text-only t2v (dropping the user's reference image entirely).
  if (submitData && submitData.error) {
    const e = submitData.error;
    const msg =
      e && typeof e === 'object' && typeof e.message === 'string'
        ? e.message
        : typeof e === 'string'
          ? e
          : JSON.stringify(e);
    throw new Error(`openrouter video rejected: ${truncate(msg, 300)}`);
  }

  const requestId: string | null = submitData?.id || submitData?.generation_id || null;
  // Some routes return absolute URLs in `polling_url`; others a path. Normalise:
  let pollingUrl: string | null = submitData?.polling_url || null;
  if (pollingUrl && !/^https?:\/\//i.test(pollingUrl)) {
    pollingUrl = `${baseUrl}${pollingUrl.startsWith('/') ? '' : '/'}${pollingUrl}`;
  }
  if (!pollingUrl && requestId) {
    pollingUrl = `${baseUrl}/videos/${encodeURIComponent(requestId)}`;
  }

  // Synchronous-completion fast-path: some short jobs may already include
  // a downloadable URL on submit.
  let videoUrl: string | null = pickFirstString(submitData?.unsigned_urls);
  let lastStatus: string = submitData?.status || '';

  if (!videoUrl) {
    if (!pollingUrl) {
      throw new Error(
        `openrouter video submit returned no polling_url and no unsigned_urls (status=${lastStatus || 'unknown'})`,
      );
    }
    const startedAt = Date.now();
    const configuredMaxMs = Number(process.env.OD_OPENROUTER_VIDEO_MAX_POLL_MS);
    const maxMs =
      Number.isFinite(configuredMaxMs) && configuredMaxMs >= 60_000
        ? configuredMaxMs
        : 12 * 60 * 1000;
    if (typeof onProgress === 'function') {
      onProgress(`openrouter video task ${requestId || ''} accepted; polling status…`);
    }
    while (Date.now() - startedAt < maxMs) {
      await sleep(5000);
      const pollResp = await fetch(pollingUrl, {
        headers: { 'authorization': `Bearer ${credentials.apiKey}` },
      });
      const pollText = await pollResp.text();
      if (!pollResp.ok) {
        throw new Error(`openrouter poll ${pollResp.status}: ${truncate(pollText, 240)}`);
      }
      let pollData: any;
      try {
        pollData = JSON.parse(pollText);
      } catch {
        throw new Error(`openrouter poll non-JSON: ${truncate(pollText, 200)}`);
      }
      lastStatus = pollData?.status || '';
      if (typeof onProgress === 'function') {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        onProgress(`openrouter task ${requestId || ''} status=${lastStatus || 'pending'} (elapsed ${elapsedSec}s)`);
      }
      if (lastStatus === 'completed') {
        videoUrl = pickFirstString(pollData?.unsigned_urls);
        break;
      }
      if (lastStatus === 'failed' || lastStatus === 'cancelled' || lastStatus === 'expired') {
        const reasonRaw = pollData?.error?.message || pollData?.error || lastStatus;
        const reason = typeof reasonRaw === 'string' ? reasonRaw : JSON.stringify(reasonRaw);
        throw new Error(`openrouter task ${lastStatus}: ${reason}`);
      }
    }
    if (!videoUrl) {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const ceilingSec = Math.round(maxMs / 1000);
      throw new Error(
        `openrouter video timed out after ${elapsedSec}s waiting for status=completed `
        + `(last status: ${lastStatus || 'pending'}, ceiling ${ceilingSec}s). `
        + `If your jobs legitimately need longer, raise OD_OPENROUTER_VIDEO_MAX_POLL_MS.`,
      );
    }
  }

  // OpenRouter's `unsigned_urls` are NOT pre-signed cloud-storage URLs in
  // the AWS sense — they require the same Bearer token as the submit/poll
  // calls. Without it the CDN returns 401 even though the job status is
  // `completed`. Only attach auth when the URL still points at an
  // OpenRouter-hosted host (a future refactor may hand back direct
  // object-storage URLs that 4xx if we forward our key).
  const dlHeaders: Record<string, string> = {};
  try {
    const u = new URL(videoUrl);
    if (/(^|\.)openrouter\.ai$/i.test(u.hostname)) {
      dlHeaders.authorization = `Bearer ${credentials.apiKey}`;
    }
  } catch {
    // If the URL doesn't parse, fall back to bare fetch and let the
    // server tell us what's wrong instead of guessing.
  }
  const dlResp = await fetch(videoUrl, { headers: dlHeaders });
  if (!dlResp.ok) {
    throw new Error(
      `openrouter video fetch ${dlResp.status} (url=${truncate(videoUrl, 120)})`,
    );
  }
  const arr = await dlResp.arrayBuffer();
  const bytes = Buffer.from(arr);

  return {
    bytes,
    providerNote: `openrouter/${wireModel} · ${aspectRatio} · ${durationSec}s · ${bytes.length} bytes`,
    suggestedExt: '.mp4',
  };
}
