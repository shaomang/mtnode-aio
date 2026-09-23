"""南风提示词与 H3 多参视频生成节点包入口。"""

from .h3_generator import NODE_CLASS_MAPPINGS
from .h3_generator import NODE_DISPLAY_NAME_MAPPINGS
from . import storyboard_api as _storyboard_api
from . import audio_drive_api as _audio_drive_api
from . import audio_media_api as _audio_media_api
from . import model_refresh_api as _model_refresh_api

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
