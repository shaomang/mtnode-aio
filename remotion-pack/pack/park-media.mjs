/*
 * 媒体落地（media-park）：把渲染用的音视频从「输入源」搬到「渲染页能直接读到的地方」。
 *
 * 为什么要这一层：Remotion 的 <OffthreadVideo> 会把 src 原样拼进
 *   `/proxy?src=<URL 编码后的 src>&time=...`
 * 去拉帧。src 一旦是体量稍大的 base64 data URL（1.9MB 的片子编码后约 2.6MB），
 * 这个请求头就超过浏览器上限，Chromium 直接回 431 Request Header Fields Too Large，
 * 整条渲染失败（<Img> 不走 proxy，所以同一份 data URL 图片反而正常）。
 * 所以视频 / 音频必须换成**短 URL**：落盘到工程的 public/ 下，只把文件名交给合成层。
 */

/** 封装扩展名 → Content-Type */
const VIDEO_TYPES = {
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mkv': 'video/x-matroska',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
	'.m4v': 'video/mp4',
	'.mpeg': 'video/mpeg',
	'.mpg': 'video/mpeg',
	'.ts': 'video/mp2t',
};

const AUDIO_TYPES = {
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.flac': 'audio/flac',
	'.aac': 'audio/aac',
	'.ogg': 'audio/ogg',
	'.m4a': 'audio/mp4',
};

const PROPS = ['hero', 'voice', 'poster'];

/** Content-Type → 常见扩展名；不认识返回 null（调用方按 hero=mp4 / voice=mp3 兜底） */
export const extForContentType = (type) => {
	const t = String(type || '')
		.split(';')[0]
		.trim()
		.toLowerCase();
	if (!t) return null;
	for (const [ext, ct] of Object.entries(VIDEO_TYPES)) if (ct === t) return ext;
	for (const [ext, ct] of Object.entries(AUDIO_TYPES)) if (ct === t) return ext;
	return null;
};

/** 按扩展名推 Content-Type（不认识返回空串） */
export const contentTypeForFile = (filePath) => {
	const lower = String(filePath || '').toLowerCase();
	for (const [ext, ct] of Object.entries(VIDEO_TYPES)) if (lower.endsWith(ext)) return ct;
	for (const [ext, ct] of Object.entries(AUDIO_TYPES)) if (lower.endsWith(ext)) return ct;
	return '';
};

/** 拆 data URL；不是 data URL 返回 null */
export const parseDataUrl = (value) => {
	const s = String(value || '').trim();
	if (!s.startsWith('data:')) return null;
	const comma = s.indexOf(',');
	if (comma < 0) return null;
	const header = s.slice(5, comma);
	const isBase64 = /;base64$/i.test(header);
	const type = header
		.replace(/;base64$/i, '')
		.split(';')[0]
		.trim()
		.toLowerCase();
	if (!type || !type.includes('/')) return null;
	return {type, isBase64, body: s.slice(comma + 1)};
};

/** data 的估算字节数（不真正解码，只用于日志与上限判断） */
export const dataUrlByteSize = (value) => {
	const parsed = parseDataUrl(value);
	if (!parsed) return 0;
	if (!parsed.isBase64) return Buffer.byteLength(parsed.body);
	const padding = (parsed.body.match(/=+$/) || [''])[0].length;
	return Math.max(0, Math.floor((parsed.body.length * 3) / 4) - padding);
};

/** data URL → {bytes, contentType}；解不开返回 null（绝不静默变成空媒体） */
export const dataUrlToMedia = (value, prop = 'hero') => {
	const parsed = parseDataUrl(value);
	if (!parsed) return null;
	const bytes = Buffer.from(parsed.body, parsed.isBase64 ? 'base64' : 'utf8');
	if (!bytes.length) return null;
	const contentType = parsed.type || (prop === 'voice' ? 'audio/mpeg' : 'video/mp4');
	return {prop, bytes, contentType};
};

/**
 * 解析 render.json 的 mediaBlobs：{ hero: <base64>, voice: <base64> }
 * 宿主把它与压缩后的 mediaProps 分开给（渲染页看不到，避免白占内存）。
 */
export const unpackMediaBlobs = (cfg = {}) => {
	const out = {};
	const blobs = cfg.mediaBlobs || {};
	const meta = cfg.mediaBlobsMeta || {};
	for (const prop of Object.keys(blobs)) {
		const b64 = String(blobs[prop] || '').trim();
		if (!b64) continue;
		let bytes;
		try {
			bytes = Buffer.from(b64, 'base64');
		} catch {
			continue;
		}
		if (!bytes.length) continue;
		const contentType = String((meta[prop] && meta[prop].mime) || '').trim() || (prop === 'voice' ? 'audio/mpeg' : 'video/mp4');
		out[prop] = {prop, bytes, contentType};
	}
	return out;
};

/** 给日志用的短描述：`hero(1880KB,video/mp4)`，绝不打印整段 base64 */
export const describeMedia = (media) => {
	if (!media) return '(none)';
	const kb = media.bytes && media.bytes.length ? Math.round(media.bytes.length / 1024) : 0;
	return `${media.prop || '?'}(${kb}KB,${media.contentType || '?'})`;
};

/** 媒体文件名：<prop><ext>，落在 public/ 下（staticFile("<prop>.mp4") 能直接取到） */
export const parkedName = (prop, contentType) => {
	const ext = extForContentType(contentType) || (prop === 'voice' ? '.mp3' : '.mp4');
	return `${prop}${ext}`;
};

export {PROPS as PARKED_PROP_NAMES};
