/**
 * 入口占位合成（随 remotion-pack 发版）。
 *
 * 这不是给用户手改的成品模板：真正渲染时，宿主会在每次渲染前用
 * remotion/main-remotion.js 的 writeRenderSources 重写工程目录 src/ 下的
 * Composition.tsx 与 index.tsx ——
 *   · 节点里贴了合成代码 / 工作流产物 → 用那份自定义 TSX；
 *   · 都没有 → 用宿主生成的内置标题卡模板（buildCompositionSource）。
 *
 * 这个文件只负责让脚手架本身「装完就能编译」：导出一个最小的 Main，
 * 不绑定任何具体工作流的版面，也不读取任何专属 props。
 */
import React from 'react';
import {AbsoluteFill, Img, useVideoConfig} from 'remotion';

export type Props = {
  title?: string;
  subtitle?: string;
  image?: string;
  backgroundColor?: string;
};

export const Main: React.FC<Props> = ({title, subtitle, image, backgroundColor}) => {
  const {width, height} = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        backgroundColor: backgroundColor || '#0f1218',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {image ? (
        <Img
          src={image}
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
        />
      ) : null}
      <div
        style={{
          position: 'relative',
          color: '#f2f4f8',
          fontFamily:
            '"Noto Sans SC","Source Han Sans SC","Microsoft YaHei","PingFang SC",sans-serif',
          textAlign: 'center',
          padding: Math.round(width * 0.06),
        }}
      >
        <div style={{fontSize: Math.round(height * 0.07), fontWeight: 700}}>{title || ''}</div>
        <div style={{fontSize: Math.round(height * 0.035), opacity: 0.8, marginTop: Math.round(height * 0.02)}}>
          {subtitle || ''}
        </div>
      </div>
    </AbsoluteFill>
  );
};
