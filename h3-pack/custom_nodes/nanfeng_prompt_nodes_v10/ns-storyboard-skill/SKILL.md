---
name: H3官方提示词
description: 用户明确说“H3官方提示词”或“用H3官方写”时调用；先做连续性与空间审计，再输出精简的MiniMax官方英文结构。不得与“海螺H3提示词”或本地中文流程混用。
---

# H3 Official Prompt — Continuity-First Production

## Goal

Generate a MiniMax H3 official-structure prompt that is executable, concise, and continuity-safe. Correctness outranks decorative detail. Never expose internal planning unless the user asks for it.

## 1. Select the Official Mode

1. Identify T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For T2VA/I2VA/FL2VA/L2VA, read `references/base-en.txt` for exact official labels and alignment syntax.
3. For Ref2VA, read `references/ref-en.txt` for exact six-section structure and label semantics.
4. Preserve official field names, section order, reference labels, and timing notation.

## 2. Build a Private Continuity Ledger Before Writing

Create a compact internal ledger in Chinese or terse structured notes. Do not output it by default.

For every segment and shot, track:

- **Identity:** stable subject label, appearance, clothing, distinguishing features, speaker ID.
- **Frame position:** screen-left/center/right and foreground/midground/background.
- **Body state:** facing direction, head/eye direction, pose, leading foot, occupied hands.
- **Relationship:** who faces whom, relative distance, occlusion, and movement path.
- **Props:** owner, hand used, open/closed/intact/broken state, fixed scene location.
- **Scene anchors:** doors, windows, table, vehicle, entrances, exits, and their stable directions.
- **Camera:** shot size, camera side of the action axis, angle, motion, and subject scale.
- **Action phase:** exact start state, observable transition, and end state.
- **Audio:** speaker, dialogue order, carry-over, ambience, and requested music.

If the user supplies multiple segments, the end ledger of segment N becomes the start ledger of segment N+1 unless an explicit transition changes it.

## 3. Hard Continuity Rules

### Cross-Segment Handoff

- Segment N+1 must begin from segment N's final visible state: same identity, costume, location, screen direction, pose, gaze, prop ownership/state, lighting, and camera-axis side unless the user explicitly changes one.
- When a previous tail frame or source-video ending is available, use it as the next segment's first-frame/continuation anchor under the correct official mode.
- Continue the unfinished action from its current phase. Never restart, repeat, skip, or reverse it.
- State only the inherited facts needed to prevent drift; do not re-narrate the previous segment.

### Boundary Pair Design

- Treat the final shot of segment N and the opening shot of segment N+1 as one jointly designed edit pair, not as two independently invented shots. Plan the pair before writing either segment.
- Preserve the exact world state across the cut: screen-left/right, foreground/midground/background, facing and eyeline, distance, occlusion, action phase, hand/prop state, travel direction, and the established side of the 180-degree axis.
- The boundary must provide a useful editorial change. Prefer an axis-safe shot/reverse shot, an immediate reaction shot, or a motivated change of shot size or camera angle that reveals new information.
- Unless the user explicitly requests one uninterrupted matching viewpoint, the final shot of segment N and the first shot of segment N+1 must not use the same shot size and the same camera angle. Change at least shot size, camera angle, or viewed subject while preserving spatial continuity.
- For dialogue or face-to-face action, use shot/reverse shot with matching eyelines and stable left/right relationship. Do not mirror the characters, cross the axis, reset the pose, or teleport them merely to create variety.
- If a continuous same-view handoff is genuinely necessary, carry visible motion across the boundary or use a deliberate match-on-action; never restart the action at 00:00.

### Within-Segment Spatial Logic

- Establish all important subjects and scene anchors at the start of each shot.
- Use camera-relative terms (`screen-left/right`) for composition and scene-relative anchors (`beside the door`, `behind the table`) for physical space. Do not silently swap them.
- Preserve the 180-degree action axis across cuts. If crossing the axis is required, show a motivated continuous camera move or a neutral re-establishing shot.
- Preserve eyelines and travel direction across cuts.
- Define each prop transfer as visible hand-to-hand or place-to-pickup action. No teleportation or unexplained hand switching.
- A cut changes viewpoint, not world state. The new shot begins at the exact state reached before the cut.

### Action Path

Every major action follows:

`start state → one observable transition path → end state/reaction`

Use concrete physical verbs. Do not bundle several independent major actions into one instant. Do not let camera motion compete with a complex body action unless both are essential.

## 4. Identity and Framing Safety

- Use stable `<Subject N>` labels in Ref2VA and stable natural-language identity anchors in base modes.
- Repeat only the few identity traits needed to prevent drift; do not redescribe the complete character in every shot.
- For character-action prompts, default to close shot, medium close-up, or medium shot. Avoid distant, ultra-wide, establishing-wide framing, or characters occupying a small part of the image unless explicitly requested.
- Keep faces, hands, and the action-critical prop readable.

## 5. Duration and Information Budget

Fit content to the requested duration before drafting:

- Treat the runtime-provided current video duration as a hard prerequisite for every generated storyboard segment. Before writing, explicitly budget that exact number of seconds; never silently assume a default duration.
- Scale action density, number of shots/cuts, dialogue length, reaction time, and end-state settling to that exact per-segment duration. A simple action such as dancing should be expanded only as far as the available seconds can visibly support, not padded with unrelated events.

- Default to one principal action or one short exchange per segment.
- Prefer one continuous shot for short action clips and FL2VA interpolation.
- Add a cut only when it reveals necessary new information; do not cut merely to vary shot size.
- Reserve time for the action to settle into the requested final state.
- Check that dialogue can be spoken naturally within the available duration while leaving time for visible action and reaction.
- If requested content cannot fit, simplify secondary action/camera/ambience first. Never delete, reorder, translate, or change user-provided dialogue. If it still cannot fit, explicitly warn the user instead of silently compressing it into impossible timing.

## 6. Prompt Compression Hierarchy

Keep, in this order:

1. reference/frame alignment;
2. subject identity;
3. initial spatial and object state;
4. main action path and final state;
5. camera framing/axis needed for readability;
6. dialogue and synchronized essential sound;
7. minimal ambience.

Remove first:

- repeated appearance descriptions;
- plot-summary duplication;
- decorative texture and mood adjectives;
- unnecessary camera amplitude/speed labels;
- redundant restatements across Ref2VA sections;
- invented music or secondary action.

There is no mandatory 350–500-word target. Length follows information load. A short prompt that preserves all executable constraints is preferred over a long prompt with diluted priorities.

## 7. Language and Output

- Use internal Chinese planning when useful for logic checks.
- Write final official fields and rewrite sections in English.
- Preserve dialogue, lyrics, and visible text in their original language.
- Keep the original speaker, meaning, wording, punctuation, and dialogue order. Integrate dialogue naturally into shot action; do not create a separate dialogue field.
- “No subtitles” means no rendered captions; it never means delete spoken dialogue.
- Default `non_diegetic_music` to `N/A` unless the user explicitly requests music or the referenced soundtrack must be retained.
- Do not invent dialogue, narration, music, extra characters, scene changes, or major actions merely to enrich the prompt.

## 8. Mode Output Structures

### Base modes

Use the exact applicable alignment instruction from `references/base-en.txt`, then:

```text
integrated_multimodal_description: ...

overall_soundscape: ...

non_diegetic_music: ...
```

### Ref2VA

Use these exact sections in order:

```text
subject_definitions:
...

summary:
...

retention_analysis:
...

detailed_description:
...

overall_soundscape:
...

non_diegetic_music:
...
```

Keep `summary` and `retention_analysis` concise. Put executable timeline detail only in `detailed_description`.

## 9. Mandatory Preflight — Fix Before Output

Silently verify every item:

- [ ] Correct H3 mode and official field order.
- [ ] Every reference label resolves and keeps one meaning.
- [ ] Segment start exactly inherits the prior segment end where continuity is required.
- [ ] No character swaps screen side, depth, facing direction, gaze, or axis side without a visible cause.
- [ ] No prop changes owner, hand, location, or state without a visible action.
- [ ] Every action has a feasible start, path, and end; no restart, jump, or reversal.
- [ ] Cuts preserve world state, eyeline, travel direction, and action phase.
- [ ] Shot size keeps action-critical people, faces, hands, and props readable.
- [ ] Timing is strictly increasing and fits the requested duration.
- [ ] Dialogue is verbatim, assigned to the correct speaker, ordered correctly, and speakable in time.
- [ ] Prompt contains no duplicated low-value prose or conflicting instruction.
- [ ] `non_diegetic_music` is `N/A` by default. Use background music only when the user explicitly provides or designates a reference audio/music track for reuse; otherwise never invent, recommend, or add background music, even if cinematic scoring might fit. Preserve dialogue, ambience, foley, and sound effects separately under `overall_soundscape`.

If any item fails, revise the prompt before returning it. When the source itself is contradictory or missing a required continuity state, state the smallest explicit assumption rather than guessing silently.
