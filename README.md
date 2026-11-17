# counteroke 🎙️

Arkadaşlarla tarayıcıda oynanan bir seslendirme (dublaj) parti oyunu.

1. Herkes bir YouTube linki önerir, başlangıç/bitiş saniyesini, kaç kişinin konuştuğunu ve dili seçer.
   Aklına video gelmeyen, oda sahibinin Kulis'te verdiği oynatma listesinden gelen iki videodan birini
   seçebilir ya da "Başka iki tane" ile yenilerini getirebilir (listeyi worker yt-dlp ile okur).
2. Oylamayla bir video seçilir (kendi videona oy veremezsin, videosu seçilen +1 puan alır).
3. Sunucu videodaki **konuşmaları siler, müzik ve efektleri bırakır**, konuşmaları yazıya çevirir ve
   karakterlere böler. Senaryo ekranında herkes metni ve konuşmacıları düzeltebilir.
4. Oyuncular karakter sayısı kadar kişilik gruplara bölünür (9 kişi, 4 karakter → 4 + 4 + 1). Eksik grupta
   bir oyuncu birden fazla karakteri seslendirir; her karakterine ayrı ses efekti otomatik uygulanır.
5. Gruplar kendi evinden, ekrandaki karaoke senaryosuna bakarak kaydeder. "Grupça başlat" ile gruptaki herkesin
   kaydı aynı anda başlar.
6. Her grubun videosu herkese aynı anda gösterilir, 1-5 yıldız verilir (kendi grubuna da). En yüksek
   ortalama kazanır, herkes grubunun ortalamasını puan olarak alır. Sonra sıradaki video oylanır.

## Parçalar

| Klasör | Ne | Teknoloji |
|---|---|---|
| `server/` | Oyun durumu, odalar, kayıt yükleme, sesleri birleştirme (ffmpeg) | Node.js ≥ 22.18, Express, Socket.IO |
| `web/` | Arayüz | React, Vite |
| `worker/` | İndirme, konuşmayı ayırma, yazıya çevirme, konuşmacı ayırma | Python, yt-dlp, Demucs, faster-whisper, sherpa-onnx |
| `shared/` | Sunucu ve arayüzün ortak tipleri | TypeScript |

Worker sunucuya HTTP ile bağlanıp iş çeker. Bu yüzden telefonda da çalışabilir, bilgisayarda da. GPU'lu bir
worker bağlıyken yavaş olanlar (telefon) işleri ona bırakır.

## Bilgisayarda çalıştırma

En kolayı: proje klasöründeki **`baslat.cmd`** dosyasına çift tıkla (ya da terminalde `.\baslat.cmd`).
Sunucuyu ve worker'ı iki ayrı pencerede açar, tarayıcıda oyunu açar. Gerekirse önce paketleri kurar ve
arayüzü derler. Kapatmak için iki pencereyi kapat.

Elle başlatmak istersen bir terminalde:

```bash
npm install
npm run build
npm start
```

Ayrı bir terminalde worker:

```bash
cd worker
.venv\Scripts\python worker.py
```

Sonra tarayıcıda <http://localhost:3100>.

> `npm` "bulunamadı" diyorsa terminal, Node.js kurulmadan önce açılmıştır: terminali (ya da onu açan
> uygulamayı) kapatıp yeniden aç. `baslat.cmd` bu durumdan etkilenmez. Mikrofon için sayfa `localhost` ya da `https` üzerinden açılmalı;
arkadaşların için telefondaki Cloudflare tüneli bunu sağlıyor.

Geliştirirken anında yenilenen sürüm için iki terminal: `npm run dev:server` ve `npm run dev:web`
(<http://localhost:5173>).

### Worker'ı tek başına denemek

```bash
cd worker
.venv\Scripts\python worker.py test "https://www.youtube.com/watch?v=..." --start 10 --end 40 --lang tr --speakers 2
```

Her adımın süresini, bulunan replikleri yazar ve `data/test-output/` içine konuşmasız videoyu
(`clip.mp4`), ayrılan konuşmayı (`speech.wav`) ve müzik/efekt sesini (`music.wav`) koyar.

### Worker kurulumu (yeni bir bilgisayarda)

```bash
cd worker
python -m venv .venv
.venv\Scripts\pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu124
.venv\Scripts\pip install -r requirements.txt
```

GPU yoksa ilk satırda `cu124` yerine `cpu` yaz. ffmpeg ve Node.js (ya da Deno) PATH'te olmalı.

## Telefonda çalıştırma

Bkz. [docs/telefon-kurulum.md](docs/telefon-kurulum.md).

## Ayarlar (ortam değişkenleri)

| Değişken | Varsayılan | Ne işe yarar |
|---|---|---|
| `PORT` | `3100` | Sunucu portu |
| `WORKER_TOKEN` | `counteroke-dev` | Worker ile sunucu arasındaki ortak anahtar. İnternete açarken mutlaka değiştir. |
| `GAME_PASSWORD` | boş | Doluysa oyuna girmek için şifre ister |
| `MAX_CLIP_SECONDS` | `120` | Önerilebilecek en uzun klip |
| `KEEP_DAYS` | `7` | Bu kadar gün kullanılmayan klipler ve sahne videoları silinir. `0` = hiç silme |
| `DATA_DIR` | `data/` | Videolar, kayıtlar ve oyun durumu |
| `FFMPEG` | `ffmpeg` | ffmpeg yolu |
| `WHISPER_MODEL` | GPU: `large-v3-turbo`, CPU: `small` | Yazıya çevirme modeli |
| `DEMUCS_MODEL` | `htdemucs` | Konuşma ayırma modeli |
| `WORKER_THREADS` | hepsi | Worker'ın kullanacağı çekirdek sayısı |

## Depolama

- YouTube'dan inen ham video ve ara ses dosyaları işlenir işlenmez silinir.
- Konuşması silinmiş klipler (`data/clips`) önbellekte durur: aynı video tekrar seçilirse yeniden işlenmez.
- Sahne videoları (`data/mixes`) "Sıfırla"ya kadar ya da `KEEP_DAYS` dolana kadar kalır, tekrar izlenip indirilebilsin diye.
- Sunucu her açılışta ve açıkken 6 saatte bir temizlik yapar: `KEEP_DAYS` gündür kullanılmayan klipleri ve sahne
  videolarını, biten sahnelerin kayıtlarını ve yarım kalmış yüklemeleri siler. O an oynanan sahneye dokunmaz.
- Worker açılırken yarım kalmış işlerden kalan geçici klasörlerini siler.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `npm test` | Sunucu birim testleri (gruplama, rol dağıtımı, ses birleştirme) |
| `cd worker && .venv\Scripts\python -m unittest test_pipeline` | Senaryo oluşturma testleri (model gerekmez) |
| `npm run check` | TypeScript tip kontrolü |
| `npm run build` | Arayüzü derler (`web/dist`) |

## Bilinen sınırlar

- Konuşma ayırma "insan sesini" ayırır: videoda sözlü bir şarkı varsa şarkının vokali de gider.
- Konuşmacı ayırma kusursuz değil; senaryo ekranından düzeltilebilir.
- İngilizce videoların senaryosu şimdilik İngilizce gösterilir (çeviri yok).
- Oyun tek odalı: sunucuya bağlanan herkes aynı oyunda.
