# Providers & API

> One-sentence goal: make the nodes on your canvas actually able to call a model — add a text provider with an API key, and add a separate provider for image / vision capability.

![Key to model list](img/mtnode-start-02-ui.svg)
*Figure 1: add a provider from the catalog → enter the API key → the model list and API base URL load automatically → nodes pick it up automatically*

![Model list loads after entering the key](img/mtnode-start-02-demo.svg)
*Figure 2 (looping animation, about 5 seconds): paste the key → the model list is fetched automatically; for the static fallback see `img/mtnode-start-02-demo-static.svg`*

## Goal

Once configured, processing nodes, agent-task nodes, agent sessions and the global assistant all take their provider and model from the global configuration; the **⚙ Settings** button on a node header lets you change one step to a different model.

## Before you start

- An API key for an OpenAI-compatible provider (for example the providers in the catalog, such as DeepSeek Official or pi-ai).
- If you want image generation or image understanding, prepare an additional provider that **supports images / supports vision** — **DeepSeek Official cannot read images**.

## Steps

1. **Open the provider settings**: click **Settings · Model services (设置 · 模型服务)** in the top bar.
2. **Add from the catalog** (recommended): pick a provider in the catalog → enter the **API key** → the model list and API base URL load automatically.
3. **Or configure manually**: choose **Manual (手动)**, then enter the OpenAI-compatible **Base URL (接口地址)** and the model names, separated by English commas.
4. **Tick "Supports vision" where you need it**: only with this ticked can images be sent to the model as multimodal input; without it, images are only handled as reference images or attachments.
5. **Order the models by priority**: drag the model list in the settings to reorder it; the model dropdown on nodes is shown in that order.
6. **Verify on a node**: click **⚙ Settings** on any text processing node's header and confirm the provider and model you just configured can be selected.
7. **Keep the key safe**: **the API key is stored on this machine only** — it is not exported with a workflow and not uploaded with a Creative Workshop entry.

> ⚠️ Danger: never write an API key into a prompt, into a save node's output, or into a canvas title — workflow export (`.mtnodes`) and workshop upload carry those texts along with them.

> 💡 Tip: text, image generation and image understanding can be **three different providers**: use a cheap, fast one for batches and the strongest one for agent tasks; they do not interfere with each other.

## Result

The settings show the provider cards and their model lists; every processing node's **⚙ Settings** dialog can select those models; and ▶ runs no longer report "no provider configured / missing key".

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| The model list is empty | Invalid key, a wrong Base URL, or the provider has no model-listing endpoint | Check the key and Base URL, then enter the model names manually |
| ▶ fails with an authentication error | The key expired / the quota ran out / whitespace came along when pasting | Paste the key again and make sure there is no leading or trailing whitespace |
| You send an image and the model says it cannot read it | That provider has no "Supports vision" tick, or it has no vision capability at all | Switch to a vision-capable provider, or configure a separate image-understanding provider |
| A newly added provider is not selectable on a node | The node saved an older configuration | Reopen the node's **⚙ Settings** and select it again |
| You changed settings but a running node did not change | Parameters are not re-read during a run | Wait for this run to finish, then run it again |
| A template downloaded from the workshop reports a missing provider | The template references a provider you have not configured | Replace it with your own provider in bulk as prompted |
| Requests occasionally time out | Provider rate limiting or network jitter | Agent runs resend automatically; for ordinary nodes just run it once more |

## Next

- [Your first flow](#first-run)
- [Parameters & runs](#params-runs)
- [Settings](#settings)
