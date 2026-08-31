/**
 * MTNodeRemotion 占位模板。
 * 宿主可整体替换本文件实现真实画面；帧数据通过
 * useCurrentFrame() / useVideoConfig() 获取，渲染参数来自 render.json。
 */
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';

export const MTNodeRemotion = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames, width, height} = useVideoConfig();
  const progress = durationInFrames > 1 ? frame / (durationInFrames - 1) : 1;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: '#101018',
        color: '#ffffff',
        fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div style={{fontSize: 72, fontWeight: 700, letterSpacing: 2}}>
        MTNode Remotion
      </div>
      <div style={{fontSize: 28, opacity: 0.8, marginTop: 16}}>
        frame {frame + 1} / {durationInFrames} · {width}×{height} · {fps} fps
      </div>
      <div
        style={{
          width: '60%',
          height: 8,
          marginTop: 40,
          borderRadius: 4,
          background: '#2a2a35',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.min(100, Math.max(0, progress * 100))}%`,
            height: 8,
            borderRadius: 4,
            background: '#6db4ff',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
