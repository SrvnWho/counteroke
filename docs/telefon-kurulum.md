# Telefonda kurulum (Termux)

> ⚠️ Bu adımlar telefonda henüz denenmedi. Bilgisayarda (Windows) her şey test edildi, ama Termux ve
> proot-distro tarafında küçük farklılıklar çıkabilir. Takıldığın adımı ve hatayı yazarsan düzeltiriz.

Kurulumdan sonra telefonda üç şey çalışır, üçü de pm2 altında ve anucvc'den ayrı:

| pm2 adı | Ne yapar | Nerede çalışır |
|---|---|---|
| `counteroke-server` | Oyun sunucusu ve arayüz (port 3100) | Termux, Node.js |
| `counteroke-worker` | Ses ayırma, yazıya çevirme, konuşmacı ayırma | Termux içindeki Ubuntu kutusu |
| `counteroke-tunnel` | Sabit adresi (ör. `https://counteroke.alanadin.com`) telefona bağlar | Termux, cloudflared |

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

Telefonda (ekran kartı olmayan her makinede) worker zaten hafif ayarlarla çalışır: yazıya çevirme tek tahminle
(`WHISPER_BEAM=1`), ses ayırma daha az üst üste binen parçalarla (`DEMUCS_OVERLAP=0.1`). Kalite yetmezse bu iki
değeri `counteroke.config.cjs` içindeki worker satırına ekleyip büyütebilirsin (5 ve 0.25 bilgisayardaki değerler).

## 4. Ayarları yaz

Ayarlar `counteroke.secrets.json` dosyasında duruyor. Bu dosya git'e hiç girmez, yani anahtarlar GitHub'a
yanlışlıkla gitmez. Örnek dosyadan kopyala:

```bash
cd ~/counteroke && cp counteroke.secrets.example.json counteroke.secrets.json
```

Uzun, rastgele bir anahtar üret:

```bash
head -c 24 /dev/urandom | base64
```

Dosyayı `nano counteroke.secrets.json` ile aç ve doldur:

| Ayar | Ne yazılır |
|---|---|
| `WORKER_TOKEN` | Az önce ürettiğin yazı |
| `GAME_PASSWORD` | İstersen oda şifresi; boş bırakırsan şifre sorulmaz |
| `PUBLIC_URL` | Arkadaşlarının açacağı sabit adres, ör. `https://counteroke.alanadin.com` |
| `TUNNEL_TOKEN` | Bir sonraki adımda Cloudflare'den alacağın tünel anahtarı |

## 5. Sabit adres (Cloudflare tüneli)

Oyun her açılışta aynı adreste olur, link değişmez. Bunun için alan adının DNS'i Cloudflare'de olmalı (alan
adının "nameserver"ları Cloudflare'i gösteriyorsa tamam).

1. Cloudflare panelinde **Zero Trust → Networks → Tunnels → Create a tunnel** yolunu izle, türü **Cloudflared**
   seç, adına `counteroke` yaz.
2. Kurulum ekranında gösterilen komutun sonundaki uzun anahtarı (`eyJ…` ile başlar) kopyala ve
   `counteroke.secrets.json` içindeki `TUNNEL_TOKEN` değerine yapıştır. Komutu çalıştırmana gerek yok, tüneli pm2
   başlatacak.
3. Sonraki adımda bir adres ekle (panelde "Public hostname" ya da "Published application routes" diye geçer):
   alt alan adı `counteroke`, alan adı seninki, servis türü **HTTP**, adres **`localhost:3100`**. Kaydet.

Telefonda başka bir tünel zaten çalışıyorsa (ör. anucvc için) yeni tünel açmak yerine o tünele de aynı adresi
ekleyebilirsin. O zaman `TUNNEL_TOKEN`'ı boş bırak; pm2 ayrı bir tünel başlatmaz.

## 6. Oyun gecesi

Başlat:

```bash
cd ~/counteroke && pm2 start counteroke.config.cjs
```

Arkadaşlarına `PUBLIC_URL` adresini at; Kulis ekranında da bu adres görünür. Adres her açılışta aynıdır.
Oyuna sonradan katılan da oynar: rol dağıtımı ya da kayıt sırasında girerse eksik bir gruba ya da kendi grubuna
eklenir.

Bitince kapat:

```bash
pm2 delete counteroke.config.cjs
```

`stop` yerine `delete` kullanıyoruz: böylece `pm2 save` yaptığında counteroke kayda girmez ve telefon yeniden
başlayınca kendiliğinden açılmaz. anucvc bundan etkilenmez.

## 7. Bilgisayarı hızlı işleyici olarak bağlamak (önerilir)

Telefon bir klibi birkaç dakikada işleyebilir. Bilgisayarındaki RTX 2070 Super aynı işi saniyeler içinde
yapar. Oyun gecesi bilgisayarında, projenin `worker` klasöründe şunu çalıştırman yeterli (anahtar,
telefondaki `counteroke.secrets.json` ile aynı olmalı):

```bash
.venv\Scripts\python worker.py --server https://counteroke.alanadin.com --token <WORKER_TOKEN>
```

Bilgisayardaki worker bağlıyken telefon işleri ona bırakır, havuzdaki videoları da oylama bitmeden önceden işler.
Böylece hangi video kazanırsa kazansın senaryo çoğu zaman hemen açılır. Bilgisayar kapanırsa telefon devam eder;
telefon tek başınayken sadece oylamada önde olan videoyu önceden işler.

## Sorun giderme

- **Worker sürekli yeniden başlıyor:** `pm2 logs counteroke-worker` ile hatayı gör. Ubuntu kutusunun adının
  `ubuntu` olduğundan emin ol (`proot-distro list`).
- **"YouTube bot kontrolü istedi":** Biraz bekleyip tekrar dene ya da başka video seç.
- **Adres açılmıyor, Cloudflare "1033" hatası:** Tünel çalışmıyor. `pm2 logs counteroke-tunnel` ile bak;
  `TUNNEL_TOKEN` yanlış kopyalanmış olabilir.
- **Adres açılıyor ama "502 Bad Gateway":** Tünel çalışıyor ama oyun sunucusu kapalı ya da panelde adres
  `localhost:3100` değil. `pm2 logs counteroke-server` ile bak.
- **Telefon ısınıyor / anucvc takılıyor:** `counteroke.config.cjs` içindeki `WORKER_THREADS=4` değerini 2'ye
  düşür.
- **Depolama dolar mı:** Sunucu her açılışta 7 günden eski klipleri ve sahne videolarını siler. Süreyi
  `counteroke.config.cjs` içindeki `KEEP_DAYS` ile değiştirebilirsin. Ne kadar yer kapladığını görmek için:
  `du -sh ~/counteroke/data`
- **Sürekli şarjda:** Eski telefonların bataryası şişebilir. Arada bir kontrol et, varsa şarj sınırlamayı aç.
