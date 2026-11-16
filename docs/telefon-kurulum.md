# Telefonda kurulum (Termux)

> ⚠️ Bu adımlar telefonda henüz denenmedi. Bilgisayarda (Windows) her şey test edildi, ama Termux ve
> proot-distro tarafında küçük farklılıklar çıkabilir. Takıldığın adımı ve hatayı yazarsan düzeltiriz.

Kurulumdan sonra telefonda üç şey çalışır, üçü de pm2 altında ve anucvc'den ayrı:

| pm2 adı | Ne yapar | Nerede çalışır |
|---|---|---|
| `counteroke-server` | Oyun sunucusu ve arayüz (port 3100) | Termux, Node.js |
| `counteroke-worker` | Ses ayırma, yazıya çevirme, konuşmacı ayırma | Termux içindeki Ubuntu kutusu |
| `counteroke-tunnel` | Arkadaşlarına `https://…trycloudflare.com` linki verir | Termux, cloudflared |

## 1. Termux paketleri

```bash
pkg update
pkg install nodejs-lts ffmpeg cloudflared proot-distro git
node -v
```

`node -v` en az **v22.18** olmalı (sunucu TypeScript dosyalarını Node'un kendisiyle çalıştırıyor). anucvc
zaten Node ile çalıştığı için muhtemelen kurulu, sadece sürümü kontrol et.

## 2. Projeyi telefona indir

```bash
cd ~ && git clone https://github.com/SrvnWho/counteroke.git
```

```bash
cd ~/counteroke && npm install && npm run build
```

Sonradan güncellemek için (yeni bir şey eklendiğinde):

```bash
cd ~/counteroke && git pull && npm install && npm run build
```

## 3. Ubuntu kutusu ve ses işleme

Ses işleme kütüphaneleri (PyTorch, Whisper…) Termux'ta doğrudan kurulamıyor, o yüzden telefonun içinde
ayrı bir Ubuntu çalıştırıyoruz. Bu, Termux'taki hiçbir şeye dokunmaz.

```bash
proot-distro install ubuntu
proot-distro login ubuntu --bind ~/counteroke:/counteroke
```

Artık Ubuntu'nun içindesin. Burada:

```bash
apt update && apt install -y python3 python3-venv python3-pip ffmpeg curl unzip
curl -fsSL https://deno.land/install.sh | sh
cd /counteroke/worker
python3 -m venv .venv-phone
.venv-phone/bin/pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu
.venv-phone/bin/pip install -r requirements.txt
```

Deno, yt-dlp'nin YouTube'dan video indirebilmesi için gerekiyor.

### Hız testi

Hâlâ Ubuntu'nun içindeyken, telefonun bir klibi ne kadar sürede işlediğini ölç:

```bash
PATH=/root/.deno/bin:$PATH WORKER_THREADS=4 .venv-phone/bin/python worker.py test "https://www.youtube.com/watch?v=jNQXAC9IVRw" --start 0 --end 19 --lang en --speakers 1
```

İlk çalıştırmada modeller iner (yaklaşık 600 MB), ikinci çalıştırma gerçek hızı gösterir. Sonuçları bana
yazarsan model ayarlarını telefona göre ayarlarız. Çıkmak için `exit`.

## 4. Anahtarı ayarla

Gizli ayarlar `counteroke.secrets.json` dosyasında duruyor. Bu dosya git'e hiç girmez, yani GitHub'a
yanlışlıkla gitmez. Örnek dosyadan kopyala:

```bash
cd ~/counteroke && cp counteroke.secrets.example.json counteroke.secrets.json
```

Uzun, rastgele bir anahtar üret:

```bash
head -c 24 /dev/urandom | base64
```

Çıkan yazıyı `counteroke.secrets.json` içindeki `WORKER_TOKEN` değerine yapıştır (`nano counteroke.secrets.json`).
İstersen `GAME_PASSWORD` ile oyuna şifre de koyabilirsin; boş bırakırsan şifre sorulmaz.

## 5. Oyun gecesi

Başlat:

```bash
cd ~/counteroke && pm2 start counteroke.config.cjs
```

Linki bul (bir iki saniye sürebilir):

```bash
pm2 logs counteroke-tunnel --lines 40 --nostream
```

`https://…trycloudflare.com` ile biten linki arkadaşlarına at. Link her açılışta değişir.

Bitince kapat:

```bash
pm2 delete counteroke.config.cjs
```

`stop` yerine `delete` kullanıyoruz: böylece `pm2 save` yaptığında counteroke kayda girmez ve telefon yeniden
başlayınca kendiliğinden açılmaz. anucvc bundan etkilenmez.

## 6. Bilgisayarı hızlı işleyici olarak bağlamak (önerilir)

Telefon bir klibi birkaç dakikada işleyebilir. Bilgisayarındaki RTX 2070 Super aynı işi saniyeler içinde
yapar. Oyun gecesi bilgisayarında, projenin `worker` klasöründe şunu çalıştırman yeterli (anahtar,
telefondaki `counteroke.secrets.json` ile aynı olmalı):

```bash
.venv\Scripts\python worker.py --server https://<telefondaki-link> --token <WORKER_TOKEN>
```

Bilgisayardaki worker bağlıyken telefon işleri ona bırakır. Bilgisayar kapanırsa telefon devam eder.

## Sorun giderme

- **Worker sürekli yeniden başlıyor:** `pm2 logs counteroke-worker` ile hatayı gör. Ubuntu kutusunun adının
  `ubuntu` olduğundan emin ol (`proot-distro list`).
- **"YouTube bot kontrolü istedi":** Biraz bekleyip tekrar dene ya da başka video seç.
- **Telefon ısınıyor / anucvc takılıyor:** `counteroke.config.cjs` içindeki `WORKER_THREADS=4` değerini 2'ye
  düşür.
- **Depolama dolar mı:** Sunucu her açılışta 7 günden eski klipleri ve sahne videolarını siler. Süreyi
  `counteroke.config.cjs` içindeki `KEEP_DAYS` ile değiştirebilirsin. Ne kadar yer kapladığını görmek için:
  `du -sh ~/counteroke/data`
- **Sürekli şarjda:** Eski telefonların bataryası şişebilir. Arada bir kontrol et, varsa şarj sınırlamayı aç.
