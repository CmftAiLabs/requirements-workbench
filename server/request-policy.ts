import {timingSafeEqual} from 'node:crypto';

/** The reverse proxy must preserve Host and Origin; forwarded headers are not trusted. */
export function normalizePublicOrigin(value = '') {
 if (!value.trim()) return '';
 const url = new URL(value.trim());
 if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
  throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTPS 域名，不含路径、账号或查询参数。');
 return url.origin;
}

export function requestAccessError(method: string, host: string, origin: string | undefined, publicOrigin: string, fetchSite?: string) {
 const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
 const external = !!publicOrigin && host === new URL(publicOrigin).host;
 if (!local && !external) return '请求域名未获允许。';
 if (method !== 'GET' && method !== 'HEAD') {
  const expectedOrigin = external ? publicOrigin : `http://${host}`;
  if ((origin && origin !== expectedOrigin) || fetchSite === 'cross-site')
   return '请求来源不匹配，请从工作台页面发起操作。';
 }
 return undefined;
}

export function proxyTokenMatches(expected: string, actual: string | string[] | undefined) {
 if (!expected) return true;
 if (typeof actual !== 'string') return false;
 const supplied=Buffer.from(actual),required=Buffer.from(expected);
 return supplied.length===required.length && timingSafeEqual(supplied,required);
}
