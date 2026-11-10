/**
 * Coverage for the account setup in-app browser in js/app.js (PS-2415).
 *
 * The setup-complete page closes itself with window.close(), which the
 * Android in-app browser ignores, so the user had to press Back through
 * Studio's setup pages. The widget now closes the browser itself when that
 * page loads.
 *
 * js/app.js is a browser script, so it is loaded in a VM context with a
 * stubbed Fliplet global.
 *
 * Run with: npm test   (node --test, no dependencies)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const API_URL = 'https://api.fliplet.test/';

// The few lodash helpers js/app.js uses
const _ = {
  get(obj, keyPath, fallback) {
    const value = keyPath.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);

    return value === undefined ? fallback : value;
  },
  set(obj, key, value) {
    obj[key] = value;

    return obj;
  },
  keys: (obj) => Object.keys(obj || {}),
  find: (list, fn) => (list || []).find(typeof fn === 'function' ? fn : () => false),
  isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b)
};

function load({ stateToken = 'state-1' } = {}) {
  const opened = [];
  const userResponse = { user: { id: 1, userRoleId: 2 }, mustChangePassword: false };

  const Fliplet = {
    Env: { get: (key) => ({ apiUrl: API_URL })[key] },
    Storage: { get: () => Promise.resolve(null) },
    App: {
      Storage: {
        get: () => Promise.resolve({ auth_token: 'app-token' }),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve()
      }
    },
    API: {
      request(options) {
        if (options.url === 'v1/session/authorize/state') {
          return stateToken ? Promise.resolve({ state: stateToken }) : Promise.reject(new Error('no state'));
        }

        if (options.url === 'v1/organizations') {
          return Promise.resolve({ organizations: [] });
        }

        return Promise.resolve(userResponse);
      }
    },
    Navigate: {
      defaults: { disableShare: false },
      url(options) {
        const browser = {
          closed: 0,
          close() {
            this.closed++;
          }
        };

        opened.push({ options, browser });

        return Promise.resolve(browser);
      }
    },
    Cache: { get: () => {}, remove: () => {}, set: () => {} },
    Hooks: { on: () => {}, run: () => Promise.resolve() },
    Profile: { set: () => Promise.resolve(), remove: () => Promise.resolve() },
    Session: { logout: () => Promise.resolve() }
  };

  const context = {
    window: { Fliplet },
    Fliplet,
    _,
    URL,
    Promise,
    T: (key) => key,
    console: { warn() {}, error() {}, log() {} }
  };

  vm.runInNewContext(source, context);

  return { Login: Fliplet.Login, opened, Fliplet };
}

// Lets the promise chain inside js/app.js reach Navigate.url
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function openSetup(loaded) {
  const done = loaded.Login.validateAccount({
    data: { user: { id: 1, userRoleId: 2 }, mustChangePassword: true }
  });

  await tick();
  assert.strictEqual(loaded.opened.length, 1, 'setup browser opened once');

  return { done, ...loaded.opened[0] };
}

test('closes the setup browser when the setup-complete page loads', async() => {
  const loaded = load();
  const { done, options, browser } = await openSetup(loaded);

  assert.match(options.url, /v1\/auth\/redirect\?state=state-1&utm_source=com\.fliplet\.login$/);

  options.onLoadStop({ url: API_URL + 'v1/auth/redirect?state=state-1' });
  options.onLoadStop({ url: 'https://studio.fliplet.test/account/setup?utm_source=com.fliplet.login' });
  options.onLoadStop({ url: 'https://studio.fliplet.test/account/setup/completed' });
  assert.strictEqual(browser.closed, 0, 'stays open on the setup pages');

  options.onLoadStop({ url: API_URL + 'v1/auth/interactive-logout?utm_source=com.fliplet.login' });
  assert.strictEqual(browser.closed, 1, 'closed on the setup-complete page');

  // Cordova fires exit once the browser is gone
  options.onclose();
  await done;
  assert.strictEqual(loaded.opened.length, 1, 'setup is not opened again when nothing is pending');
  assert.strictEqual(loaded.Fliplet.Navigate.defaults.disableShare, false, 'share setting restored');
});

test('does not close for look-alike URLs', async() => {
  const { options, browser } = await openSetup(load());

  [
    API_URL + 'v1/auth/interactive-logout-other',
    API_URL + 'v1/auth/redirect?next=/v1/auth/interactive-logout',
    'not a url',
    undefined
  ].forEach((url) => options.onLoadStop({ url }));
  options.onLoadStop();

  assert.strictEqual(browser.closed, 0);
});

test('closes the browser on the auth_token fallback too', async() => {
  const { options, browser } = await openSetup(load({ stateToken: null }));

  assert.match(options.url, /v1\/auth\/redirect\?auth_token=app-token&utm_source=com\.fliplet\.login$/);

  options.onLoadStop({ url: API_URL + 'v1/auth/interactive-logout' });
  assert.strictEqual(browser.closed, 1);
});
