#!/usr/bin/env node
/**
 * image-gen.mjs — 中转站（New API）生图核心库 + CLI
 *
 * 请配置兼容图片接口的服务地址和 API key。
 * 可用生图模型（只支持 /images/generations 与 /images/edits，不支持 chat/completions）:
 *   - gpt-image-2.5-flare
 *   - gpt-image-2.5-sunburst
 *
 * CLI:
 *   node image-gen.mjs --prompt "..." [--model gpt-image-2.5-flare] [--size 1024x1024]
 *                      [--quality low|medium|high] [--n 1] [--out C:\path\a.png]
 *   node image-gen.mjs --edit --image in.png --prompt "..." [--out out.png]
 */
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_API_KEY_ENV = "IMAGE_API_KEY";
export const IMAGE_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];
export const SIZES = ["1024x1024", "1024x1536", "1536x1024"];

/* ------------------------------------------------------------------ *
 * API key
 * ------------------------------------------------------------------ */
export function resolveApiKey({ apiKey, apiKeyEnv = DEFAULT_API_KEY_ENV } = {}) {
  if (apiKey) return apiKey;
  const fromEnv = process.env[apiKeyEnv];
  if (fromEnv) return fromEnv;
  try {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const text = readFileSync(path.join(home, ".dsh", ".credentials.yaml"), "utf8");
    const m = text.match(new RegExp(`^\\s+${apiKeyEnv}:\\s*(\\S+)\\s*$`, "m"));
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  throw new Error(`无法解析 API key：请设置环境变量 ${apiKeyEnv} 或传 apiKey`);
}

/* ------------------------------------------------------------------ *
 * HTTP 基础
 * ------------------------------------------------------------------ */
function request(url, { method = "POST", headers = {}, body, insecureTLS = false, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const payload = Buffer.isBuffer(body) ? body : body == null ? null : Buffer.from(JSON.stringify(body));
    const hdrs = { ...headers };
    if (payload) hdrs["content-length"] = payload.length;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: hdrs,
        agent: u.protocol === "https:" ? new https.Agent({ rejectUnauthorized: !insecureTLS, keepAlive: false }) : undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`生图请求超时（${timeoutMs} ms）`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function escapeJsonText(buf, limit = 700) {
  const text = buf.toString("utf8");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/* ------------------------------------------------------------------ *
 * 落盘
 * ------------------------------------------------------------------ */
const EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

async function sniffExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return ".png";
}

export async function saveImage(buf, { outputPath, outputDir, model = "image", index = 0 } = {}) {
  let target = outputPath;
  if (!target) {
    const dir = outputDir || path.join(os.homedir(), "Pictures", "dsh-images");
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const ext = await sniffExt(buf);
    target = path.join(dir, `${stamp}-${model}${index ? `-${index + 1}` : ""}${ext}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buf);
  return path.resolve(target);
}

export async function downloadUrl(url, { insecureTLS = false, timeoutMs = 300000 } = {}) {
  const res = await request(url, { method: "GET", headers: {}, insecureTLS, timeoutMs });
  if (res.status !== 200) throw new Error(`下载图片失败 ${res.status}`);
  return res.buffer;
}

/* ------------------------------------------------------------------ *
 * 生图
 * ------------------------------------------------------------------ */
export async function generateImage({
  prompt,
  model = IMAGE_MODELS[0],
  size = "1024x1024",
  quality,
  n = 1,
  baseURL = DEFAULT_BASE_URL,
  apiKey,
  apiKeyEnv = DEFAULT_API_KEY_ENV,
  insecureTLS = false,
  timeoutMs = 600000,
  outputPath,
  outputDir,
} = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error("prompt 不能为空");
  const key = resolveApiKey({ apiKey, apiKeyEnv });
  const body = { model, prompt: String(prompt), n: Math.max(1, Math.min(4, Number(n) || 1)) };
  if (size) body.size = size;
  if (quality) body.quality = quality;

  const t0 = Date.now();
  const res = await request(`${baseURL.replace(/\/+$/, "")}/images/generations`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body,
    insecureTLS,
    timeoutMs,
  });

  if (res.status !== 200) {
    throw new Error(`生图接口 ${res.status}: ${escapeJsonText(res.buffer)}`);
  }

  let json;
  try {
    json = JSON.parse(res.buffer.toString("utf8"));
  } catch {
    throw new Error(`生图接口返回非 JSON: ${escapeJsonText(res.buffer)}`);
  }

  const items = Array.isArray(json.data) ? json.data : [];
  if (items.length === 0) throw new Error(`生图接口未返回图片: ${escapeJsonText(res.buffer)}`);

  const files = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    let buf = null;
    let mime = "image/png";
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, "base64");
      if (item.mime_type) mime = item.mime_type;
    } else if (item.url) {
      buf = await downloadUrl(item.url, { insecureTLS, timeoutMs });
    }
    if (!buf) continue;
    const file = await saveImage(buf, {
      outputPath: items.length === 1 ? outputPath : undefined,
      outputDir,
      model,
      index: i,
    });
    files.push({ file, bytes: buf.length, mime: EXT_BY_MIME[mime] ? mime : "image/png" });
  }
  if (files.length === 0) throw new Error("生图接口返回了 data，但既无 b64_json 也无 url");

  return {
    ok: true,
    files,
    model,
    requestedSize: size ?? null,
    actualSize: json.size ?? null,
    quality: json.quality ?? quality ?? null,
    outputFormat: json.output_format ?? "png",
    usage: json.usage ?? null,
    ms: Date.now() - t0,
  };
}

/* ------------------------------------------------------------------ *
 * 改图 / 图生图
 * ------------------------------------------------------------------ */
function buildMultipart(fields, files) {
  const boundary = `----dshimage${Math.random().toString(16).slice(2)}${Date.now()}`;
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`
      )
    );
    chunks.push(f.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export async function editImage({
  prompt,
  images = [],
  model = IMAGE_MODELS[0],
  size,
  baseURL = DEFAULT_BASE_URL,
  apiKey,
  apiKeyEnv = DEFAULT_API_KEY_ENV,
  insecureTLS = false,
  timeoutMs = 600000,
  outputPath,
  outputDir,
} = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error("prompt 不能为空");
  if (!images.length) throw new Error("images 至少需要一张图片路径");
  const key = resolveApiKey({ apiKey, apiKeyEnv });

  const files = [];
  for (const p of images) {
    const abs = path.resolve(p);
    const data = await fs.readFile(abs);
    files.push({
      name: "image",
      filename: path.basename(abs),
      mime: MIME_BY_EXT[path.extname(abs).toLowerCase()] || "image/png",
      data,
    });
  }
  const fields = { model, prompt: String(prompt) };
  if (size) fields.size = size;
  const { boundary, body } = buildMultipart(fields, files);

  const t0 = Date.now();
  const res = await request(`${baseURL.replace(/\/+$/, "")}/images/edits`, {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${key}` },
    body,
    insecureTLS,
    timeoutMs,
  });
  if (res.status !== 200) throw new Error(`改图接口 ${res.status}: ${escapeJsonText(res.buffer)}`);

  let json;
  try {
    json = JSON.parse(res.buffer.toString("utf8"));
  } catch {
    throw new Error(`改图接口返回非 JSON: ${escapeJsonText(res.buffer)}`);
  }
  const item = (json.data || [])[0] || {};
  let buf = null;
  if (item.b64_json) buf = Buffer.from(item.b64_json, "base64");
  else if (item.url) buf = await downloadUrl(item.url, { insecureTLS, timeoutMs });
  if (!buf) throw new Error(`改图接口未返回图片: ${escapeJsonText(res.buffer)}`);

  const file = await saveImage(buf, { outputPath, outputDir, model });
  return { ok: true, files: [{ file, bytes: buf.length }], model, actualSize: json.size ?? null, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function parseArgv(argv) {
  const out = { _flags: new Set(), images: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    let key, val;
    if (eq > -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        val = next;
        i++;
      } else {
        out._flags.add(key);
        continue;
      }
    }
    if (key === "image") out.images.push(val);
    else out[key] = val;
  }
  return out;
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args._flags.has("help") || (!args.prompt && !args._flags.has("models"))) {
    console.log(`用法:
  node image-gen.mjs --prompt "<提示词>" [--model ${IMAGE_MODELS.join("|")}]
                     [--size 1024x1024|1024x1536|1536x1024] [--quality low|medium|high]
                     [--n 1] [--out <绝对路径>]
  node image-gen.mjs --edit --image <图片路径> [--image <图片2>] --prompt "<改图指令>"
  node image-gen.mjs --models`);
    return;
  }
  if (args._flags.has("models")) {
    const key = resolveApiKey({ apiKeyEnv: args.apiKeyEnv });
    const res = await request(`${(args.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
    });
    console.log(res.buffer.toString("utf8"));
    return;
  }

  const common = {
    prompt: args.prompt,
    model: args.model || IMAGE_MODELS[0],
    baseURL: args.baseURL || DEFAULT_BASE_URL,
    apiKeyEnv: args.apiKeyEnv || DEFAULT_API_KEY_ENV,
    outputPath: args.out,
    outputDir: args.dir,
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 600000,
  };

  const result = args._flags.has("edit")
    ? await editImage({ ...common, images: args.images, size: args.size })
    : await generateImage({ ...common, size: args.size || "1024x1024", quality: args.quality, n: args.n ? Number(args.n) : 1 });

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        model: result.model,
        requestedSize: result.requestedSize,
        actualSize: result.actualSize,
        quality: result.quality,
        ms: result.ms,
        files: result.files.map((f) => ({ file: f.file, bytes: f.bytes, mb: +(f.bytes / 1048576).toFixed(2) })),
      },
      null,
      2
    )
  );
}

const isCli = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  } catch {
    return false;
  }
})();

if (isCli) {
  main().catch((e) => {
    console.error(`[image-gen] ${e?.message || e}`);
    process.exit(1);
  });
}
