/**
 * Remotion 入口：注册唯一合成 MTNodeRemotion。
 *
 * durationInFrames / fps / width / height 为占位常量，宿主渲染前按
 * render.json 中的对应值就地替换（以行尾 __MTNODE_*__ 标记为定位锚点），
 * 本模板本身保持可编译（占位值即默认值）。
 */
import {Composition, registerRoot} from 'remotion';
import {MTNodeRemotion} from './Composition';

const durationInFrames = 300; // __MTNODE_DURATION_IN_FRAMES__
const fps = 30; // __MTNODE_FPS__
const width = 1280; // __MTNODE_WIDTH__
const height = 720; // __MTNODE_HEIGHT__

function RemotionRoot() {
  return (
    <Composition
      id="MTNodeRemotion"
      component={MTNodeRemotion}
      durationInFrames={durationInFrames}
      fps={fps}
      width={width}
      height={height}
    />
  );
}

registerRoot(RemotionRoot);
