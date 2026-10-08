import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNavigationRules, classifyUrl, destinationForUrl, normalizeProfileHandle, profileDestination } from '../src/shared/policy';
import { parseMessage } from '../src/shared/messages';
import { normalizeState, isActive } from '../src/shared/state';

const origin = 'chrome-extension://test-extension/';
const cases = [
  ['https://youtube.com/watch?v=abc', 'youtube'],
  ['https://www.youtube.com/shorts/123', 'youtube'],
  ['https://m.youtube.com/results?search_query=hi', 'youtube'],
  ['https://music.youtube.com/', 'youtube-music'],
  ['https://music.youtube.com/watch?v=abc', 'youtube-music'],
  ['https://music.youtube.com/playlist?list=abc', 'youtube-music'],
  ['https://music.youtube.com.youtube.com/', 'youtube'],
  ['https://music.youtube.com.evil.test/', 'unrestricted'],
  ['https://www.music.youtube.com/', 'youtube'],
  ['https://studio.youtube.com/channel/123/videos/upload', 'youtube-studio'],
  ['https://studio.youtube.com.evil.test/', 'unrestricted'],
  ['https://studio.youtube.com.youtube.com/', 'youtube'],
  ['https://instagram.com/', 'instagram'],
  ['https://www.instagram.com/reels/', 'instagram'],
  ['https://instagram.com.example.org/', 'unrestricted'],
  ['https://example.org/youtube.com', 'unrestricted'],
  ['https://x.com/compose/post', 'x-compose'],
  ['https://x.com/compose/post/?text=hello#draft', 'x-compose'],
  ['https://www.x.com/compose/post', 'x-compose'],
  ['https://x.com/compose/post/extra', 'x-restricted'],
  ['https://x.com/i/flow/login/?redirect_after_login=%2Fhome', 'x-auth'],
  ['https://x.com/account/access', 'x-auth'],
  ['https://x.com/i/flow/login/home', 'x-restricted'],
  ['https://x.com/login-extra', 'x-restricted'],
  ['https://x.com/home', 'x-restricted'],
  ['https://x.com/davis7', 'x-restricted'],
  ['https://x.com/search?q=hi', 'x-restricted'],
  ['https://mobile.x.com/home', 'x-restricted'],
  ['https://twitter.com/compose/tweet', 'twitter'],
  ['https://mobile.twitter.com/home', 'twitter'],
  ['https://twitter.com.example.org/', 'unrestricted'],
  ['https://x.com.example.org/home', 'unrestricted'],
  ['not a url', 'unrestricted'],
  ['file:///youtube.com', 'unrestricted'],
] as const;
for (const [url, expected] of cases) test(`URL policy: ${url}`, () => assert.equal(classifyUrl(url).kind, expected));

const rules = buildNavigationRules(origin);
function ruleFor(url: string) {
  return rules.filter(rule => new RegExp(rule.condition.regexFilter ?? '', 'i').test(url)).sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1))[0];
}
test('generated main-frame rules match classifier with priority exceptions', () => {
  for (const [url, kind] of cases) {
    const rule = ruleFor(url);
    const allowed = ['youtube-studio', 'youtube-music', 'x-compose', 'x-auth'].includes(kind);
    if (kind === 'unrestricted') assert.equal(rule, undefined, url);
    else assert.equal(rule?.action.type, allowed ? 'allow' : 'redirect', url);
  }
  assert.ok(rules.every(rule => rule.condition.resourceTypes?.length === 1 && rule.condition.resourceTypes[0] === 'main_frame'));
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
});
test('existing composer, Studio, and Music require no navigation', () => {
  assert.equal(destinationForUrl('https://x.com/compose/post?text=draft', origin), null);
  assert.equal(destinationForUrl('https://studio.youtube.com/', origin), null);
  assert.equal(destinationForUrl('https://music.youtube.com/watch?v=abc', origin), null);
  assert.equal(destinationForUrl('https://twitter.com/home', origin), 'https://x.com/compose/post');
  assert.equal(destinationForUrl('https://youtube.com/watch?v=abc', origin), `${origin}blocked/index.html?site=youtube`);
});
test('state expiration is authoritative before, at, and after timestamp', () => {
  const saved = { version: 1 as const, enabled: true, endsAt: 1000 };
  assert.equal(isActive(saved, 999), true);
  assert.equal(isActive(saved, 1000), false);
  assert.equal(isActive(saved, 1001), false);
  assert.deepEqual(normalizeState(saved, 1000), { version: 1, enabled: false, endsAt: null });
  assert.equal(normalizeState({ version: 1, enabled: true, endsAt: null }, 99999).enabled, true);
});
test('malformed state and message data fail closed', () => {
  for (const value of [null, {}, { version: 2, enabled: true, endsAt: null }, { version: 1, enabled: 'yes', endsAt: null }, { version: 1, enabled: true, endsAt: Infinity }, { version: 1, enabled: true, endsAt: '1000' }]) assert.equal(normalizeState(value).enabled, false);
  for (const value of [{ type: 'focus:start', duration: 1 }, { type: 'focus:start', duration: '25' }, { type: 'focus:start' }, {}, null]) assert.equal(parseMessage(value), null);
  assert.deepEqual(parseMessage({ type: 'focus:start', duration: 25 }), { type: 'focus:start', duration: 25 });
});


test('profile discovery validates handles and excludes route names and pattern injection', () => {
  assert.equal(normalizeProfileHandle('Creator_42'), 'creator_42');
  for (const handle of ['', 'home', 'Home', 'search', 'compose', 'i', 'settings', 'account', 'creator/status/123', 'creator.*', 'creator-42', 'a'.repeat(16), '@creator']) assert.equal(normalizeProfileHandle(handle), null, handle);
  assert.equal(profileDestination('Creator_42'), 'https://x.com/creator_42');
  assert.equal(profileDestination(null), 'https://x.com/compose/post');
  assert.equal(parseMessage({ type: 'focus:profile', handle: 'home' }), null);
  assert.deepEqual(parseMessage({ type: 'focus:profile', handle: 'Creator_42' }), { type: 'focus:profile', handle: 'creator_42' });
});
test('own profile Posts and numeric own post details are allowed, other tabs and people stay restricted', () => {
  const handle = 'creator_42';
  const allowed = [
    'https://x.com/creator_42',
    'https://www.x.com/Creator_42/?foo=bar',
    'https://x.com/creator_42/status/1234567890',
    'https://x.com/creator_42/status/1234567890/?s=20',
  ];
  const blocked = [
    'https://x.com/other_creator',
    'https://x.com/other_creator/status/1234567890',
    'https://x.com/creator_42/likes',
    'https://x.com/creator_42/with_replies',
    'https://x.com/creator_42/media',
    'https://x.com/creator_42/followers',
    'https://x.com/creator_42/status/not-a-number',
    'https://x.com/creator_42/status/123/photo/1',
    'https://x.com/creator_42/status/123/more',
    'https://x.com/creator_42_extra',
  ];
  const profileRules = buildNavigationRules(origin, handle);
  const matching = (url: string) => profileRules.filter(rule => new RegExp(rule.condition.regexFilter ?? '', 'i').test(url)).sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1))[0];
  for (const url of allowed) {
    assert.equal(classifyUrl(url, handle).kind, 'x-profile', url);
    assert.equal(matching(url)?.action.type, 'allow', url);
    assert.equal(destinationForUrl(url, origin, handle), null);
  }
  for (const url of blocked) {
    assert.equal(classifyUrl(url, handle).kind, 'x-restricted', url);
    assert.equal(matching(url)?.action.type, 'redirect', url);
    assert.equal(destinationForUrl(url, origin, handle), 'https://x.com/creator_42');
  }
  assert.equal(destinationForUrl('https://twitter.com/other_creator', origin, handle), 'https://x.com/creator_42');
  assert.equal(buildNavigationRules(origin, 'home').find(rule => rule.id === 8), undefined);
});
test('exact attachment editor routes remain available without broader composer path exceptions', () => {
  for (const path of ['media', 'tags', 'alt']) {
    const url = `https://x.com/compose/post/${path}/?draft=1`;
    assert.equal(classifyUrl(url).kind, 'x-compose');
    assert.equal(ruleFor(url)?.action.type, 'allow');
  }
  assert.equal(classifyUrl('https://x.com/compose/post/media/extra').kind, 'x-restricted');
  assert.equal(ruleFor('https://x.com/compose/post/media/extra')?.action.type, 'redirect');
});
