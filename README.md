# dsh-image-gen

DeepSeek Harness (DSH) 生图插件，将兼容 OpenAI 图片接口的服务接入为原生工具。核心模块已随插件打包，无需单独下载脚本。

- `image_generate`：根据提示词生成图片，调用 `/images/generations`。
- `image_edit`：修改本地图片，调用 `/images/edits`。
- `image_models`：查询 `/models` 中标记了 `image-generation` 端点的模型。某些服务没有此标记，因此空列表不一定意味着不能生图。

默认提供 `gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst` 两个模型选项；**需要使用实际支持这些模型的服务商**，这不是保证官方 OpenAI 接口提供它们。参数有 `1024x1024`、`1536x1024`、`1024x1536`、`auto` 及质量 `low`、`medium`、`high`、`auto`；服务商可能忽略部分参数。

## 环境要求

- Node.js 18 或更高版本，以及可正常运行的 DSH。
- 具备图片生成/编辑接口、上述模型及对应权限的 OpenAI 兼容服务地址与 API key。

## 安装

在终端运行（将 `desktop` 换成实际使用的 profile，例如 `web`；不同 profile 需分别安装）：

```powershell
dsh plugin --profile desktop add github:lgd970/dsh-image-gen
```

在该 profile 的 `package.json` 的 `dsh.profile.bundles` 数组中加入 `"dsh-image-gen"`（如果已有则不重复），并在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的现有 patch 列表中加入下面的 `insert` 项；若文件不存在，可新建。不要覆盖已有配置：

```yaml
- insert:
    - id: image-gen
      name: dsh-image-gen
      config:
        baseURL: 'https://your-image-provider.example/v1'
        apiKeyEnv: IMAGE_API_KEY
        defaultModel: gpt-image-2.5-flare
        defaultSize: 1024x1024
        # defaultQuality: high
        insecureTLS: false
        timeoutMs: 600000
        # outputDir: '/absolute/path/to/output'
```

将 `baseURL` 换成你的服务商提供的 API 根地址（通常以 `/v1` 结尾），并在**启动 DSH 的进程环境**中设置密钥。不要提交真实 key 或私有配置：

```powershell
# 当前 PowerShell 进程；从此终端启动 DSH
$env:IMAGE_API_KEY = 'YOUR_API_KEY'
dsh --profile desktop
```

也可在用户环境变量中保存并重启 DSH，使桌面应用继承它。`apiKeyEnv` 可改成任意环境变量名称；插件优先使用 `apiKey` 配置（不推荐，容易泄漏），其次读取指定环境变量，最后尝试读取本机 `~/.dsh/.credentials.yaml` 内同名条目。请将密钥保留在个人机器上，不要分享该文件。

`insecureTLS` 默认 `false`，会验证证书。仅在了解风险且必须使用自签证书的可信服务时才设为 `true`；这会禁用生成、编辑和图片下载请求的 TLS 证书验证。`image_models` 使用 Node 的 `fetch`，不受此开关影响。默认输出目录为用户主目录下的 `Pictures/dsh-images`。安装或修改 profile 后重启 DSH，并检查工具是否出现。

## 使用

直接在 DSH 中说“生成一张图片”或“把这张图片改成水彩风”，由助手调用相应工具。可指定模型、尺寸、质量、输出路径及生成数量（1–4）。

也可直接调用打包的 CLI：

```powershell
$env:IMAGE_API_KEY = 'YOUR_API_KEY'
node ./lib/image-gen.mjs --baseURL 'https://your-image-provider.example/v1' --prompt 'a cat on a windowsill' --out ./cat.png
node ./lib/image-gen.mjs --baseURL 'https://your-image-provider.example/v1' --edit --image ./cat.png --prompt 'watercolor style'
node ./lib/image-gen.mjs --baseURL 'https://your-image-provider.example/v1' --models
```

CLI 的 TLS 验证始终开启；自签证书应安装受信任 CA，而不是禁用验证。实际生成可能产生服务费用，返回图片路径属于本机文件。

## 安全与隐私

仓库不包含作者个人中转地址、密钥或 profile 配置。`.gitignore` 用于避免将常见本地配置、依赖、日志和输出误提交；它**不会**移除已经纳入 Git 跟踪的文件，也不能替代提交前检查。不要把真实凭据放进受跟踪的文件。用户自行维护的 DSH profile 位于仓库外，不会随仓库上传。

## 离线测试

```powershell
node --test tests/*.test.mjs
```

测试使用本地模拟接口，不调用真实生图服务。
