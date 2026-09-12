# Agent task & session

> One-sentence goal: set a session's four switches the right way, make use of its supporting features, and steer clear of a few common misconceptions.

![会话从哪来与四组开关](img/mtnode-agent-02-ui.svg)

*Figure: the three session entry points and the four switches — model, preset, thinking effort, tool permissions*

## The four switches (model · preset · thinking effort · tool permissions)

- **Model**: a flash-tier model is enough for most work; switch up for long-document reasoning, complex extraction or code.
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
