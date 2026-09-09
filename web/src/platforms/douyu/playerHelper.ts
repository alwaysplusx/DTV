import { invoke } from '@tauri-apps/api/core';

export type DouyuStreamConfig = {
  streamUrl: string;
  streamType: string | undefined;
  proxySession: string | null;
};

/**
 * 拉斗鱼直播流并按需落到本地 FLV 代理。`session` 用于多路代理隔离（多屏一格一路），
 * 应当由调用方持有，并在关闭时回传给 `stopDouyuProxy`。
 */
export async function getDouyuStreamConfig(
  roomId: string,
  quality: string = '原画',
  line?: string | null,
  session?: string | null,
): Promise<DouyuStreamConfig> {
  let finalStreamUrl: string | null = null;
  let streamType: string | undefined = undefined;
  const MAX_STREAM_FETCH_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_STREAM_FETCH_ATTEMPTS; attempt++) {
    try {
      const streamUrl = await invoke<string>('get_stream_url_with_quality_cmd', {
        roomId: roomId,
        quality: quality,
        line: line ?? null,
      });

      if (streamUrl) {
        finalStreamUrl = enforceHttps(streamUrl);
        streamType = 'flv';
        break;
      } else {
        throw new Error('斗鱼直播流地址获取为空。');
      }
    } catch (e: any) {
      console.error(`[DouyuPlayerHelper] 获取斗鱼直播流失败 (尝试 ${attempt}/${MAX_STREAM_FETCH_ATTEMPTS}):`, e.message);
      const offlineOrInvalidRoomMessages = [
        '主播未开播',
        '房间不存在',
        'error: 1',
        'error: 102',
        'error code 1',
        'error code 102',
      ];

      const errorMessageLowerCase = e.message?.toLowerCase() || '';
      const isDefinitivelyOffline = offlineOrInvalidRoomMessages.some(msg => errorMessageLowerCase.includes(msg.toLowerCase()));

      if (isDefinitivelyOffline) {
        console.warn(`[DouyuPlayerHelper] Streamer for room ${roomId} is definitively offline or room is invalid. Aborting retries.`);
        throw e;
      }

      if (attempt === MAX_STREAM_FETCH_ATTEMPTS) {
        throw new Error(`获取斗鱼直播流失败 (尝试 ${MAX_STREAM_FETCH_ATTEMPTS} 次后): ${e.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  if (!finalStreamUrl) {
    throw new Error('未能获取有效的斗鱼直播流地址。');
  }

  const sessionKey = session ?? null;
  try {
    await invoke('set_stream_url_cmd', { session: sessionKey, url: finalStreamUrl });
    const proxyUrl = await invoke<string>('start_proxy');
    // 带 session 的代理 URL（多路隔离）；空 session 则保持旧格式
    const proxied = sessionKey ? `${proxyUrl}/${encodeURIComponent(sessionKey)}` : proxyUrl;
    return { streamUrl: proxied, streamType, proxySession: sessionKey };
  } catch (e: any) {
    throw new Error(`设置斗鱼代理失败: ${e.message}`);
  }
}

/**
 * 关闭斗鱼代理某 session；由调用方传入之前 `getDouyuStreamConfig` 返回的 `proxySession`，
 * 避免 module-level 共享状态导致的多路误关。
 */
export async function stopDouyuProxy(session: string | null): Promise<void> {
  try {
    await invoke('stop_proxy', { session: session ?? null });
  } catch (e) {
    console.error('[DouyuPlayerHelper] Error stopping proxy server:', e);
  }
}

function enforceHttps(url: string): string {
  if (!url) return url;
  if (url.startsWith('https://')) return url;
  if (url.startsWith('http://')) {
    return `https://${url.slice('http://'.length)}`;
  }
  return url;
}
