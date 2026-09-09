// 虎牙 OSS 缩图参数：列表卡片与关注页共用，避免拉原始大图
const HUYA_COVER_OSS_PARAMS =
  "x-oss-process=image/resize,limit_0,m_fill,w_338,h_190/sharpen,80/format,jpg/interlace,1/quality,q_90";

export function appendHuyaCoverParams(url: string | null | undefined): string {
  if (!url) return url || "";
  if (url.includes("x-oss-process=")) return url;
  return url.includes("?") ? `${url}&${HUYA_COVER_OSS_PARAMS}` : `${url}?${HUYA_COVER_OSS_PARAMS}`;
}
