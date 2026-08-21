---
name: novel-to-video-preproduction
title: 小说视频素材与分镜拆解
description: 使用多Agent协作，从长篇小说中完整提取人物、组织、场景、道具、事件、任务和剧情，生成剧情大纲、视频素材清单与可拍摄分镜，并通过覆盖率审计防止遗漏。
---

# 小说视频素材与分镜拆解

用户提供**完整小说正文**（不得只给摘要或节选）时启用。按下方规范用多 Agent 协作完成提取、大纲、素材清单与分镜。最终只输出**一份合法 YAML 1.2 文档**：无 Markdown 围栏、无注释、无前言结语。覆盖率未达 100% 时 `status` 必须为 `blocked`。

默认：语言 `zh-CN`，`execution_mode: multi_agent`，`final_output_format: yaml`，片幅 `16:9`，风格「电影级写实」，单镜默认 4 秒。缺省输入见规范 `inputs.optional`。

```yaml
version: "1.0.0"

skill:
  name: "novel_to_video_preproduction"
  display_name: "长篇小说视频素材与分镜拆解"
  description: "使用多Agent协作，从长篇小说中完整提取人物、组织、场景、道具、事件、任务和剧情，生成剧情大纲、视频素材清单与可拍摄分镜，并通过覆盖率审计防止遗漏。"
  language: "zh-CN"
  execution_mode: "multi_agent"
  final_output_format: "yaml"

  objectives:
    - "建立覆盖全部显性人物、隐性人物、群体角色、动物、非人角色和被提及角色的人物档案。"
    - "建立覆盖全部地点、子地点、时间状态、天气状态和特殊空间的场景档案。"
    - "提取全部事件、行动、任务、冲突、线索、伏笔、揭示、转折和因果关系。"
    - "将完整剧情整理为卷、章、幕、序列、场次和剧情节拍大纲。"
    - "把全部可视化剧情节拍转换为可拍摄或可生成的视频分镜。"
    - "生成角色、场景、服装、道具、特效、声音和镜头制作素材清单。"
    - "为每项提取结果保留可追溯的原文定位。"
    - "只有在覆盖率审计通过后才允许输出completed状态。"

  invocation:
    trigger_examples:
      - "分析这部长篇小说并生成视频制作素材和完整分镜。"
      - "提取小说全部人物、场景、剧情大纲与镜头脚本。"
      - "将小说转换为严格YAML格式的视频前期制作文档。"

  inputs:
    required:
      novel_text:
        type: "string"
        description: "完整小说正文。不得只提供摘要或节选。"
    optional:
      title:
        type: "string"
        default: "未命名小说"
      source_id:
        type: "string"
        default: "source_001"
      chapter_pattern:
        type: "string"
        default: "自动识别"
      target_video_style:
        type: "string"
        default: "电影级写实"
      target_aspect_ratio:
        type: "string"
        default: "16:9"
      target_episode_duration_seconds:
        type: "integer"
        default: 0
        description: "0表示不限制，由剧情长度决定。"
      target_shot_duration_seconds:
        type: "number"
        default: 4.0
      content_rating:
        type: "string"
        default: "保持原著尺度"
      chunk_max_chars:
        type: "integer"
        default: 18000
      chunk_overlap_chars:
        type: "integer"
        default: 1200
      generate_visual_prompts:
        type: "boolean"
        default: true
      generate_negative_prompts:
        type: "boolean"
        default: true

  non_negotiable_rules:
    - "不得将未读到的内容推断为原著事实。"
    - "不得为了缩短输出而合并具有不同身份、行为、时空、因果或叙事作用的条目。"
    - "不得遗漏无姓名人物、群体人物、传闻人物、梦中人物、回忆人物、尸体、动物、怪物、人工智能和其他具有叙事作用的实体。"
    - "同一人物的别名必须归并，但身份尚未确认时必须保留独立实体并记录可能关联。"
    - "不得遗漏主场景、子场景、过渡场景、梦境、回忆、幻觉、通信空间、画外空间和被叙述的重要地点。"
    - "不得遗漏对白中提到但未直接演出的关键事件、任务、人物和地点。"
    - "不得遗漏失败行动、中断行动、未完成任务、支线任务和结果未知的任务。"
    - "每个人物、场景、事件、剧情节拍和分镜都必须包含source_refs。"
    - "分镜不得改变原著事件顺序，除非明确标记为改编建议。"
    - "事实与推断必须分离；推断内容必须标记confidence和evidence。"
    - "无法确认的信息使用null、unknown或空数组，不得编造。"
    - "最终结果必须是单一合法YAML文档，不得使用Markdown代码围栏。"
    - "最终YAML不得包含注释、制表符、锚点、别名节点或自定义标签。"
    - "若原文覆盖率未达到100%，status必须为blocked，并输出全部缺口，不得声称处理完成。"

  id_conventions:
    source_segment: "SRC-000001"
    chapter: "CH-0001"
    character: "CHAR-0001"
    faction: "FAC-0001"
    location: "LOC-0001"
    scene: "SCN-000001"
    event: "EVT-000001"
    task: "TASK-000001"
    clue: "CLUE-000001"
    plot_beat: "BEAT-000001"
    outline_node: "OUT-000001"
    shot: "SHOT-000001"
    asset: "ASSET-000001"
    continuity_issue: "CONT-0001"
    omission_gap: "GAP-0001"

  agents:
    coordinator:
      role: "总控与流程编排Agent"
      responsibilities:
        - "验证输入是否包含完整正文。"
        - "执行章节识别、文本切片和任务分发。"
        - "维护全局ID、实体注册表和版本。"
        - "协调冲突消解、合并、复查和最终输出。"
        - "在任一审计未通过时阻止completed输出。"

    source_indexer:
      role: "原文索引Agent"
      responsibilities:
        - "识别卷、章、节、段落和句子边界。"
        - "将正文切分为可追溯的source_segments。"
        - "为每个片段记录字符范围、章节、段落和首尾锚点。"
        - "标记正文、标题、题记、书信、日记、梦境、回忆和附录等文本类型。"

    narrative_unit_extractor:
      role: "最小叙事单元提取Agent"
      responsibilities:
        - "逐片段拆分最小叙事单元。"
        - "记录人物出现、行为、状态变化、对白、地点、时间和因果。"
        - "为每个原文片段建立coverage_ledger。"
        - "即使内容无法形成镜头，也必须记录为非视觉叙事单元。"

    character_agent:
      role: "人物与组织设定Agent"
      responsibilities:
        - "提取全部人物、别名、称谓、身份和关系。"
        - "提取外貌、年龄阶段、体型、服装、声音、习惯、能力和心理特征。"
        - "区分原文明确事实、上下文推断和未知信息。"
        - "跟踪人物在不同时间点的造型、伤势、装备和立场变化。"
        - "建立组织、阵营、家族、群体和隶属关系。"

    scene_agent:
      role: "场景与环境设定Agent"
      responsibilities:
        - "提取全部地点及其层级关系。"
        - "记录时代、日期、时段、季节、天气、光线和环境状态。"
        - "记录布局、入口、出口、地标、可交互物和空间连续性。"
        - "同一地点在不同时间或破坏状态下建立scene_variants。"

    plot_agent:
      role: "剧情、事件与任务Agent"
      responsibilities:
        - "提取所有事件、行动、目标、任务、冲突、阻碍、结果和后果。"
        - "构建事件时间线、叙事顺序和真实时间顺序。"
        - "提取伏笔、线索、秘密、揭示、回收和未解决问题。"
        - "建立事件之间的因果、触发、依赖、对照和并行关系。"
        - "生成不省略支线的分层剧情大纲。"

    storyboard_agent:
      role: "分镜拆解Agent"
      responsibilities:
        - "将每个可视化剧情节拍拆分为一个或多个镜头。"
        - "保留动作、对白、旁白、情绪、空间关系和关键反应。"
        - "为镜头指定景别、角度、机位、运动、构图、时长和转场。"
        - "关联人物、场景、服装、道具、特效和声音素材。"
        - "不得用蒙太奇替代关键情节，除非每个被压缩事件均有独立镜头记录。"

    asset_agent:
      role: "视频素材规划Agent"
      responsibilities:
        - "生成人物定妆、表情、服装和姿态素材需求。"
        - "生成场景建立镜头、环境细节和状态变体素材需求。"
        - "生成道具、载具、武器、动物、特效、字幕和图形素材需求。"
        - "生成图像或视频模型可使用的正向提示词和负向提示词。"
        - "维护跨镜头视觉一致性锚点。"

    continuity_agent:
      role: "连续性检查Agent"
      responsibilities:
        - "检查人物位置、服装、伤势、道具和时间连续性。"
        - "检查场景方向、视线、轴线、光线和天气连续性。"
        - "检查事件前置条件和因果关系。"
        - "记录原著自身矛盾，不得擅自修正。"

    coverage_auditor:
      role: "零遗漏审计Agent"
      responsibilities:
        - "逐source_segment核对是否已被叙事单元覆盖。"
        - "逐叙事单元核对是否已映射到事件、人物、场景或非视觉说明。"
        - "逐事件核对是否已进入大纲。"
        - "逐可视化剧情节拍核对是否已进入分镜。"
        - "检查所有引用ID是否存在且无悬空引用。"
        - "计算覆盖率并生成遗漏缺口。"

  workflow:
    - step: 1
      name: "输入验证"
      agent: "coordinator"
      actions:
        - "检查正文是否为空、截断或仅为摘要。"
        - "记录输入哈希和字符总数。"
        - "正文疑似不完整时标记blocked。"

    - step: 2
      name: "章节识别与原文索引"
      agent: "source_indexer"
      actions:
        - "按卷、章、节、段落建立层级索引。"
        - "按chunk_max_chars切片，并使用chunk_overlap_chars保留上下文。"
        - "重叠文本只计一次覆盖率。"
        - "生成不可变source_segment ID。"

    - step: 3
      name: "第一轮逐片段提取"
      agents:
        - "narrative_unit_extractor"
        - "character_agent"
        - "scene_agent"
        - "plot_agent"
      execution: "parallel"
      actions:
        - "逐片段提取，不允许只依据章节摘要。"
        - "所有结果携带source_refs。"
        - "记录跨片段待消解实体。"

    - step: 4
      name: "全局实体归并"
      agent: "coordinator"
      actions:
        - "依据姓名、别名、关系、行为和时间上下文归并实体。"
        - "保留全部原始提及记录。"
        - "身份不确定时使用possible_same_as，不得强行合并。"

    - step: 5
      name: "第二轮反向复查"
      agents:
        - "character_agent"
        - "scene_agent"
        - "plot_agent"
      execution: "parallel"
      actions:
        - "从人物注册表反查全部出场片段。"
        - "从场景注册表反查全部地点提及。"
        - "从事件时间线反查行动、对白、任务和结果。"
        - "补充第一轮遗漏并记录修订来源。"

    - step: 6
      name: "完整剧情大纲"
      agent: "plot_agent"
      actions:
        - "按卷、章、幕、序列、场次和剧情节拍生成大纲。"
        - "同时保留叙事顺序与故事真实时间顺序。"
        - "为每个剧情节拍关联事件、人物、场景、任务和线索。"

    - step: 7
      name: "分镜拆解"
      agent: "storyboard_agent"
      actions:
        - "逐剧情节拍生成镜头。"
        - "关键动作、关键对白、重要反应和结果分别落镜。"
        - "纯心理或说明性内容使用旁白、视觉隐喻或明确的不可视化标记。"
        - "每个镜头至少关联一个plot_beat_id和一个source_ref。"

    - step: 8
      name: "素材清单生成"
      agent: "asset_agent"
      actions:
        - "从人物、场景和分镜反向汇总全部素材。"
        - "为变装、年龄变化、伤势变化和场景状态变化建立独立变体。"
        - "生成视觉一致性锚点和模型提示词。"

    - step: 9
      name: "连续性审计"
      agent: "continuity_agent"
      actions:
        - "检查所有镜头和事件的时间、空间及状态连续性。"
        - "将原著矛盾与拆解错误分开记录。"

    - step: 10
      name: "覆盖率审计"
      agent: "coverage_auditor"
      actions:
        - "计算原文片段覆盖率。"
        - "计算人物提及覆盖率。"
        - "计算场景提及覆盖率。"
        - "计算事件进入大纲的覆盖率。"
        - "计算可视化剧情节拍进入分镜的覆盖率。"
        - "检查孤立ID、重复ID和无来源条目。"

    - step: 11
      name: "最终YAML输出"
      agent: "coordinator"
      actions:
        - "仅输出符合final_output_schema的YAML。"
        - "审计全部通过时status设为completed。"
        - "存在任何缺口时status设为blocked，并列出omission_gaps。"

  extraction_policy:
    source_reference_required_fields:
      - "source_id"
      - "chapter_id"
      - "segment_id"
      - "paragraph_index"
      - "start_char"
      - "end_char"
      - "quote"
    quote_policy:
      max_quote_chars: 160
      description: "引用用于定位，不替代结构化提取。"
    confidence_levels:
      explicit: "原文明示。"
      strongly_implied: "由多个明确证据强烈支持。"
      inferred: "合理推断但未被原文确认。"
      unknown: "无法判断。"
    adaptation_policy:
      preserve_original_facts: true
      separate_adaptation_suggestions: true
      allow_unmarked_invention: false

  completion_gates:
    source_segment_coverage: 1.0
    narrative_unit_classification_coverage: 1.0
    character_mention_coverage: 1.0
    location_mention_coverage: 1.0
    event_outline_coverage: 1.0
    visual_beat_storyboard_coverage: 1.0
    dangling_reference_count: 0
    duplicate_primary_id_count: 0
    unresolved_omission_gap_count: 0
    rule: "任一指标未达标时，最终status必须为blocked。"

  final_output_rules:
    - "输出必须能被YAML 1.2解析器直接解析。"
    - "顶层只能存在final_output_schema定义的字段。"
    - "所有字段名使用snake_case。"
    - "ID必须使用id_conventions规定的格式。"
    - "未知标量使用null，不得使用含糊占位文本。"
    - "无数据的集合使用[]或{}。"
    - "多行文本使用YAML块标量。"
    - "字符串中的特殊字符必须正确转义。"
    - "不得输出Markdown、解释文字、前言或结语。"

  final_output_schema:
    meta:
      required_fields:
        - "schema_version"
        - "status"
        - "title"
        - "source_id"
        - "source_hash"
        - "language"
        - "generated_at"
        - "target_video_style"
        - "target_aspect_ratio"
      status_values:
        - "completed"
        - "blocked"

    source_index:
      item_fields:
        - "segment_id"
        - "chapter_id"
        - "section_path"
        - "text_type"
        - "paragraph_index"
        - "start_char"
        - "end_char"
        - "text_hash"
        - "coverage_status"

    characters:
      item_fields:
        - "character_id"
        - "canonical_name"
        - "aliases"
        - "entity_type"
        - "narrative_importance"
        - "identity"
        - "age"
        - "gender"
        - "appearance"
        - "body_features"
        - "voice"
        - "personality"
        - "motivation"
        - "abilities"
        - "weaknesses"
        - "relationships"
        - "faction_ids"
        - "costume_variants"
        - "state_timeline"
        - "first_appearance"
        - "last_appearance"
        - "possible_same_as"
        - "visual_consistency_anchors"
        - "facts"
        - "inferences"
        - "source_refs"

    factions:
      item_fields:
        - "faction_id"
        - "name"
        - "aliases"
        - "type"
        - "purpose"
        - "members"
        - "hierarchy"
        - "relationships"
        - "visual_identity"
        - "source_refs"

    locations:
      item_fields:
        - "location_id"
        - "name"
        - "aliases"
        - "parent_location_id"
        - "location_type"
        - "era"
        - "geography"
        - "layout"
        - "entrances"
        - "exits"
        - "landmarks"
        - "lighting"
        - "weather"
        - "ambient_details"
        - "interactive_objects"
        - "scene_variants"
        - "visual_consistency_anchors"
        - "source_refs"

    props:
      item_fields:
        - "asset_id"
        - "name"
        - "type"
        - "owner_character_ids"
        - "description"
        - "state_timeline"
        - "plot_function"
        - "visual_consistency_anchors"
        - "source_refs"

    events:
      item_fields:
        - "event_id"
        - "title"
        - "event_type"
        - "narrative_order"
        - "chronological_order"
        - "summary"
        - "participant_character_ids"
        - "location_ids"
        - "trigger_event_ids"
        - "prerequisite_event_ids"
        - "actions"
        - "conflicts"
        - "outcome"
        - "consequence_event_ids"
        - "task_ids"
        - "clue_ids"
        - "source_refs"

    tasks:
      item_fields:
        - "task_id"
        - "title"
        - "issuer_character_id"
        - "executor_character_ids"
        - "objective"
        - "constraints"
        - "status"
        - "result"
        - "related_event_ids"
        - "source_refs"

    clues_and_foreshadowing:
      item_fields:
        - "clue_id"
        - "type"
        - "content"
        - "introduced_at"
        - "noticed_by_character_ids"
        - "related_event_ids"
        - "payoff_at"
        - "resolution_status"
        - "source_refs"

    plot_outline:
      hierarchy:
        - "volume"
        - "chapter"
        - "act"
        - "sequence"
        - "scene"
        - "plot_beat"
      item_fields:
        - "outline_id"
        - "parent_outline_id"
        - "level"
        - "order"
        - "title"
        - "summary"
        - "character_ids"
        - "location_ids"
        - "event_ids"
        - "task_ids"
        - "clue_ids"
        - "emotional_change"
        - "dramatic_function"
        - "source_refs"

    storyboard:
      scene_fields:
        - "scene_id"
        - "outline_id"
        - "scene_heading"
        - "location_ids"
        - "time"
        - "weather"
        - "character_ids"
        - "event_ids"
        - "scene_objective"
        - "scene_conflict"
        - "scene_outcome"
        - "shots"
        - "source_refs"
      shot_fields:
        - "shot_id"
        - "order"
        - "plot_beat_ids"
        - "source_refs"
        - "duration_seconds"
        - "shot_size"
        - "camera_angle"
        - "camera_position"
        - "camera_movement"
        - "lens"
        - "composition"
        - "visual_description"
        - "character_ids"
        - "character_actions"
        - "facial_expressions"
        - "location_ids"
        - "prop_asset_ids"
        - "costume_variant_ids"
        - "dialogue"
        - "voice_over"
        - "on_screen_text"
        - "sound_effects"
        - "music"
        - "lighting"
        - "visual_effects"
        - "transition_in"
        - "transition_out"
        - "continuity_notes"
        - "generation_prompt"
        - "negative_prompt"

    asset_manifest:
      categories:
        - "character"
        - "costume"
        - "location"
        - "prop"
        - "vehicle"
        - "creature"
        - "visual_effect"
        - "graphic"
        - "sound_effect"
        - "music"
        - "voice"
      item_fields:
        - "asset_id"
        - "category"
        - "name"
        - "variant"
        - "description"
        - "required_views"
        - "required_expressions"
        - "required_actions"
        - "used_in_scene_ids"
        - "used_in_shot_ids"
        - "consistency_anchors"
        - "generation_prompt"
        - "negative_prompt"
        - "source_refs"

    adaptation_suggestions:
      item_fields:
        - "suggestion_id"
        - "type"
        - "description"
        - "reason"
        - "affected_event_ids"
        - "affected_shot_ids"
        - "changes_original_order"
        - "approval_required"

    continuity_report:
      item_fields:
        - "issue_id"
        - "issue_type"
        - "severity"
        - "description"
        - "is_original_text_conflict"
        - "related_ids"
        - "source_refs"
        - "recommended_resolution"

    coverage_report:
      required_fields:
        - "source_segment_total"
        - "source_segment_covered"
        - "source_segment_coverage"
        - "narrative_unit_total"
        - "narrative_unit_classified"
        - "narrative_unit_coverage"
        - "character_mention_total"
        - "character_mention_covered"
        - "character_mention_coverage"
        - "location_mention_total"
        - "location_mention_covered"
        - "location_mention_coverage"
        - "event_total"
        - "events_in_outline"
        - "event_outline_coverage"
        - "visual_beat_total"
        - "visual_beats_in_storyboard"
        - "visual_beat_storyboard_coverage"
        - "dangling_reference_count"
        - "duplicate_primary_id_count"
        - "audit_passed"

    omission_gaps:
      item_fields:
        - "gap_id"
        - "gap_type"
        - "description"
        - "source_refs"
        - "affected_ids"
        - "blocking"
        - "required_action"

    coverage_ledger:
      item_fields:
        - "segment_id"
        - "narrative_unit_ids"
        - "character_ids"
        - "location_ids"
        - "event_ids"
        - "outline_ids"
        - "scene_ids"
        - "shot_ids"
        - "classification"
        - "coverage_status"
        - "notes"

  top_level_output_order:
    - "meta"
    - "source_index"
    - "characters"
    - "factions"
    - "locations"
    - "props"
    - "events"
    - "tasks"
    - "clues_and_foreshadowing"
    - "plot_outline"
    - "storyboard"
    - "asset_manifest"
    - "adaptation_suggestions"
    - "continuity_report"
    - "coverage_report"
    - "omission_gaps"
    - "coverage_ledger"
```

