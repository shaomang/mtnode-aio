# Agent task & session

> One-sentence goal: set a session's switches the right way, make use of its supporting features, and steer clear of a few common misconceptions.

![会话从哪来与四组开关](img/mtnode-agent-02-ui.svg)

*Figure: the three session entry points and the switches — model provider, model, preset, thinking effort, tool permissions*

## The switches (model provider · model · preset · thinking effort · tool permissions)

The **⚙ chip** in the composer opens the picker menu; top to bottom it has four cells:
**model provider → preset → model → thinking effort**.

- **Model provider**: which provider this session runs on (DeepSeek official, or a provider you added under Settings → Model services). Pick the provider first; the next cell, **Model**, then lists only that provider's models. Switching provider moves the model to that provider's first model as well, so you never end up with "A's model on B's route" — a combination that only blows up at run time.
- **Model**: a flash-tier model is enough for most work; switch up for long-document reasoning, complex extraction or code. Lists the current provider's models only.
- **Preset**: decides the AI's persona and which abilities it carries; development work usually uses 「精简」(Lean).
- **Thinking effort**: off / low / high / max. Higher usually means better quality and more tokens; low or high is enough day to day.
- **Tool permissions**: which tools are allowed — file read/write, web search, canvas editing, asking questions, image reading. For ordinary jobs it is worth turning image reading off, otherwise the AI may keep taking screenshots to confirm things and waste tokens.

## Other features

- **Thinking translation**: reasoning is mostly in English, so to look into a segment and trace a problem, click the thinking segment on the right. It translates with DeepSeek with thinking off (the default).
- **Tool arguments**: the session shows the tool-call log and the details of each call.
- **Token report**: the bottom shows this session's token usage report and cost (DeepSeek only). The calculation cannot be exact, so treat official platform statistics as final.

## Common misconceptions

- Avoid one session doing everything. The more mixed the context, the higher and more expensive the usage. Split sessions by task.
- **Tool permissions**: if a session cannot read files or reach the web and so cannot finish the job, the permission may simply be off.
- **Thinking effort**: low / high is enough day to day; max is normally only used when setting up a new project, and when architecture is involved it is worth using a high-end model as well.
