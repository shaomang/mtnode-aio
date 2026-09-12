# Providers & API

> One-sentence goal: get an API key that starts with `sk-` and enter it into MTNode — first understand what an API key is, sign up with one of the four Chinese providers, go through an aggregator when you need foreign models or image generation, and finally get the key and enter it in three steps.

![From sign-up to entering it in MTNode](img/mtnode-start-01-ui.svg)

*Figure: the three steps to get an API key and enter it into MTNode*

## What an API key is (the membership card for AI)

### What an API key is, and why you need one for AI services

An API key is best understood as a "membership card you paid for" with an AI model provider.

- You register an account on the provider's website and top up credit, and the platform gives you a string (usually shaped like `sk-xxxxxxxxxxxxxxxx`) — that string is the API key.
- Enter that string into MTNode's settings (or into any caller) and you can call that provider's models: every use is billed by usage against your balance.
- So it is essentially the credential for "your account + your money", as sensitive as a bank account number plus password. Once it leaks (posted in a group chat, screenshotted and sent to someone, written into a public repository, uploaded to a third-party site), anyone can spend your balance on model calls.

### Safety rules

1. Never give the full key to anyone, never screenshot it, never paste it into a chat window, never write it into a public repository.
2. Only create and copy keys on the provider's official pages; never buy "shared keys / top-up keys" of unknown origin.
3. If you suspect a leak: delete the old key in the provider's console right away and create a new one — doing so is completely free.
4. Most platforms let you set a usage cap or a low-balance alert on the key so it cannot be drained.

## The four major Chinese providers + sign-up URLs

### Mainstream Chinese model providers (pick one of the four)

1. DeepSeek (深度求索)
   Sign-up URL: https://platform.deepseek.com/
2. Qwen / Tongyi (通义千问, Alibaba Cloud Bailian)
   Sign-up URL: https://bailian.console.aliyun.com/
3. GLM / BigModel (智谱)
   Sign-up URL: https://bigmodel.cn/
4. Kimi (月之暗面 Moonshot)
   Sign-up URL: https://platform.moonshot.cn/

### Current advice

At this stage DeepSeek alone is enough: extremely good value, very fast, first tier for Chinese and code, a low sign-up barrier, and the least hassle for a beginner. The other three are worth registering and keeping as a backup, to top up only when you actually need them — the package deals they run from time to time are good value too.

### The general flow

Register an account (phone number / email) → verify identity and top up (most platforms give new users free credit, so you can try for free first) → open the "API Keys" page → create a key → copy it and save it immediately.

Note: a key is usually shown in full only once, at creation time; close the page and you can never see it again — you can only create a new one.

## Foreign models / GPT image generation: the API易 aggregator

### What to do when you need foreign models or GPT image generation models

Connecting directly to foreign model APIs from mainland China is usually inconvenient — especially for GPT-series image generation models. An aggregator such as API易 solves this.

Sign-up URL: https://api.apiyi.com/

### Notes

- API易 is recommended mainly for image generation; calling a foreign flagship model (for example GPT-6 or Fable 5) is very expensive, and you are free to choose another aggregator of the same kind.
- What an aggregator does: with one account, one key and one OpenAI-compatible endpoint it forwards your calls to many models, so you do not have to solve network access yourself.
- How to use it in MTNode: open the "Model services (模型服务)" settings → add a provider → follow API易's official docs to enter the Base URL (the endpoint, for example https://api.apiyi.com/v1) and the API key you just got → the corresponding foreign / image models become selectable (for example gpt-image-2.5-all).

### Reminders

- An aggregator is also pay-as-you-go: watch your balance and usage cap, and the key must never be shared.
- "Image models" need a provider of their own, with the type set to "图像 OpenAI兼容" (Image · OpenAI-compatible).

## Get the key and enter it into MTNode in three steps

### Configure MTNode

Step 1 · Register: open any of the sign-up URLs above (for example DeepSeek: https://platform.deepseek.com/) and register and sign in with a phone number or email.

Step 2 · Top up / claim credit: a small top-up is fine to start (for example 10 CNY to test the water).

Step 3 · Create and save the key: open the "API Keys" page → click "Create / New" → copy the string that starts with sk- → paste it into a local notepad or password manager first.

### Enter the key into MTNode

Open the app's "Settings → Model services (设置 → 模型服务)" → pick or add a provider (Deepseek Official) → paste the API key into the key box → save. After that you can pick that provider's models on a node and use them.

### One last reminder

This key is your bank account number plus password: never share it, and if you suspect a leak, delete and recreate it in the provider's console right away.
