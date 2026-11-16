// Values shared by the server and the web UI (used at runtime, not only as types).

export const EFFECTS = [
  { id: 'normal', label: 'Normal' },
  { id: 'kalin', label: 'Kalın ses' },
  { id: 'ince', label: 'İnce (helyum)' },
  { id: 'canavar', label: 'Canavar' },
  { id: 'robot', label: 'Robot' },
  { id: 'yasli', label: 'Yaşlı' },
  { id: 'radyo', label: 'Telsiz' },
  { id: 'yanki', label: 'Yankı' },
] as const;

export type EffectId = (typeof EFFECTS)[number]['id'];

export const EFFECT_IDS: readonly string[] = EFFECTS.map((e) => e.id);

/** Effects handed out to a player's 2nd, 3rd... character, in this order. */
export const EXTRA_CHARACTER_EFFECTS: readonly EffectId[] = ['kalin', 'ince', 'robot', 'canavar', 'yasli', 'radyo', 'yanki'];

export const MAX_SPEAKERS = 6;

export const CHARACTER_COLORS = ['#4fc3f7', '#ffb74d', '#ce93d8', '#81c784', '#f06292', '#fff176'];

export const PLAYER_COLORS = [
  '#ff6b6b', '#4ecdc4', '#ffd93d', '#a78bfa', '#6bcb77', '#ff8fab',
  '#4d96ff', '#ff9f43', '#00d2d3', '#c56cf0', '#f8a5c2', '#7bed9f',
];

export const PHASE_LABELS = {
  lobby: 'Kulis',
  submit: 'Video seçimi',
  vote: 'Oylama',
  processing: 'Stüdyo hazırlanıyor',
  script: 'Senaryo masası',
  casting: 'Rol dağıtımı',
  recording: 'Kayıt',
  mixing: 'Kurgu odası',
  screening: 'Gala',
  results: 'Ödül töreni',
} as const;

export const STAGE_LABELS: Record<string, string> = {
  queued: 'Sırada bekliyor',
  download: 'Video indiriliyor',
  separate: 'Konuşma sesi ayrılıyor',
  transcribe: 'Konuşmalar yazıya çevriliyor',
  diarize: 'Konuşmacılar ayrılıyor',
  finalize: 'Video hazırlanıyor',
  upload: 'Sunucuya yükleniyor',
  done: 'Hazır',
};
