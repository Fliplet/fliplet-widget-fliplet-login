/**
 * Coverage for safeAuthHost (DEV-1633).
 *
 * A missing authHost allowlist was one of the two blocking findings that
 * caused the original DEV-1572 revert, so the hostile inputs it has to reject
 * belong in the repo rather than in a throwaway harness.
 *
 * Run with: npm test   (node --test, no dependencies)
 */
const test = require('node:test');
const assert = require('node:assert');

const { safeAuthHost } = require('../js/safe-auth-host');

const PROD = 'https://api.fliplet.com';
const LOCAL = 'https://api.fliplet.test';

test('accepts the app\'s own API origin', () => {
  assert.strictEqual(safeAuthHost(PROD, PROD), PROD);
  assert.strictEqual(safeAuthHost(LOCAL, LOCAL), LOCAL);
  // Trailing slash: the parsed origin is returned, not the raw input.
  assert.strictEqual(safeAuthHost(PROD + '/', PROD), PROD);
});

test('accepts every production and staging regional API host', () => {
  const hosts = [
    'https://api.fliplet.com',
    'https://us.api.fliplet.com',
    'https://ca.api.fliplet.com',
    'https://staging.api.fliplet.com',
    'https://staging-us.api.fliplet.com'
  ];

  for (const host of hosts) {
    assert.strictEqual(safeAuthHost(host, PROD), host, host);
  }
});

test('accepts a future region without a code change', () => {
  assert.strictEqual(
    safeAuthHost('https://au.api.fliplet.com', PROD),
    'https://au.api.fliplet.com'
  );
});

test('rejects non-API fliplet.com hosts', () => {
  // These would all have passed a bare /(^|\.)fliplet\.com$/ test.
  const hosts = [
    'https://fliplet.com',
    'https://apps.fliplet.com',
    'https://us-apps.fliplet.com',
    'https://analytics.studio-apps.fliplet.com',
    'https://domains.studio-apps.fliplet.com',
    'https://xapi.fliplet.com'
  ];

  for (const host of hosts) {
    assert.strictEqual(safeAuthHost(host, PROD), null, host);
  }
});

test('rejects suffix and query-string spoofs', () => {
  const hosts = [
    'https://fliplet.com.evil.com',
    'https://api.fliplet.com.evil.com',
    'https://evil.com/?x=.fliplet.com',
    'https://evil.com/#api.fliplet.com',
    'https://evil.com/api.fliplet.com',
    'https://notfliplet.com',
    'https://api.fliplet.com.co',
    'https://user:pass@evil.com/'
  ];

  for (const host of hosts) {
    assert.strictEqual(safeAuthHost(host, PROD), null, host);
  }
});

test('rejects credential-bearing userinfo pointing at a valid host', () => {
  // The origin here is evil.com, not api.fliplet.com.
  assert.strictEqual(safeAuthHost('https://api.fliplet.com@evil.com/', PROD), null);
});

test('rejects non-https schemes in production', () => {
  const hosts = [
    'http://api.fliplet.com',
    'ftp://api.fliplet.com',
    'javascript:alert(1)//api.fliplet.com',
    'data:text/html,<script>1</script>'
  ];

  for (const host of hosts) {
    assert.strictEqual(safeAuthHost(host, PROD), null, host);
  }
});

test('accepts regional siblings of a non-fliplet.com app host', () => {
  // Dev environments and local stacks: us.api.fliplet.test alongside
  // api.fliplet.test. Rejecting these is what silently masked cross-region
  // bugs in the environments used to test for them.
  assert.strictEqual(
    safeAuthHost('https://us.api.fliplet.test', LOCAL),
    'https://us.api.fliplet.test'
  );
  assert.strictEqual(
    safeAuthHost('https://ca.api.fliplet.test', LOCAL),
    'https://ca.api.fliplet.test'
  );
});

test('sibling rule requires a full label boundary', () => {
  // "evilapi.fliplet.test" ends with "api.fliplet.test" as a raw substring but
  // is not a subdomain of it.
  assert.strictEqual(safeAuthHost('https://evilapi.fliplet.test', LOCAL), null);
  assert.strictEqual(safeAuthHost('https://xapi.fliplet.test', LOCAL), null);
});

test('sibling rule does not widen to the parent domain', () => {
  // A shorter or equal-length hostname must not pass the suffix check.
  assert.strictEqual(safeAuthHost('https://fliplet.test', LOCAL), null);
  assert.strictEqual(safeAuthHost('https://test', LOCAL), null);
});

test('sibling rule does not cross protocols', () => {
  assert.strictEqual(safeAuthHost('http://us.api.fliplet.test', LOCAL), null);
});

test('does not reduce to a registrable domain on a public suffix', () => {
  // An app on api.acme.co.uk must not end up trusting anything under co.uk.
  const appOrigin = 'https://api.acme.co.uk';

  assert.strictEqual(safeAuthHost('https://evil.co.uk', appOrigin), null);
  assert.strictEqual(safeAuthHost('https://acme.co.uk', appOrigin), null);
  // A genuine subdomain of the app's own host is still fine.
  assert.strictEqual(
    safeAuthHost('https://us.api.acme.co.uk', appOrigin),
    'https://us.api.acme.co.uk'
  );
});

test('rejects empty, malformed and non-string input', () => {
  const inputs = ['', null, undefined, 'not a url', '//api.fliplet.com', '/v1/session', {}, 42];

  for (const input of inputs) {
    assert.strictEqual(safeAuthHost(input, PROD), null, String(input));
  }
});

test('rejects everything when the app origin is missing', () => {
  // Without a trusted reference there is nothing to validate against, so the
  // caller must fall back rather than trust the query string.
  assert.strictEqual(safeAuthHost(PROD, ''), null);
  assert.strictEqual(safeAuthHost(PROD, undefined), null);
});
