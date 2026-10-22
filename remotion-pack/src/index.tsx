/**
 * Remotion 入口：注册唯一合成 Main。
 *
 * 合成组件固定从 ./Composition 取 Main（宿主渲染前按「内置模板 / 图生图台词卡 / 自定义 TSX」
 * 三种口径重写 src/ 下的这两个文件，见 remotion/main-remotion.js 的 writeRenderSources）。
 * 时长 / 尺寸 / fps / 参数一律由 render.json 里的同名字段在 selectComposition 之后就地覆盖，
 * 这里的占位值只保证入口本身可编译。
 */
import {Composition, registerRoot} from 'remotion';
import {Main} from './Composition';

function RemotionRoot() {
  return (
    <Composition
      id="Main"
      component={Main}
      durationInFrames={300}
      fps={30}
      width={1280}
      height={720}
    />
  );
}

registerRoot(RemotionRoot);
