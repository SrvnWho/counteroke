const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Pulls the 11-character video id out of the usual YouTube link shapes. */
export function parseYouTubeId(input: string): string | null {
  const raw = input.trim();
  if (ID_RE.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      id = m?.[1] ?? null;
    }
  }
  return id && ID_RE.test(id) ? id : null;
}

export function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Best-effort title lookup through YouTube's public oEmbed endpoint. */
export async function fetchTitle(id: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl(id))}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { title?: unknown };
    return typeof body.title === 'string' ? body.title : null;
  } catch {
    return null;
  }
}
