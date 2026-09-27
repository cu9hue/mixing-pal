import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishRelease, selectChannel, pauseChannel, r2Store, verifyDistributedArtifacts } from './publish-release.mjs';

const version = '0.3.0';
const files = {
  'Mixing-Pal.dmg': Buffer.from('dmg'),
  'Mixing-Pal.app.tar.gz': Buffer.from('archive'),
  'Mixing-Pal.app.tar.gz.sig': Buffer.from('c2lnbmF0dXJl'.repeat(6)),
};
const options = { version, tag: 'v0.3.0', commit: 'a'.repeat(40), notes: 'Notes', wireVersion: 12, pubDate: '2026-09-18T12:00:00Z' };
function harness(overrides = {}) {
  const uploaded = [];
  const stored = new Map(overrides.stored ?? []);
  return {
    uploaded, stored,
    io: {
      readFile: async name => {
        if (!(name in files)) throw new Error('missing artifact');
        return files[name];
      },
      verify: async () => { if (overrides.invalid) throw new Error('bad signature'); },
      get: async key => stored.get(key) ?? null,
      put: async (key, bytes) => {
        if (overrides.failUpload === key) throw new Error('upload failed');
        uploaded.push(key); stored.set(key, bytes);
      },
    },
  };
}

test('tag and version must agree before upload', async () => {
  const h = harness();
  await assert.rejects(publishRelease({ ...options, tag: 'v0.3.1' }, h.io), /tag/i);
  assert.deepEqual(h.uploaded, []);
});
test('missing artifact or failed verification prevents uploads', async () => {
  const missing = harness();
  delete files['Mixing-Pal.dmg'];
  await assert.rejects(publishRelease(options, missing.io), /missing artifact/);
  files['Mixing-Pal.dmg'] = Buffer.from('dmg');
  assert.deepEqual(missing.uploaded, []);
  const invalid = harness({ invalid: true });
  await assert.rejects(publishRelease(options, invalid.io), /bad signature/);
  assert.deepEqual(invalid.uploaded, []);
});
test('release metadata is last and upload failure leaves it absent', async () => {
  const key = `releases/${version}/Mixing-Pal.app.tar.gz`;
  const h = harness({ failUpload: key });
  await assert.rejects(publishRelease(options, h.io), /upload failed/);
  assert.equal(h.stored.has(`releases/${version}/release.json`), false);
  const good = harness();
  await publishRelease(options, good.io);
  assert.equal(good.uploaded.at(-1), `releases/${version}/release.json`);
});
test('duplicate release and changed bytes refuse publication', async () => {
  const h = harness();
  await publishRelease(options, h.io);
  const count = h.uploaded.length;
  await assert.rejects(publishRelease(options, h.io), /already published/);
  assert.equal(h.uploaded.length, count);
  const partial = harness({ stored: [[`releases/${version}/Mixing-Pal.dmg`, Buffer.from('changed')]] });
  await assert.rejects(publishRelease(options, partial.io), /different content/);
  assert.deepEqual(partial.uploaded, []);
});
test('channel selection and pause retain the complete release', async () => {
  const h = harness();
  const release = await publishRelease(options, h.io);
  assert.deepEqual(selectChannel(release), { paused: false, release });
  assert.deepEqual(pauseChannel({ paused: false, release }), { paused: true, release });
});
test('R2 upload sends the object in Cloudflare body form field', async () => {
  let uploaded;
  const store = r2Store({ stage: 'staging', accountId: 'a'.repeat(32), token: 'test', fetchImpl: async (url, request) => {
    uploaded = { url, request };
    return new Response('{}', { status: 200 });
  } });
  await store.put('channels/pilot.json', Buffer.from('test'), 'application/json', 'no-store');
  assert.match(uploaded.url, /mixing-pal-staging-releases\/objects\/channels\/pilot.json$/);
  assert.equal((await uploaded.request.body.get('body').text()), 'test');
});
test('DMG app version mismatch aborts publication and detaches image', async () => {
  const commands = [];
  const expected = { directory: '/fake/release', publicKey: 'cHVibGlj', version, identifier: 'com.mixingpal.app', team: 'ABC1234567', identity: 'Developer ID Application: Example (ABC1234567)' };
  const run = async (command, args) => {
    commands.push([command, args]);
    if (command === 'plutil') {
      const field = args[1];
      if (field === 'CFBundleIdentifier') return { stdout: expected.identifier };
      if (field === 'CFBundleShortVersionString') return { stdout: args.at(-1).includes('/mount/') ? '0.3.1' : version };
    }
    if (command === 'codesign' && args[0] === '-dv') return { stderr: `Authority=${expected.identity}\nTeamIdentifier=${expected.team}\n` };
    return { stdout: '', stderr: '' };
  };
  const h = harness();
  h.io.verify = () => verifyDistributedArtifacts(expected, { run, readFile: async () => Buffer.from('c2lnbmF0dXJl'.repeat(6)) });
  await assert.rejects(publishRelease(options, h.io), /bundle version mismatch/);
  assert.deepEqual(h.uploaded, []);
  assert.ok(commands.some(([command, args]) => command === 'hdiutil' && args[0] === 'detach'));
  assert.ok(commands.some(([command, args]) => command === 'minisign' && args.includes('-Vm')));
});
