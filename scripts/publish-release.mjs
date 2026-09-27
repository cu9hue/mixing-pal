import { createHash } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const names = ['Mixing-Pal.dmg', 'Mixing-Pal.app.tar.gz', 'Mixing-Pal.app.tar.gz.sig'];
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const releaseKey = version => `releases/${version}/release.json`;

export function validateRelease(release) {
  if (!release || !versionPattern.test(release.version) || typeof release.notes !== 'string' || release.notes.length > 8000 ||
      !Number.isInteger(release.wire_version) || release.wire_version < 1 ||
      !/^[a-f0-9]{40}$/.test(release.commit) || Number.isNaN(Date.parse(release.pub_date))) throw new Error('Invalid release metadata');
  const prefix = `releases/${release.version}/`;
  for (const [item, name] of [[release.installer, names[0]], [release.updater, names[1]]]) {
    if (!item || item.key !== prefix + name || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) throw new Error('Invalid release artifact');
  }
  if (typeof release.updater.signature !== 'string' || release.updater.signature.length < 40) throw new Error('Invalid updater signature');
  return release;
}

export function selectChannel(release) { return { paused: false, release: validateRelease(release) }; }
export function pauseChannel(channel) {
  if (!channel || typeof channel.paused !== 'boolean' || (channel.release !== null && channel.release !== undefined && !validateRelease(channel.release))) throw new Error('Invalid channel');
  return { paused: true, release: channel.release ?? null };
}

export async function publishRelease({ version, tag, commit, notes, wireVersion, pubDate }, io) {
  if (!versionPattern.test(version) || tag !== `v${version}`) throw new Error('Tag and version disagree');
  if (typeof notes !== 'string' || notes.length > 8000 || !Number.isInteger(wireVersion) || wireVersion < 1 || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release inputs');
  const base = `releases/${version}/`;
  if (await io.get(releaseKey(version))) throw new Error('Version already published');
  const files = new Map();
  for (const name of names) files.set(name, await io.readFile(name));
  await io.verify(files);
  const release = validateRelease({
    version, notes, pub_date: pubDate, wire_version: wireVersion, commit,
    installer: { key: base + names[0], sha256: digest(files.get(names[0])), bytes: files.get(names[0]).length },
    updater: { key: base + names[1], sha256: digest(files.get(names[1])), bytes: files.get(names[1]).length, signature: files.get(names[2]).toString('utf8').trim() },
  });
  for (const name of names) {
    const existing = await io.get(base + name);
    if (existing && !existing.equals(files.get(name))) throw new Error(`Existing ${name} has different content`);
  }
  for (const name of names) {
    const key = base + name;
    if (!(await io.get(key))) await io.put(key, files.get(name), name.endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/octet-stream', 'public, max-age=31536000, immutable');
  }
  await io.put(releaseKey(version), Buffer.from(JSON.stringify(release)), 'application/json', 'public, max-age=31536000, immutable');
  return release;
}

export async function verifyDistributedArtifacts({ directory, publicKey, version, identifier, team, identity }, { run = exec, readFile: read = readFile } = {}) {
  if (!versionPattern.test(version) || !identifier || !/^[A-Z0-9]{10}$/.test(team ?? '') || !identity?.startsWith('Developer ID Application: ')) throw new Error('Expected Apple release identity missing');
  const work = await mkdtemp(join(tmpdir(), 'mixing-pal-release-'));
  const mount = join(work, 'mount');
  let mounted = false;
  try {
    const dmg = join(directory, names[0]);
    const archive = join(directory, names[1]);
    const signature = Buffer.from((await read(join(directory, names[2]))).toString('utf8').trim(), 'base64');
    const key = Buffer.from(publicKey, 'base64');
    if (!signature.length || !key.length) throw new Error('Invalid updater public key or signature');
    const sigPath = join(work, 'update.minisig');
    const keyPath = join(work, 'update.pub');
    await writeFile(sigPath, signature, { mode: 0o600 });
    await writeFile(keyPath, key, { mode: 0o600 });
    await run('minisign', ['-Vm', archive, '-x', sigPath, '-p', keyPath]);
    await run('codesign', ['--verify', '--verbose=2', dmg]);
    await run('xcrun', ['stapler', 'validate', dmg]);
    await run('hdiutil', ['verify', dmg]);
    const extracted = join(work, 'archive');
    await mkdir(extracted);
    await run('tar', ['-xzf', archive, '-C', extracted]);
    await mkdir(mount);
    await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    mounted = true;
    for (const app of [join(extracted, 'Mixing Pal.app'), join(mount, 'Mixing Pal.app')]) {
      const actualIdentifier = (await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')])).stdout.trim();
      const actualVersion = (await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')])).stdout.trim();
      if (actualIdentifier !== identifier) throw new Error(`Distributed app bundle identifier mismatch: ${app}`);
      if (actualVersion !== version) throw new Error(`Distributed app bundle version mismatch: ${app}`);
      await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
      const details = await run('codesign', ['-dv', '--verbose=4', app]);
      const signing = `${details.stdout ?? ''}\n${details.stderr ?? ''}`;
      if (!signing.split('\n').includes(`TeamIdentifier=${team}`) || !signing.split('\n').includes(`Authority=${identity}`)) throw new Error(`Distributed app signing identity mismatch: ${app}`);
      await run('spctl', ['--assess', '--type', 'execute', app]);
    }
  } finally {
    try { if (mounted) await run('hdiutil', ['detach', mount]); }
    finally { await rm(work, { recursive: true, force: true }); }
  }
}

export function bucketForStage(stage) {
  if (stage === 'production') return 'mixing-pal-production-releases';
  if (stage === 'staging') return 'mixing-pal-staging-releases';
  throw new Error('Invalid stage');
}

export function r2Store({ stage, accountId, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? '') || !token) throw new Error('Cloudflare credentials missing');
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketForStage(stage)}/objects/`;
  async function request(method, key, body, type, cacheControl) {
    if (!/^(?:releases\/[0-9A-Za-z.-]+\/[A-Za-z0-9.-]+|channels\/(?:pilot|stable)\.json)$/.test(key)) throw new Error('Invalid R2 key');
    if (method === 'PUT' && body.length > 300_000_000) throw new Error('R2 REST object exceeds 300 MB upload limit');
    const response = await fetchImpl(base + key, { method, headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'PUT' ? { 'Content-Type': type ?? 'application/octet-stream', 'Content-Length': String(body.length) } : {}),
      ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
    }, body });
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 ${method} ${key} failed: ${response.status}`);
    return method === 'GET' ? Buffer.from(await response.arrayBuffer()) : null;
  }
  async function put(key, bytes, type, cacheControl) {
    if (cacheControl !== 'public, max-age=31536000, immutable') return request('PUT', key, bytes, type, cacheControl);
    if (!/^releases\/[0-9A-Za-z.-]+\/[A-Za-z0-9.-]+$/.test(key)) throw new Error('Invalid immutable R2 key');
    const work = await mkdtemp(join(tmpdir(), 'mixing-pal-r2-'));
    try {
      const file = join(work, 'object');
      await writeFile(file, bytes, { mode: 0o600 });
      await exec('proxy/node_modules/.bin/wrangler', ['r2', 'object', 'put', `${bucketForStage(stage)}/${key}`, '--file', file, '--remote', '--force', '--content-type', type, '--cache-control', cacheControl], {
        env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId },
      });
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  return { get: key => request('GET', key), put };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const directory = process.env.RELEASE_DIR;
  const baseConfig = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  const override = JSON.parse(await readFile(process.env.RELEASE_TAURI_CONFIG, 'utf8'));
  const config = { ...baseConfig, ...override, bundle: { ...baseConfig.bundle, ...override.bundle }, plugins: { ...baseConfig.plugins, ...override.plugins } };
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const cargo = /^version = "([^"]+)"$/m.exec(await readFile('src-tauri/Cargo.toml', 'utf8'))?.[1];
  const version = config.version;
  if (!directory || pkg.version !== version || cargo !== version) throw new Error('Package, Cargo and Tauri versions disagree');
  const publicKey = config.plugins?.updater?.pubkey;
  if (!publicKey || !config.bundle?.createUpdaterArtifacts || !/^Developer ID Application: /.test(process.env.APPLE_SIGNING_IDENTITY ?? '') || !/^[A-Z0-9]{10}$/.test(process.env.APPLE_TEAM_ID ?? '')) throw new Error('Production signing is not configured');
  const store = r2Store({ stage: process.env.RELEASE_STAGE, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
  await publishRelease({ version, tag: process.env.RELEASE_TAG, commit: process.env.GITHUB_SHA, notes: await readFile(process.env.RELEASE_NOTES_FILE, 'utf8'), wireVersion: JSON.parse(await readFile('shared/wire-version.json', 'utf8')).version, pubDate: new Date().toISOString() }, {
    ...store,
    readFile: name => readFile(join(directory, name)),
    verify: () => verifyDistributedArtifacts({ directory, publicKey, version, identifier: config.identifier, team: process.env.APPLE_TEAM_ID, identity: process.env.APPLE_SIGNING_IDENTITY }),
  });
}
