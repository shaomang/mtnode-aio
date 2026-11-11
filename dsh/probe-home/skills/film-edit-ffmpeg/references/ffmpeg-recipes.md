# ffmpeg 命令模板全集

所有命令给完整参数，直接改路径即可跑。默认 ffmpeg 6.1+；Windows PowerShell 下路径用正斜杠或双反斜杠。

## 1. 探测与自检

```bash
# 全量流信息
ffprobe -v error -show_streams -show_format -of json input.mp4

# 只看视频流关键字段
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,avg_frame_rate,codec_name,pix_fmt,color_transfer,color_primaries,bit_rate,nb_frames -of default=nw=1 input.mp4

# 看容器时长、体积、总码率
ffprobe -v error -show_entries format=duration,size,bit_rate -of default=nw=1 input.mp4

# 精确帧数（慢，交付前数一次）
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 input.mp4

# 检查构建能力：必须能看到 libx264 / libass / drawtext / loudnorm / sidechaincompress
ffmpeg -hide_banner -filters | grep -E "subtitles|ass|drawtext|loudnorm|sidechaincompress|xfade|zoompan|zscale"
ffmpeg -hide_banner -encoders | grep -E "libx264|libx265|h264_nvenc|h264_qsv|h264_videotoolbox"
```

## 2. 抽帧、封面、联系表

```bash
# 指定时刻抽一帧（秒，支持小数）
ffmpeg -y -ss 3.500 -i input.mp4 -frames:v 1 -q:v 2 out/still_03.5.jpg

# 每秒抽一帧到序列（检查节奏与新信息密度）
ffmpeg -y -i input.mp4 -vf "fps=1" -q:v 2 out/seq_%03d.jpg

# 联系表：每 2 秒一帧，4 列 3 行
ffmpeg -y -i input.mp4 -vf "fps=1/2,scale=320:-2,tile=4x3" -frames:v 1 out/sheet.jpg

# 封面（从母版取指定帧并压成平台常用尺寸）
ffmpeg -y -ss 2.000 -i master.mp4 -frames:v 1 -vf "scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440" -q:v 2 out/cover_3x4.jpg
```

## 3. 裁切

```bash
# 快速 copy（入点会吸到关键帧）
ffmpeg -y -ss 00:01:02.000 -i input.mp4 -t 8.000 -map 0 -c copy -avoid_negative_ts make_zero -movflags +faststart out/cut_copy.mp4

# 精确重编码（推荐用于交付）
ffmpeg -y -ss 00:01:02.400 -i input.mp4 -t 8.240 -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart out/cut_exact.mp4

# 一次切多段并各自成文件（用 filter_complex 的 trim，帧级精确）
ffmpeg -y -i input.mp4 -filter_complex "[0:v]trim=start=12.4:end=20.8,setpts=PTS-STARTPTS[v0];[0:a]atrim=start=12.4:end=20.8,asetpts=PTS-STARTPTS[a0];[0:v]trim=start=95.0:end=103.5,setpts=PTS-STARTPTS[v1];[0:a]atrim=start=95.0:end=103.5,asetpts=PTS-STARTPTS[a1]" -map "[v0]" -map "[a0]" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k out/c01.mp4 -map "[v1]" -map "[a1]" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k out/c02.mp4
```

## 4. 拼接

```bash
# 文件列表（PowerShell）
"file 'C:/work/C01.mp4'`nfile 'C:/work/C02.mp4'`nfile 'C:/work/C03.mp4'" | Set-Content -Encoding ascii work/list.txt

# copy 拼接
ffmpeg -y -f concat -safe 0 -i work/list.txt -c copy -movflags +faststart work/joined.mp4

# 统一规格后滤镜拼接（两段示例，多段自行扩展）
ffmpeg -y -i work/c01.mp4 -i work/c02.mp4 -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0];[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v1];[1:a]aresample=48000,aformat=channel_layouts=stereo[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart work/joined_filter.mp4

# 给无声片段补静音轨
ffmpeg -y -i silent.mp4 -f lavfi -i anullsrc=r=48000:cl=stereo -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest with_audio.mp4
```

## 5. 变速与定格

```bash
# 加速 1.25（音画同步）
ffmpeg -y -i in.mp4 -filter_complex "[0:v]setpts=PTS/1.25[v];[0:a]atempo=1.25[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k out/fast125.mp4

# 加速 3 倍（atempo 超 2.0 必须串联）
ffmpeg -y -i in.mp4 -filter_complex "[0:v]setpts=PTS/3[v];[0:a]atempo=2.0,atempo=1.5[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k out/fast300.mp4

# 慢放 0.8 倍
ffmpeg -y -i in.mp4 -filter_complex "[0:v]setpts=PTS/0.8[v];[0:a]atempo=0.8[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k out/slow080.mp4

# 末帧定格 2 秒（用于片尾 CTA）
ffmpeg -y -i in.mp4 -vf "tpad=stop_mode=clone:stop_duration=2" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k out/hold.mp4
```

## 6. 画幅、裁边、旋转、稳定

```bash
# 竖屏裁满（不变形）
ffmpeg -y -i in.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" -c:v libx264 -preset medium -crf 20 -c:a copy out/vertical.mp4

# 竖屏加黑边（保留全画面）
ffmpeg -y -i in.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1" -c:v libx264 -preset medium -crf 20 -c:a copy out/vertical_pad.mp4

# 1:1
ffmpeg -y -i in.mp4 -vf "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080" -c:v libx264 -preset medium -crf 20 -c:a copy out/square.mp4

# 去黑边（自动检测阈值 24，取整到偶数）
ffmpeg -y -i in.mp4 -vf "cropdetect=24:2:0" -f null -
ffmpeg -y -i in.mp4 -vf "crop=1908:1072:6:4,scale=1920:1080" -c:v libx264 -preset medium -crf 18 -c:a copy out/cropped.mp4

# 旋转（手机竖拍方向错）
ffmpeg -y -i in.mp4 -vf "transpose=1" -c:v libx264 -preset medium -crf 18 -c:a copy out/rot90.mp4

# 轻度稳定（需构建带 libvidstab；两遍，第二遍用第一遍的 transforms.trf）
ffmpeg -y -i in.mp4 -vf "vidstabdetect=shakiness=6:accuracy=15:result=work/transforms.trf" -f null -
ffmpeg -y -i in.mp4 -vf "vidstabtransform=input=work/transforms.trf:smoothing=12,unsharp=5:5:0.6" -c:v libx264 -preset medium -crf 18 -c:a copy out/stable.mp4
```

## 7. 字幕

```bash
# ASS 烧录（带字体目录）
ffmpeg -y -i in.mp4 -vf "subtitles=captions.ass:fontsdir=fonts" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a copy out/burned.mp4

# SRT 烧录并强制样式
ffmpeg -y -i in.mp4 -vf "subtitles=captions.srt:force_style='FontName=Noto Sans CJK SC,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=0,MarginV=58,Alignment=2'" -c:v libx264 -preset medium -crf 18 -c:a copy out/burned_srt.mp4

# 软字幕轨（mov_text）
ffmpeg -y -i in.mp4 -i captions.srt -map 0 -map 1 -c copy -c:s mov_text -metadata:s:s:0 language=chi out/softsub.mp4

# 双语两条软轨
ffmpeg -y -i in.mp4 -i zh.srt -i en.srt -map 0 -map 1 -map 2 -c copy -c:s mov_text -metadata:s:s:0 language=chi -metadata:s:s:1 language=eng out/softsub_bi.mp4

# 从视频里抽字幕
ffmpeg -y -i in.mp4 -map 0:s:0 out/extracted.srt
```

## 8. 音轨：替换、叠加、闪避、响度

```bash
# 抽音轨
ffmpeg -y -i in.mp4 -vn -c:a pcm_s16le out/audio.wav

# 替换音轨（画面不动）
ffmpeg -y -i in.mp4 -i voice.wav -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest out/replaced.mp4

# 旁白 + BGM，BGM 固定压低到 0.18
ffmpeg -y -i in.mp4 -i voice.wav -i bgm.wav -filter_complex "[1:a]volume=1.0[v];[2:a]volume=0.18,aloop=loop=-1:size=2e+09[b];[v][b]amix=inputs=2:duration=first:normalize=0[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k out/mix_flat.mp4

# 旁白 + BGM，BGM 被旁白侧链压低
ffmpeg -y -i in.mp4 -i voice.wav -i bgm.wav -filter_complex "[2:a]volume=0.25,aloop=loop=-1:size=2e+09[bg];[bg][1:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=350[duck];[1:a][duck]amix=inputs=2:duration=first:normalize=0[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 48000 out/mix_duck.mp4

# 单声道转立体声并统一采样率
ffmpeg -y -i voice.wav -c:a aac -b:a 192k -ar 48000 -ac 2 out/voice_stereo.m4a

# 响度测量（第一遍）
ffmpeg -hide_banner -i out/mix_duck.mp4 -af loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json -f null -

# 响度应用（第二遍，数值来自第一遍输出）
ffmpeg -y -i out/mix_duck.mp4 -af "loudnorm=I=-14:TP=-1.0:LRA=11:measured_I=-18.2:measured_TP=-1.4:measured_LRA=8.1:measured_thresh=-28.6:offset=0.3:linear=true" -c:v copy -c:a aac -b:a 192k out/normalized.mp4
```

## 9. 画面包装

```bash
# 左上角水印（透明度 0.75）
ffmpeg -y -i in.mp4 -i logo.png -filter_complex "[1:v]format=rgba,colorchannelmixer=aa=0.75[logo];[0:v][logo]overlay=40:40:format=auto[v]" -map "[v]" -map 0:a -c:v libx264 -preset medium -crf 18 -c:a copy out/wm.mp4

# 右下角画中画（宽 420，圆角不做，位置留 60 边距）
ffmpeg -y -i main.mp4 -i pip.mp4 -filter_complex "[1:v]scale=420:-2[p];[0:v][p]overlay=W-w-60:H-h-60:format=auto[v]" -map "[v]" -map 0:a -c:v libx264 -preset medium -crf 18 -c:a copy out/pip.mp4

# 绿幕抠像叠到录屏上
ffmpeg -y -i screen.mp4 -i heygen_green.mp4 -filter_complex "[1:v]chromakey=0x00ff00:0.18:0.08,scale=420:-1[avatar];[0:v][avatar]overlay=W-w-60:H-h-40:format=auto[v]" -map "[v]" -map 0:a? -map 1:a? -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k out/avatar_over_screen.mp4

# 下三分之一底色条（不透明）
ffmpeg -y -i in.mp4 -vf "drawbox=x=0:y=ih-260:w=iw:h=260:color=black@0.55:t=fill" -c:v libx264 -preset medium -crf 18 -c:a copy out/lowerthird.mp4

# 烧时间码（核查剪辑点用）
ffmpeg -y -i in.mp4 -vf "drawtext=text='%{pts\:hms}':x=40:y=40:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6" -c:v libx264 -preset veryfast -crf 23 -an out/tc.mp4
```

## 10. 转码与多版本

```bash
# H.264 1080p 交付
ffmpeg -y -i master.mov -c:v libx264 -preset slow -crf 20 -profile:v high -level 4.1 -pix_fmt yuv420p -r 30 -g 60 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart out/deliver_1080p.mp4

# HEVC 1080p（体积优先）
ffmpeg -y -i master.mov -c:v libx265 -preset medium -crf 24 -pix_fmt yuv420p -tag:v hvc1 -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart out/deliver_hevc.mp4

# ProRes 422 HQ 母版（剪辑交接）
ffmpeg -y -i master.mov -c:v prores_ks -profile:v 3 -vendor apl0 -pix_fmt yuv422p10le -c:a pcm_s16le -ar 48000 out/master_prores.mov

# 码率上限控制（平台有硬上限时）
ffmpeg -y -i master.mov -c:v libx264 -preset medium -b:v 10M -maxrate 12M -bufsize 20M -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart out/deliver_10m.mp4

# GIF（480 宽、12fps，两遍调色板）
ffmpeg -y -i in.mp4 -vf "fps=12,scale=480:-1:flags=lanczos,palettegen" work/palette.png
ffmpeg -y -i in.mp4 -i work/palette.png -filter_complex "fps=12,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse" out/out.gif
```

## 11. 音量与静音处理

```bash
# 整体增益 -3 dB
ffmpeg -y -i in.mp4 -af "volume=-3dB" -c:v copy -c:a aac -b:a 192k out/vol.mp4

# 检测静音段（噪声门 -35dB，最短 0.45 秒）
ffmpeg -hide_banner -i in.mp4 -af silencedetect=noise=-35dB:d=0.45 -f null -

# 检测爆音／削波（看 Peak_level 与 Flat_factor）
ffmpeg -hide_banner -i in.mp4 -af "astats=metadata=1:reset=0" -f null -
```
