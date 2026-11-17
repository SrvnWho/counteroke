import { useState } from 'react';
import type { SubmissionView } from '../../shared/types.ts';

function embedUrl(id: string, start: number, end: number, autoplay: boolean): string {
  const q = new URLSearchParams({
    start: String(Math.max(0, Math.floor(start))),
    end: String(Math.ceil(end)),
    rel: '0',
    playsinline: '1',
    modestbranding: '1',
  });
  if (autoplay) q.set('autoplay', '1');
  return `https://www.youtube-nocookie.com/embed/${id}?${q}`;
}

/**
 * A thumbnail that turns into the real YouTube player only when clicked. A page with many full
 * players is heavy for phones; a picture costs almost nothing.
 */
export function LiteYouTube({ id, start, end, title }: { id: string; start: number; end: number; title: string }) {
  const [on, setOn] = useState(false);
  if (on) {
    return (
      <iframe
        src={embedUrl(id, start, end, true)}
        title={title}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    );
  }
  return (
    <button type="button" className="lite-yt" onClick={() => setOn(true)} aria-label={`${title} videosunu oynat`}>
      <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" />
      <span className="lite-play" aria-hidden>
        ▶
      </span>
    </button>
  );
}

/**
 * The speech-removed clip can't tell how a line was originally said; this plays the original
 * YouTube video from the given clip time. YouTube serves it, so it costs the phone nothing.
 */
export function OriginalClip({ sub, at, label = '🔊 Orijinali dinle' }: { sub: SubmissionView; at: number; label?: string }) {
  const [from, setFrom] = useState<number | null>(null);
  if (from === null) {
    return (
      <button type="button" className="small" onClick={() => setFrom(Math.max(0, at - 0.5))} title="Orijinal sesiyle YouTube'dan oynatır">
        {label}
      </button>
    );
  }
  return (
    <div className="original-clip">
      <div className="row">
        <span className="tape small">Orijinal · {sub.title}</span>
        <button type="button" className="ghost small" onClick={() => setFrom(null)} aria-label="Orijinali kapat">
          ✕
        </button>
      </div>
      <iframe
        key={from}
        src={embedUrl(sub.youtubeId, sub.start + from, sub.end, true)}
        title="Orijinal video"
        allow="autoplay; encrypted-media"
      />
    </div>
  );
}
