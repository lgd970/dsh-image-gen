/**
 * dsh-image-gen — DSH 生图插件
 *
 * 把 OpenAI 兼容中转站的「只走 /v1/images/generations、/v1/images/edits」的生图模型
 * 接成 DSH 原生工具，避免把它们当聊天模型调用（会报 "upported on /v1/images/generations"）。
 *
 * 提供的工具：
 *   image_generate — 文生图
 *   image_edit     — 图生图 / 局部改图
 *   image_models   — 探测中转站上可用的生图模型
 *
 * 核心模块随插件打包，CLI 与插件行为一致。
 */

export const name = "dsh-image-gen";
export const inject = ["tools"];

const DEFAULT_CORE_MODULE = new URL("./image-gen.mjs", import.meta.url).href;

const MODEL_ENUM = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];
const SIZE_ENUM = ["1024x1024", "1024x1536", "1536x1024", "auto"];
const QUALITY_ENUM = ["low", "medium", "high", "auto"];

function toFileUrl(p) {
  if (p.startsWith("file:")) return p;
  const norm = p.replace(/\\/g, "/");
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`;
}

export function apply(ctx, config = {}) {
  const cfg = {
    baseURL: config.baseURL ?? "https://api.openai.com/v1",
    apiKey: config.apiKey,
    apiKeyEnv: config.apiKeyEnv ?? "IMAGE_API_KEY",
    defaultModel: config.defaultModel ?? MODEL_ENUM[0],
    defaultSize: config.defaultSize ?? "1024x1024",
    defaultQuality: config.defaultQuality,
    insecureTLS: config.insecureTLS === true,
    timeoutMs: config.timeoutMs ?? 600000,
    outputDir: config.outputDir,
    coreModule: config.coreModule ?? DEFAULT_CORE_MODULE,
  };

  let corePromise = null;
  const core = () => {
    if (!corePromise) {
      corePromise = import(toFileUrl(cfg.coreModule)).catch((e) => {
        corePromise = null;
        throw new Error(`无法加载生图核心模块 ${cfg.coreModule}: ${e?.message ?? e}`);
      });
    }
    return corePromise;
  };

  const commonApi = () => ({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    apiKeyEnv: cfg.apiKeyEnv,
    insecureTLS: cfg.insecureTLS,
    timeoutMs: cfg.timeoutMs,
    outputDir: cfg.outputDir,
  });

  const describeFiles = (res) =>
    res.files
      .map((f) => `${f.file} (${(f.bytes / 1048576).toFixed(2)} MB)`)
      .join("\n");

  const summarize = (res, label) =>
    [
      `✓ ${label}完成`,
      `模型: ${res.model}`,
      res.actualSize ? `尺寸: ${res.actualSize}` : null,
      res.quality ? `质量: ${res.quality}` : null,
      `耗时: ${(res.ms / 1000).toFixed(1)} s`,
      `文件:`,
      describeFiles(res),
    ]
      .filter(Boolean)
      .join("\n");

  ctx.tools.register({
    name: "image_generate",
    description:
      "用中转站的 ChatGPT 生图模型（gpt-image-2.5-flare / gpt-image-2.5-sunburst）根据文字提示词生成图片并保存到本地。" +
      "这些模型只支持 /v1/images/generations，不能当聊天模型使用。生成后会返回图片的绝对路径，需要展示给用户时再调用 present。" +
      "适合：插画、海报、角色合影、表情包、概念图、任意“生成一张图”的需求。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "图片提示词。建议写清主体、外观、服装/颜色、动作、场景、光线、画风。" },
        model: {
          type: "string",
          enum: MODEL_ENUM,
          description: "生图模型，默认 gpt-image-2.5-flare（速度更稳），gpt-image-2.5-sunburst 出图风格更浓。",
        },
        size: {
          type: "string",
          enum: SIZE_ENUM,
          description: "输出尺寸：1024x1024 方形 / 1536x1024 横向 / 1024x1536 纵向 / auto。默认 1024x1024。",
        },
        quality: { type: "string", enum: QUALITY_ENUM, description: "质量档位，默认交给中转站决定。" },
        outputPath: { type: "string", description: "保存的绝对路径（含扩展名）。省略则保存到配置的输出目录并按时间戳命名。" },
        n: { type: "integer", minimum: 1, maximum: 4, description: "生成几张，默认 1。" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          model: { type: "string" },
          size: { type: "string" },
          ms: { type: "number" },
          files: { type: "array" },
          message: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.message ?? "") }],
    },
    async execute(args) {
      try {
        const api = await core();
        const res = await api.generateImage({
          ...commonApi(),
          prompt: args?.prompt,
          model: args?.model ?? cfg.defaultModel,
          size: args?.size ?? cfg.defaultSize,
          quality: args?.quality ?? cfg.defaultQuality,
          n: args?.n ?? 1,
          outputPath: args?.outputPath,
        });
        return {
          ok: true,
          model: res.model,
          size: res.actualSize ?? res.requestedSize ?? "",
          ms: res.ms,
          files: res.files,
          message: summarize(res, "生图"),
        };
      } catch (e) {
        return { ok: false, model: args?.model ?? cfg.defaultModel, size: "", ms: 0, files: [], message: `✗ 生图失败: ${e?.message ?? e}` };
      }
    },
  });

  ctx.tools.register({
    name: "image_edit",
    description:
      "对已有图片做图生图 / 局部修改（走 /v1/images/edits）。传入一张或多张本地图片路径与改图指令，" +
      "返回新图片的绝对路径。适合：换风格、改表情、加/去元素、把两张图合成一张。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "改图指令，说明希望如何修改。" },
        images: { type: "array", items: { type: "string" }, description: "输入图片的本地绝对路径，可多张。" },
        model: { type: "string", enum: MODEL_ENUM, description: "生图模型，默认 gpt-image-2.5-flare。" },
        size: { type: "string", enum: SIZE_ENUM, description: "输出尺寸，默认沿用原图比例。" },
        outputPath: { type: "string", description: "保存的绝对路径（含扩展名），省略则自动命名。" },
      },
      required: ["prompt", "images"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          model: { type: "string" },
          files: { type: "array" },
          message: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: String(value?.message ?? "") }],
    },
    async execute(args) {
      try {
        const api = await core();
        const res = await api.editImage({
          ...commonApi(),
          prompt: args?.prompt,
          images: args?.images ?? [],
          model: args?.model ?? cfg.defaultModel,
          size: args?.size,
          outputPath: args?.outputPath,
        });
        return {
          ok: true,
          model: res.model,
          files: res.files,
          message: summarize(res, "改图"),
        };
      } catch (e) {
        return { ok: false, model: args?.model ?? cfg.defaultModel, files: [], message: `✗ 改图失败: ${e?.message ?? e}` };
      }
    },
  });

  if (ctx.tools.register) {
    ctx.tools.register({
      name: "image_models",
      description: "探测中转站当前可用的生图模型（/v1/models 中声明 image-generation 的模型），返回模型 id 列表。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" }, models: { type: "array" }, message: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.message ?? "") }],
      },
      async execute() {
        try {
          const api = await core();
          const key = api.resolveApiKey({ apiKey: cfg.apiKey, apiKeyEnv: cfg.apiKeyEnv });
          const url = `${String(cfg.baseURL).replace(/\/+$/, "")}/models`;
          const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
          const json = await res.json();
          const all = Array.isArray(json?.data) ? json.data : [];
          const imageModels = all
            .filter((m) => (m?.supported_endpoint_types ?? []).includes("image-generation"))
            .map((m) => m.id);
          return {
            ok: true,
            models: imageModels,
            message: `可用生图模型 (${imageModels.length}):\n${imageModels.map((m) => `  - ${m}`).join("\n") || "  （无）"}`,
          };
        } catch (e) {
          return { ok: false, models: [], message: `✗ 探测失败: ${e?.message ?? e}` };
        }
      },
    });
  }
}
