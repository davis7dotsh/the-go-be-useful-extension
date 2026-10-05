import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = await build({ entryPoints: ['src/content/guard.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' }, platform: 'browser' });
const script = bundle.outputFiles[0]!.text;
const active = { version: 1, enabled: true, endsAt: null };
const inactive = { version: 1, enabled: false, endsAt: null };
const composer = `<div role="dialog" id="composer"><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Preserve this draft</div><input data-testid="fileInput" type="file"><button data-testid="tweetButton">Post</button><a href="/someone" id="foreign">Someone</a></div>`;

type Listener = (message: unknown, sender: { id: string }, respond: (value: unknown) => void) => boolean;
function fixture(body: string, url = 'https://x.com/compose/post') {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  let listener: Listener | null = null;
  const chromeMock = {
    runtime: { id: 'focus-test', getURL: (path: string) => `chrome-extension://focus-test/${path}`, sendMessage: () => new Promise<unknown>(() => {}), onMessage: { addListener(callback: Listener) { listener = callback; } } },
    storage: { local: { get: () => new Promise<Record<string, unknown>>(() => {}) }, onChanged: { addListener() {} } },
  };
  Object.defineProperty(dom.window, 'chrome', { value: chromeMock });
  dom.window.eval(script);
  const broadcast = (enabled = true, profileHandle: string | null = null) => {
    let response: unknown;
    assert.ok(listener);
    listener({ type: 'focus:state', state: enabled ? active : inactive, profileHandle }, { id: 'focus-test' }, value => { response = structuredClone(value); });
    return response;
  };
  const cleanup = () => { broadcast(false); dom.window.close(); };
  return { dom, document: dom.window.document, broadcast, cleanup };
}

function allowed(node: Element | null) {
  return !!node?.closest('[data-focus-allowed]') && !node.closest('[data-focus-denied]');
}

test('document-start guard covers page before asynchronous state lookup', () => {
  const f = fixture('<main>Feed</main>');
  try {
    assert.ok(f.document.documentElement.hasAttribute('data-focus-active'));
    assert.equal(f.document.querySelector('#focus-cover')?.getAttribute('data-phase'), 'loading');
  } finally { f.cleanup(); }
});

test('recognized composer acknowledges draft without replacing editor and isolates background', () => {
  const f = fixture(`<nav id="navigation"><button>Home</button></nav>${composer}`, 'https://x.com/home');
  try {
    const editor = f.document.querySelector('[contenteditable]');
    assert.deepEqual(f.broadcast(), { ok: true, guarded: true, hasComposer: true });
    assert.equal(f.document.querySelector('[contenteditable]'), editor);
    assert.equal(editor?.textContent, 'Preserve this draft');
    assert.ok(allowed(editor));
    assert.equal(f.document.querySelector<HTMLElement>('#navigation')?.inert, true);
    const foreign = f.document.querySelector('#foreign')!;
    const click = new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    foreign.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    f.broadcast(false);
    assert.equal(f.document.querySelector('[contenteditable]'), editor);
    assert.equal(f.document.querySelector('#focus-cover'), null);
    assert.equal(f.document.querySelectorAll('[data-focus-allowed], [data-focus-path], [data-focus-denied]').length, 0);
    assert.ok(!f.document.querySelector<HTMLElement>('#navigation')?.inert);
    const unrestricted = new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    foreign.dispatchEvent(unrestricted);
    assert.equal(unrestricted.defaultPrevented, false, 'captured handlers must be removed on stop');
  } finally { f.cleanup(); }
});

test('composer dismissal becomes a neutral covered screen', async () => {
  const f = fixture(composer);
  try {
    f.broadcast();
    f.document.querySelector('#composer')!.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.document.querySelector('#focus-cover')?.getAttribute('data-phase'), 'restricted');
    assert.equal(f.document.querySelector('#focus-cover button')?.textContent, 'Compose another');
    assert.equal(f.document.querySelector('[data-focus-allowed]'), null);
  } finally { f.cleanup(); }
});

test('initial media editor remains usable and counts as an existing composer', () => {
  const f = fixture('<div role="dialog" id="media"><h1>Crop media</h1><div role="slider"></div><button data-testid="endEditingButton">Save</button></div><div role="dialog" id="other">Unrelated modal</div>', 'https://x.com/compose/post/media');
  try {
    assert.deepEqual(f.broadcast(), { ok: true, guarded: true, hasComposer: true });
    assert.ok(allowed(f.document.querySelector('#media')));
    assert.ok(!allowed(f.document.querySelector('#other')));
    assert.equal(f.document.querySelector<HTMLElement>('#other')?.inert, true);
  } finally { f.cleanup(); }
});

test('own profile reveals primary column while denying discovery and external links', () => {
  const f = fixture('<nav id="nav">Feed navigation</nav><main data-testid="primaryColumn"><div data-testid="UserName">Ben @davis7</div><a href="/davis7/status/123" id="own">Own post</a><a href="/another/status/456" id="foreign">Other post</a><aside id="trends">Trends</aside><div data-testid="cellInnerDiv" id="recommendation-row"><span>Suggested account</span><div data-testid="UserCell" id="recommendation">Account controls</div></div><div data-testid="cellInnerDiv" id="recommendation-heading"><h2>Who to follow</h2><span>Discovery content</span></div><button role="tab">Posts</button><button role="tab" id="likes">Likes</button></main>', 'https://x.com/davis7');
  try {
    f.broadcast(true, 'davis7');
    assert.ok(allowed(f.document.querySelector('#own')));
    for (const id of ['trends', 'recommendation-row', 'recommendation-heading', 'likes']) {
      assert.ok(!allowed(f.document.querySelector(`#${id}`)), id);
      assert.equal(f.document.querySelector<HTMLElement>(`#${id}`)?.inert, true, id);
    }
    assert.equal(f.document.querySelector<HTMLElement>('#nav')?.inert, true);
    const click = new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    f.document.querySelector('#foreign')!.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
  } finally { f.cleanup(); }
});

test('unrecognized composer layout stays covered instead of revealing a generic modal', () => {
  const f = fixture('<div role="dialog"><h1>Unexpected layout</h1><button>Browse</button></div>');
  try {
    assert.deepEqual(f.broadcast(), { ok: true, guarded: true, hasComposer: false });
    assert.equal(f.document.querySelector('[data-focus-allowed]'), null);
    assert.equal(f.document.body.inert, true);
  } finally { f.cleanup(); }
});

test('profile recognition rejects handle prefixes and stale own tweets from a previous feed', () => {
  for (const markup of [
    '<div data-testid="UserName">Someone @davis70</div>',
    '<article data-testid="tweet"><div data-testid="User-Name">Ben @davis7</div><a href="/davis7/status/123">Old feed post</a></article>',
  ]) {
    const f = fixture(`<main data-testid="primaryColumn">${markup}</main>`, 'https://x.com/davis7');
    try {
      f.broadcast(true, 'davis7');
      assert.equal(f.document.querySelector('[data-focus-allowed]'), null);
      assert.equal(f.document.querySelector('#focus-cover')?.getAttribute('data-phase'), 'restricted');
    } finally { f.cleanup(); }
  }
});

test('attachment choice reveals only Upload, hiding Grok and unrelated menus', () => {
  const f = fixture(`${composer}<div role="menu" id="attachment"><button id="upload">Upload</button><button id="grok">Generate with Grok</button></div><div role="menu" id="unknown"><button id="unknown-upload">Upload</button><button>Browse</button></div>`);
  try {
    f.broadcast();
    assert.ok(allowed(f.document.querySelector('#upload')));
    assert.ok(!allowed(f.document.querySelector('#grok')));
    assert.equal(f.document.querySelector<HTMLElement>('#grok')?.inert, true);
    assert.ok(!allowed(f.document.querySelector('#unknown-upload')), 'an unrelated Upload menu must not inherit recognition from the attachment choice');
    assert.equal(f.document.querySelector<HTMLElement>('#unknown')?.inert, true);
    const click = new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    f.document.querySelector('#upload')!.dispatchEvent(click);
    assert.equal(click.defaultPrevented, false);
  } finally { f.cleanup(); }
});

test('inline drafts stay intact in their smallest safe subtree while overbroad feed wrappers stay covered', () => {
  const editorMarkup = '<div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Existing inline draft</div>';
  const controls = '<input data-testid="fileInput" type="file"><button data-testid="tweetButtonInline">Post</button>';
  const f = fixture(`<nav id="nav">Navigation</nav><main data-testid="primaryColumn"><section id="inline"><div>${editorMarkup}</div>${controls}</section><article data-testid="tweet" id="feed">Feed post</article></main>`, 'https://x.com/home');
  try {
    const editor = f.document.querySelector('[contenteditable]');
    assert.deepEqual(f.broadcast(), { ok: true, guarded: true, hasComposer: true });
    assert.equal(f.document.querySelector('[contenteditable]'), editor);
    assert.equal(editor?.textContent, 'Existing inline draft');
    assert.equal(editor?.closest('[data-focus-allowed]')?.id, 'inline');
    assert.ok(!allowed(f.document.querySelector('#feed')));
    assert.equal(f.document.querySelector<HTMLElement>('#feed')?.inert, true);
    assert.equal(f.document.querySelector<HTMLElement>('#nav')?.inert, true);
    f.broadcast(false);
    assert.equal(f.document.querySelector('[contenteditable]'), editor);
    assert.equal(f.document.querySelector('#focus-cover'), null);
    assert.equal(f.document.querySelector('[data-focus-allowed]'), null);
    assert.ok(!f.document.querySelector<HTMLElement>('#feed')?.inert);
  } finally { f.cleanup(); }
  for (const unsafe of [
    `<div>${editorMarkup}${controls}<article data-testid="tweet">Feed post</article></div>`,
    `<main data-testid="primaryColumn">${editorMarkup}${controls}</main>`,
  ]) {
    const denied = fixture(unsafe, 'https://x.com/home');
    try {
      assert.deepEqual(denied.broadcast(), { ok: true, guarded: true, hasComposer: false });
      assert.equal(denied.document.querySelector('[data-focus-allowed]'), null);
      assert.equal(denied.document.querySelector('#focus-cover')?.getAttribute('data-phase'), 'restricted');
    } finally { denied.cleanup(); }
  }
});
