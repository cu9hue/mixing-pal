import { z } from "zod";
import { Env, json } from "./env";

const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const artifact = z.object({ key: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() });
const releaseSchema = z.object({
  version, notes: z.string().max(8000), pub_date: z.iso.datetime({ offset: true }),
  wire_version: z.number().int().nonnegative(), commit: z.string().regex(/^[a-f0-9]{40}$/),
  installer: artifact, updater: artifact.extend({ signature: z.string().min(1) }),
}).refine((release) => release.installer.key === `releases/${release.version}/Mixing-Pal.dmg`
  && release.updater.key === `releases/${release.version}/Mixing-Pal.app.tar.gz`);
const channelSchema = z.object({ paused: z.boolean(), release: releaseSchema.nullable() });

function unavailable(message = "This download is currently unavailable."): Response {
  return json({ error: { code: "release_unavailable", message } }, 503);
}

export async function releaseRequest(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/v1/updates/") && !path.startsWith("/v1/downloads/")) return null;
  const update = /^\/v1\/updates\/(pilot|stable)$/.exec(path);
  const download = /^\/v1\/downloads\/(pilot|stable)\/macos$/.exec(path);
  if (!update && !download) return json({ error: { code: "not_found", message: "Not found." } }, 404);
  if (request.method !== "GET") return json({ error: { code: "method_not_allowed", message: "Use GET." } }, 405);
  if (!env.RELEASES || !env.DOWNLOADS_ORIGIN) return unavailable();
  try {
    const object = await env.RELEASES.get(`channels/${(update ?? download)![1]}.json`);
    if (!object || object.size > 32 * 1024) return unavailable();
    const manifest = channelSchema.safeParse(JSON.parse(await object.text()));
    if (!manifest.success) return unavailable();
    if (manifest.data.paused || !manifest.data.release) {
      return update ? new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }) : unavailable();
    }
    const release = manifest.data.release;
    const origin = new URL(env.DOWNLOADS_ORIGIN);
    if (origin.protocol !== "https:" && origin.hostname !== "localhost") return unavailable();
    const url = (key: string) => new URL(`/${key}`, origin).toString();
    if (download) return new Response(null, { status: 302, headers: { Location: url(release.installer.key), "Cache-Control": "no-store" } });
    const platform = { url: url(release.updater.key), signature: release.updater.signature };
    return json({ version: release.version, notes: release.notes, pub_date: release.pub_date,
      platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform } });
  } catch {
    return unavailable();
  }
}
