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

const ownProfile = '<nav id="nav">Navigation</nav><main data-testid="primaryColumn"><div data-testid="UserName">Ben @davis7</div><article data-testid="tweet"><button data-testid="caret">More</button></article></main>';
const postMenu = (action: 'pin' | 'unpin') => `<div role="menu" id="post-menu"><div role="menuitem">Delete</div><div role="menuitem" data-testid="${action}" id="pin-action">${action === 'pin' ? 'Pin to your profile' : 'Unpin from profile'}</div></div>`;
const pinSheet = (action: 'Pin' | 'Unpin') => `<div data-testid="confirmationSheetDialog" id="pin-sheet"><h1 role="heading">${action === 'Pin' ? 'Pin post to profile?' : 'Unpin post from profile?'}</h1><button data-testid="confirmationSheetConfirm" id="confirm">${action}</button><button data-testid="confirmationSheetCancel" id="cancel">Cancel</button></div>`;

test('own-post menus inserted outside the profile support pin/unpin and keyboard interaction', async () => {
  for (const action of ['pin', 'unpin'] as const) {
    const f = fixture(`${ownProfile}<div id="layers"></div>`, 'https://x.com/davis7');
    try {
      f.broadcast(true, 'davis7');
      f.document.querySelector('#layers')!.innerHTML = `${postMenu(action)}<div role="menu" id="other-menu"><div role="menuitem">Trending</div></div>`;
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(allowed(f.document.querySelector('#post-menu')));
      const unsupported = f.document.querySelector<HTMLElement>('#post-menu [role="menuitem"]')!;
      assert.ok(!allowed(unsupported));
      assert.equal(unsupported.inert, true);
      assert.ok(!allowed(f.document.querySelector('#other-menu')));
      assert.equal(f.document.querySelector<HTMLElement>('#other-menu')?.inert, true);
      for (const type of ['pointerdown', 'mousedown', 'click']) {
        const event = new f.dom.window.MouseEvent(type, { bubbles: true, cancelable: true });
        f.document.querySelector('#pin-action')!.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, type);
      }
      const key = new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      f.document.querySelector('#pin-action')!.dispatchEvent(key);
      assert.equal(key.defaultPrevented, false);
      f.document.querySelector('#post-menu')!.remove();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(f.document.querySelector<HTMLElement>('#layers')?.inert, true);
      assert.equal(f.document.querySelector<HTMLElement>('#nav')?.inert, true);
      f.broadcast(false);
      assert.equal(f.document.querySelector('[data-focus-allowed], [data-focus-denied], [data-focus-path]'), null);
      assert.ok(!f.document.querySelector<HTMLElement>('#layers')?.inert);
    } finally { f.cleanup(); }
  }
});

test('pin confirmations remain usable when X aria-hides the profile and restore it on cancel', async () => {
  for (const action of ['Pin', 'Unpin'] as const) {
    const f = fixture(ownProfile, 'https://x.com/davis7');
    try {
      f.broadcast(true, 'davis7');
      const primary = f.document.querySelector<HTMLElement>('[data-testid="primaryColumn"]')!;
      primary.setAttribute('aria-hidden', 'true');
      f.document.body.insertAdjacentHTML('beforeend', pinSheet(action));
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(allowed(f.document.querySelector('#pin-sheet')));
      assert.equal(primary.inert, true);
      for (const id of ['confirm', 'cancel']) {
        const click = new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
        f.document.querySelector(`#${id}`)!.dispatchEvent(click);
        assert.equal(click.defaultPrevented, false, id);
      }
      f.document.querySelector('#pin-sheet')!.remove();
      primary.removeAttribute('aria-hidden');
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(allowed(primary));
      assert.ok(!primary.inert);
    } finally { f.cleanup(); }
  }
});

test('unrelated menus and confirmations cannot borrow own-post pin recognition', () => {
  const unrelated = '<div role="menu" id="unrelated"><div role="menuitem">Delete</div><div role="menuitem">Pin to your profile</div></div>';
  const deletion = '<div data-testid="confirmationSheetDialog" id="delete"><h1 data-testid="confirmationSheetTitle">Delete post?</h1><button data-testid="confirmationSheetConfirm">Delete</button><button data-testid="confirmationSheetCancel">Cancel</button></div>';
  const f = fixture(`${ownProfile}${unrelated}${postMenu('pin')}${deletion}`, 'https://x.com/davis7');
  try {
    f.broadcast(true, 'davis7');
    assert.ok(allowed(f.document.querySelector('#post-menu')));
    for (const id of ['unrelated', 'delete']) {
      assert.ok(!allowed(f.document.querySelector(`#${id}`)));
      assert.equal(f.document.querySelector<HTMLElement>(`#${id}`)?.inert, true);
    }
  } finally { f.cleanup(); }
  const foreign = fixture(`${ownProfile}${postMenu('pin')}${pinSheet('Pin')}`, 'https://x.com/another');
  try {
    foreign.broadcast(true, 'davis7');
    assert.equal(foreign.document.querySelector('[data-focus-allowed]'), null);
  } finally { foreign.cleanup(); }
});


test('YouTube Music is never covered and playback is untouched by the content guard', () => {
  const dom = new JSDOM('<!doctype html><html><body><audio></audio><button id="play">Play</button></body></html>', { url: 'https://music.youtube.com/watch?v=abc', runScripts: 'outside-only' });
  try {
    const media = dom.window.document.querySelector('audio')!;
    let pauses = 0;
    media.pause = () => { pauses++; };
    // The allowed host must exit before accessing storage or installing listeners.
    dom.window.eval(script);
    media.dispatchEvent(new dom.window.Event('play', { bubbles: true }));
    assert.equal(pauses, 0);
    assert.equal(dom.window.document.querySelector('#focus-cover'), null);
    assert.equal(dom.window.document.documentElement.hasAttribute('data-focus-active'), false);
    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    dom.window.document.querySelector('#play')!.dispatchEvent(click);
    assert.equal(click.defaultPrevented, false);
  } finally { dom.window.close(); }
});
