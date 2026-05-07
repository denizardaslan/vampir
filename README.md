# Vampir Köylü

Esnek oyuncu sayısıyla, moderatörsüz, local ağ üzerinden oynanan Vampir Köylü oyunu.

Canlı demo: https://vampir-bz87.onrender.com/

## Kurulum & Çalıştırma

```bash
cd vampir-koylu
npm install
npm start
```

Sunucu `http://localhost:3000` adresinde başlar.

## Telefondan Bağlanmak

1. Mac'in local IP adresini bul:
   ```bash
   ipconfig getifaddr en0
   ```
2. Tüm telefonlar aynı WiFi'a bağlı olmalı.
3. Telefonda tarayıcı aç: `http://192.168.x.x:3000` (kendi IP'ini yaz)

> **Not:** Mac'te ilk çalıştırmada "Gelen bağlantılara izin ver" uyarısı çıkarsa **İzin Ver**'e bas.

## Nasıl Oynanır

1. Oyuncu ilk ekranda sadece adını girer.
2. Sonraki ekranda açık lobileri görür veya kendi lobisini kurar.
3. Lobi kuran oyuncu lobi adı ve opsiyonel şifre belirler; otomatik host olur.
4. Diğer oyuncular listeden lobiyi seçer, varsa şifreyi girip katılır.
5. Host doktor, kahin, vampir sayısı, ilk gece öldürme ve tartışma süresi ayarlarını yapar.
6. En az 3 oyuncu olduğunda ve vampir sayısı oyuncu sayısından az olduğunda host **Oyunu Başlat**'a basar.
7. Herkes kendi rolünü görür, gece başlar.
8. Oyun moderatörsüz, tamamen otomatik ilerler.

## Roller

| Rol | Sayı | Görev |
|-----|------|-------|
| Vampir | 1-3 | Her gece bir köylüyü öldür |
| Doktor | 0-1 | Her gece birini koru |
| Kahin | 0-1 | Her gece birinin rolünü öğren |
| Köylü | Kalan oyuncular | Vampirleri bul ve as |

## Tek Bilgisayarda Test

Farklı tarayıcı sekmeleri veya gizli pencereler açarak tek başına test edebilirsiniz.
Rol ekranlarını tek panelden izlemek için `http://localhost:3000/test.html` adresindeki test arayüzünü kullanabilirsiniz.
