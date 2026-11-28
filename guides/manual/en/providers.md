# Models & API keys

MTNode provides the workspace; the AI models you connect do the writing, drawing, and reasoning. Open **Settings → Model services** and pick whichever of the three setups fits you best.

![Three ways to connect AI models](img/mtnode-start-01-ui.svg)

## Option 1: Use your own official API key (recommended)

### What is an API key?

Think of an API key as a prepaid pass to a model provider. Sign up on a provider's website, claim any starter credit or top up a small amount, and create a key (usually starting with `sk-`). Paste it into MTNode and you pay only for what you use.

> **Keep your key private**: Treat it like a bank password. Never post screenshots of it, paste it into chats, or commit it to public repos. If you suspect a leak, delete the old key on the provider's dashboard and create a new one (it's free).

### Popular providers (pick one to start)

- **DeepSeek (great all-rounder)**: Fast, affordable, strong writing and coding. Sign up at https://platform.deepseek.com/
- **Qwen (Alibaba Cloud Bailian)**: https://bailian.console.aliyun.com/
- **Zhipu GLM (BigModel)**: https://bigmodel.cn/
- **Kimi (Moonshot)**: https://platform.moonshot.cn/

### Add your key in three steps

1. Sign in to the provider's console, open **API Keys**, create a new key, and copy it right away (most sites show it only once).
2. In MTNode, open **Settings → Model services** and open the matching provider card (or click **Add provider**).
3. Paste your key and click **Done**. All settings save automatically right away.

## Option 2: MTNode Relay (zero key setup)

If you prefer not to manage separate provider accounts, sign in to your MTNode account and top up. An **MTNode Relay** card appears automatically under **Settings → Model services** with models and key pre-configured.

- Click **Copy** next to the key if you also want to reuse it in other OpenAI-compatible apps (such as Codex) or the desktop pet.
- Need a fresh key? Click **Rotate key** to issue a new one and invalidate the old key right away (up to 5 times per day).

## Option 3: Free local models (llama.cpp)

Have a dedicated GPU and want to run open models completely offline for free? Install **llama.cpp Local Models** from the top bar **Plugins** window.

Once installed, a **llama.cpp Local** card appears automatically in **Settings → Model services** and tracks every model you download:

- Each row shows live status (`Running` / `Loading` / `Unloaded` / `Failed`) with **Deploy** and **Stop** buttons to load or free GPU memory on demand.
- If you pick an unloaded local model on a node or session and hit Run, MTNode starts the backend and loads that model automatically before continuing.
- To download or remove model files, open **Console** from the plugin card.

## International or image models via aggregators

If you want overseas models or GPT image generation through a third-party OpenAI-compatible aggregator, click **Add provider**, enter the platform's Base URL and API key, and verify pricing with a small balance first. For image-only endpoints, set the provider type to **Image OpenAI-compatible**.

## Optional settings (leave blank for defaults)

Open any provider card for four optional controls:

- **Model allowlist / denylist**: Narrow a long model list using `*` and `?` wildcards (for example `deepseek-*` in allowlist, or `gpt-image-*` in denylist). Excluded models stay visible in Settings with an out-of-policy badge but are hidden from pickers.
- **Disable provider**: Temporarily hide a provider from all model pickers without deleting its key or config. Existing canvas nodes bound to it keep working.
- **Vision (image input)**: Works out of the box with no toggle needed. If a model doesn't accept images, MTNode reports the error clearly so you can switch to a vision-capable model (such as DeepSeek's default model).
- **Timeouts (ms)**: Connect, first-byte, and chunk idle timeouts default to 300000 ms (5 minutes). Leave empty unless you hit slow networks.
