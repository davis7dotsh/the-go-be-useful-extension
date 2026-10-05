export const COMPOSER_URL = 'https://x.com/compose/post';
export const AUTH_PATHS = ['/login', '/i/flow/login', '/i/flow/verify', '/i/flow/two-factor-authentication', '/account/access'] as const;
export const PROFILE_KEY = 'profileHandle';
export const RULE_IDS = [1, 2, 3, 4, 5, 6, 7, 8];
const RESERVED_HANDLES = new Set(['home', 'explore', 'search', 'notifications', 'messages', 'i', 'settings', 'compose', 'login', 'logout', 'signup', 'account', 'accounts', 'intent', 'share', 'hashtag', 'tos', 'privacy', 'about', 'download', 'help', 'jobs', 'statuses', 'profile', 'topics', 'communities', 'bookmarks', 'lists', 'followers', 'following', 'status', 'likes', 'media', 'premium']);
export function normalizeProfileHandle(value: unknown) {
  if (typeof value !== 'string') return null;
  const handle = value.trim().toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) && !RESERVED_HANDLES.has(handle) ? handle : null;
}
export function profileDestination(profileHandle: unknown) {
  const handle = normalizeProfileHandle(profileHandle);
  return handle ? `https://x.com/${handle}` : COMPOSER_URL;
}
export type UrlKind = 'unrestricted' | 'youtube-studio' | 'youtube' | 'instagram' | 'x-compose' | 'x-auth' | 'x-profile' | 'x-restricted' | 'twitter';

function hostMatches(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
export function isXHost(hostname: string) {
  return hostMatches(hostname.toLowerCase(), 'x.com') || hostMatches(hostname.toLowerCase(), 'twitter.com');
}
export function classifyUrl(value: string, profileHandle?: string | null): { kind: UrlKind } {
  let url: URL;
  try { url = new URL(value); } catch { return { kind: 'unrestricted' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'unrestricted' };
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'studio.youtube.com') return { kind: 'youtube-studio' };
  if (hostMatches(hostname, 'youtube.com')) return { kind: 'youtube' };
  if (hostMatches(hostname, 'instagram.com')) return { kind: 'instagram' };
  if (hostMatches(hostname, 'twitter.com')) return { kind: 'twitter' };
  if (!hostMatches(hostname, 'x.com')) return { kind: 'unrestricted' };
  const pathname = url.pathname.replace(/\/$/, '');
  if (hostname === 'x.com' || hostname === 'www.x.com') {
    if (/^\/compose\/post(?:\/(?:media|tags|alt))?$/.test(pathname)) return { kind: 'x-compose' };
    const handle = normalizeProfileHandle(profileHandle);
    if (handle && new RegExp(`^/${handle}(/status/[0-9]+)?$`, 'i').test(pathname)) return { kind: 'x-profile' };
    if (AUTH_PATHS.some(path => pathname === path)) return { kind: 'x-auth' };
  }
  return { kind: 'x-restricted' };
}

export function destinationForUrl(url: string, extensionOrigin: string, profileHandle?: string | null) {
  const { kind } = classifyUrl(url, profileHandle);
  if (kind === 'youtube' || kind === 'instagram') return new URL(`/blocked/index.html?site=${kind}`, extensionOrigin).href;
  if (kind === 'x-restricted' || kind === 'twitter') return profileDestination(profileHandle);
  return null;
}

export function buildNavigationRules(extensionOrigin: string, profileHandle?: string | null): chrome.declarativeNetRequest.Rule[] {
  const condition = (regexFilter: string): chrome.declarativeNetRequest.RuleCondition => ({ regexFilter, resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] });
  const site = (domain: string) => `^https?://([^./]+\\.)*${domain.replaceAll('.', '\\.')}(:[0-9]+)?(/|$)`;
  const redirect = (id: number, domain: string, url: string): chrome.declarativeNetRequest.Rule => ({ id, priority: 10, action: { type: 'redirect' as chrome.declarativeNetRequest.RuleActionType, redirect: { url } }, condition: condition(site(domain)) });
  const allow = (id: number, regex: string): chrome.declarativeNetRequest.Rule => ({ id, priority: 20, action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType }, condition: condition(regex) });
  const canonicalX = '^https?://(www\\.)?x\\.com(:[0-9]+)?';
  const handle = normalizeProfileHandle(profileHandle);
  return [
    redirect(1, 'youtube.com', new URL('/blocked/index.html?site=youtube', extensionOrigin).href),
    redirect(2, 'instagram.com', new URL('/blocked/index.html?site=instagram', extensionOrigin).href),
    redirect(3, 'x.com', profileDestination(handle)),
    redirect(4, 'twitter.com', profileDestination(handle)),
    allow(5, '^https?://studio\\.youtube\\.com(:[0-9]+)?(/|$)'),
    allow(6, `${canonicalX}/compose/post(/(media|tags|alt))?/?([?#]|$)`),
    allow(7, `${canonicalX}(${AUTH_PATHS.join('|')})/?([?#]|$)`),
    ...(handle ? [allow(8, `${canonicalX}/${handle}(/status/[0-9]+)?/?([?#]|$)`)] : []),
  ];
}
