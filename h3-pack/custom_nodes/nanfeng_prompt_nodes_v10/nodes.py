"""南风提示词：本地 MiniMax H3 中文提示词与 @ 素材引用节点。"""

from __future__ import annotations

import re
from typing import Dict, List, Tuple

CATEGORY = "南风节点/提示词"


def _clean(value) -> str:
    return str(value or "").strip()


def _present(value) -> bool:
    return value is not None


def _replace_mentions(text: str, mapping: Dict[str, str]) -> str:
    """把 @图片/@视频/@音频 引用安全替换成 H3 官方标签。"""
    result = str(text or "")
    # 长编号优先，避免未来 @图片10 被 @图片1 抢先匹配。
    for source in sorted(mapping, key=len, reverse=True):
        result = result.replace(source, mapping[source])
    return result.strip()


def build_connected_mapping(images, videos, audios) -> Tuple[Dict[str, str], str]:
    """按实际已连接素材顺序生成 H3 的 1 基标签。"""
    mapping: Dict[str, str] = {}
    lines: List[str] = []

    picture_index = 1
    for slot, value in enumerate(images, 1):
        alias = f"@图片{slot}"
        if _present(value):
            tag = f"<Picture {picture_index}>"
            mapping[alias] = tag
            lines.append(f"{alias}（图片输入{slot}） -> {tag}")
            picture_index += 1

    video_index = 1
    for slot, value in enumerate(videos, 1):
        alias = f"@视频{slot}"
        if _present(value):
            tag = f"<Video {video_index}>"
            mapping[alias] = tag
            lines.append(f"{alias}（视频输入{slot}） -> {tag}")
            video_index += 1

    audio_index = 1
    for slot, value in enumerate(audios, 1):
        alias = f"@音频{slot}"
        if _present(value):
            tag = f"<Audio {audio_index}>"
            mapping[alias] = tag
            lines.append(f"{alias}（音频输入{slot}） -> {tag}")
            audio_index += 1

    return mapping, "\n".join(lines) if lines else "未连接参考素材。"


def _unknown_mentions(text: str, mapping: Dict[str, str]) -> List[str]:
    found = set(re.findall(r"@(图片|视频|音频)(\d+)", str(text or "")))
    aliases = {f"@{kind}{number}" for kind, number in found}
    return sorted(alias for alias in aliases if alias not in mapping)


def _subject_definitions(mapping: Dict[str, str]) -> str:
    lines: List[str] = []
    subject_index = 1
    for alias, tag in mapping.items():
        if alias.startswith("@图片"):
            lines.append(f"<Subject {subject_index}>是{tag}，按用户正文指定的职责使用该参考图片。")
            subject_index += 1
        elif alias.startswith("@视频"):
            lines.append(f"{tag}只按用户正文指定的动作、运镜或时序职责提供参考，不覆盖人物身份。")
        elif alias.startswith("@音频"):
            lines.append(f"{tag}只按用户正文指定的音色、环境声或节奏职责提供参考。")
    return "\n".join(lines) if lines else "不使用外部参考素材。"


def format_h3_prompt(
    user_text: str,
    mapping: Dict[str, str],
    mode: str,
    duration: float,
    aspect_ratio: str,
    no_prompt_reading: bool,
    no_text_watermark: bool,
) -> str:
    body = _replace_mentions(_clean(user_text), mapping)
    if not body:
        body = "请在这里填写画面、动作、镜头、声音和参考素材职责。"

    constraints: List[str] = []
    if no_prompt_reading:
        constraints.append(
            "全片没有额外对白、旁白、画外音或歌唱；任何人物都不得朗读提示词、镜头说明、"
            "动作描述或生成指令。除正文中明确写入<d>[Chinese] ...</d>的对白外，所有人物保持安静。"
        )
    if no_text_watermark:
        constraints.append("画面不要额外字幕、文字、水印或Logo。")

    detail = body
    if constraints:
        detail += "\n" + "\n".join(constraints)

    mode = str(mode)
    duration = max(1.0, float(duration))
    prefix = ""
    if mode == "首帧图生视频":
        prefix = "目标视频在0.00秒处完整参考<Picture 1>，该图片对应[Shot 1]的实际首帧。\n\n"
    elif mode == "首尾帧":
        prefix = (
            "参考图片与目标视频的对齐关系：<Picture 1>对应[Shot 1]的0.00秒；"
            f"<Picture 2>对应最后镜头的{duration:.2f}秒。\n\n"
        )
    elif mode == "仅尾帧":
        prefix = f"<Picture 1>对应目标视频最后镜头的{duration:.2f}秒，并作为实际尾帧。\n\n"

    if mode == "全能参考":
        return (
            f"subject_definitions:\n{_subject_definitions(mapping)}\n\n"
            f"summary:\n[全能参考生成] 生成{duration:g}秒、{aspect_ratio}视频；严格按照下方正文中的素材职责、动作顺序和镜头要求执行。\n\n"
            "retention_analysis:\n所有被引用的人物、场景、服装、道具和声音保持各自来源稳定；"
            "视频参考只执行正文指定的动作或运镜职责，不得污染人物身份。\n\n"
            f"detailed_description:\n[Shot 1] 00:00.000，{detail}\n\n"
            "overall_soundscape:\n只生成正文明确要求的环境声、动作声和非语言声响，并与画面准确同步；若正文未要求声音则为N/A。\n\n"
            "non_diegetic_music:\nN/A"
        )

    return (
        f"{prefix}integrated_multimodal_description:\n"
        f"[Shot 1] 00:00.000，{detail}\n\n"
        "overall_soundscape:\n只生成正文明确要求的环境声、动作声和非语言声响，并与画面准确同步；若正文未要求声音则为N/A。\n\n"
        "non_diegetic_music:\nN/A"
    )


class NanFengH3PromptDraft:
    """用户通过 @图片/@视频/@音频 写自然语言，输出 H3 STRING。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "提示词": ("STRING", {
                    "multiline": True,
                    "dynamicPrompts": False,
                    "default": "@图片1 中的人物在室内缓慢转头看向镜头，保持人物外观一致。",
                }),
                "插入引用": ([
                    "@图片1", "@图片2", "@图片3",
                    "@视频1", "@视频2", "@视频3",
                    "@音频1", "@音频2", "@音频3",
                ], {"default": "@图片1"}),
                "模式": (["全能参考", "文生视频", "首帧图生视频", "首尾帧", "仅尾帧"], {"default": "全能参考"}),
                "时长秒": ("FLOAT", {"default": 5.0, "min": 1.0, "max": 60.0, "step": 0.1}),
                "画幅": (["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"], {"default": "16:9"}),
                "无对白防朗读": ("BOOLEAN", {"default": True}),
                "不要字幕水印Logo": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "图片1": ("IMAGE",),
                "图片2": ("IMAGE",),
                "图片3": ("IMAGE",),
                "视频1": ("IMAGE",),
                "视频2": ("IMAGE",),
                "视频3": ("IMAGE",),
                "音频1": ("AUDIO",),
                "音频2": ("AUDIO",),
                "音频3": ("AUDIO",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(
        self,
        提示词,
        插入引用,
        模式,
        时长秒,
        画幅,
        无对白防朗读=True,
        不要字幕水印Logo=True,
        图片1=None,
        图片2=None,
        图片3=None,
        视频1=None,
        视频2=None,
        视频3=None,
        音频1=None,
        音频2=None,
        音频3=None,
    ):
        mapping, _ = build_connected_mapping(
            (图片1, 图片2, 图片3),
            (视频1, 视频2, 视频3),
            (音频1, 音频2, 音频3),
        )
        unknown = _unknown_mentions(提示词, mapping)
        if unknown:
            raise ValueError("以下@引用没有连接对应素材：" + "、".join(unknown))

        output = format_h3_prompt(
            提示词,
            mapping,
            模式,
            时长秒,
            画幅,
            bool(无对白防朗读),
            bool(不要字幕水印Logo),
        )
        return (output,)


class NanFengH3ReferenceNumbering:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本": ("STRING", {"multiline": True, "default": "@图片1 @视频1 @音频1"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("文本",)
    FUNCTION = "passthrough"
    CATEGORY = CATEGORY

    def passthrough(self, 文本):
        return (str(文本),)


class NanFengPromptList:
    """使用独立文本框构建 ComfyUI STRING 列表，供下游逐项执行。"""

    MAX_PROMPTS = 20

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "提示词框数量": ("INT", {"default": 3, "min": 1, "max": cls.MAX_PROMPTS, "step": 1}),
            "统一前缀": ("STRING", {"multiline": True, "dynamicPrompts": False, "default": ""}),
            "统一后缀": ("STRING", {"multiline": True, "dynamicPrompts": False, "default": ""}),
        }
        for index in range(1, cls.MAX_PROMPTS + 1):
            required[f"提示词{index}"] = (
                "STRING",
                {"multiline": True, "dynamicPrompts": False, "default": ""},
            )
        return {"required": required}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("提示词", "原始提示词")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "build_list"
    CATEGORY = CATEGORY

    def build_list(self, 提示词框数量, 统一前缀="", 统一后缀="", **kwargs):
        count = max(1, min(int(提示词框数量), self.MAX_PROMPTS))
        prefix = str(统一前缀 or "")
        suffix = str(统一后缀 or "")
        bodies = [str(kwargs.get(f"提示词{index}", "")).strip() for index in range(1, count + 1)]
        bodies = [body for body in bodies if body]
        if not bodies:
            raise ValueError("南风提示词列表：请至少填写一个可见提示词框。")
        prompts = [f"{prefix}{body}{suffix}" for body in bodies]
        return (prompts, bodies)


NODE_CLASS_MAPPINGS = {
    "NanFengH3PromptDraft": NanFengH3PromptDraft,
    "NanFengH3ReferenceNumbering": NanFengH3ReferenceNumbering,
    "NanFengPromptList": NanFengPromptList,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NanFengH3PromptDraft": "南风提示词",
    "NanFengH3ReferenceNumbering": "南风@引用文本",
    "NanFengPromptList": "南风提示词列表",
}
