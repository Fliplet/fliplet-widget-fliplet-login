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
    // eslint-disable-next-line no-script-url -- the hostile input under test; asserting safeAuthHost rejects it is the whole point
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

// Named for what it actually guards. Two independent rules are involved: the
// CDN exclusion lives on the production regional rule (cdn is a single label,
// so the sibling rule never even sees it), while the depth limit comes from
// the sibling rule being disabled on fliplet.com. Either one alone leaves a
// hole, so both are asserted together.
test('production allowlist excludes CDN origins and arbitrary subdomain depth', () => {
  // The CDN hosts in config/production.json are genuine subdomains of
  // api.fliplet.com, and cdn.api.fliplet.com is a SINGLE label under it —
  // structurally identical to a region — so it passes the regional-host rule
  // unless explicitly excluded. A bare suffix check would hand all of them the
  // Authorization header, undoing the narrowness of that rule.
  const cdnHosts = [
    'https://cdn.api.fliplet.com',
    'https://cdn-staging.api.fliplet.com',
    'https://us.cdn.api.fliplet.com',
    'https://ca.cdn.api.fliplet.com'
  ];

  for (const host of cdnHosts) {
    assert.strictEqual(safeAuthHost(host, PROD), null, host);
    // Also when the app is itself on a regional host.
    assert.strictEqual(safeAuthHost(host, 'https://us.api.fliplet.com'), null, host);
  }

  // Depth is what the exclusion is about, NOT label content. An arbitrary
  // single label is accepted by design so a new region works without a code
  // change — asserted explicitly here so nobody "tightens" it by mistake.
  // These two are deliberately separate assertions rather than a loop: they
  // have opposite expected values.
  assert.strictEqual(
    safeAuthHost('https://anything.api.fliplet.com', PROD),
    'https://anything.api.fliplet.com'
  );
  assert.strictEqual(safeAuthHost('https://a.b.c.api.fliplet.com', PROD), null);

  // The real API hosts must all survive the exclusion.
  for (const host of ['https://staging.api.fliplet.com', 'https://staging-us.api.fliplet.com', 'https://development.api.fliplet.com']) {
    assert.strictEqual(safeAuthHost(host, PROD), host, host);
  }
});

test('sibling rule permits exactly one label off production', () => {
  assert.strictEqual(
    safeAuthHost('https://us.api.fliplet.test', LOCAL),
    'https://us.api.fliplet.test'
  );
  // Deeper nesting must not walk down arbitrary subdomains.
  assert.strictEqual(safeAuthHost('https://a.b.api.fliplet.test', LOCAL), null);
  assert.strictEqual(safeAuthHost('https://cdn.us.api.fliplet.test', LOCAL), null);
});

test('rejects a non-matching port on every branch', () => {
  // The rules match on hostname (port-free) but the function returns origin
  // (port-bearing), so the port needs its own check.
  assert.strictEqual(safeAuthHost('https://api.fliplet.com:31337', PROD), null);
  assert.strictEqual(safeAuthHost('https://us.api.fliplet.com:8443', PROD), null);
  assert.strictEqual(safeAuthHost('https://us.api.fliplet.test:9443', LOCAL), null);
  // An explicit default port is normalised away by URL, so it still matches.
  assert.strictEqual(safeAuthHost('https://us.api.fliplet.com:443', PROD), 'https://us.api.fliplet.com');
});

test('rejects trailing-dot FQDNs', () => {
  // Resolves to the same host but is a distinct origin; easy to loosen by
  // accident in a refactor.
  assert.strictEqual(safeAuthHost('https://us.api.fliplet.com.', PROD), null);
  assert.strictEqual(safeAuthHost('https://api.fliplet.com.', PROD), null);
  assert.strictEqual(safeAuthHost('https://us.api.fliplet.test.', LOCAL), null);
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
