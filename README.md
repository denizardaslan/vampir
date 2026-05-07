# Vampir Köylü

Esnek oyuncu sayısıyla, moderatörsüz, local ağ üzerinden oynanan Vampir Köylü oyunu.

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

1. Bir oyuncu **Lobi Kur** ile oda oluşturur ve otomatik host olur.
2. Diğer oyuncular lobi kodu ve varsa lobi şifresiyle katılır.
3. Host doktor, kahin, vampir sayısı, ilk gece öldürme ve tartışma süresi ayarlarını yapar.
4. En az 3 oyuncu olduğunda ve vampir sayısı oyuncu sayısından az olduğunda host **Oyunu Başlat**'a basar.
5. Herkes kendi rolünü görür, gece başlar.
6. Oyun moderatörsüz, tamamen otomatik ilerler.

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
