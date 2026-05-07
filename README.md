# Vampir Köylü

6 kişilik, moderatörsüz, local ağ üzerinden oynanan Vampir Köylü oyunu.

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

1. İlk bağlanan oyuncu **host** olur.
2. 6 kişi lobiye katılınca host **Kahin var mı?** seçeneğini ayarlar ve **Oyunu Başlat**'a basar.
3. Herkes kendi rolünü görür, gece başlar.
4. Oyun moderatörsüz, tamamen otomatik ilerler.

## Roller

| Rol | Sayı | Görev |
|-----|------|-------|
| Vampir | 2 | Her gece bir köylüyü öldür |
| Doktor | 1 | Her gece birini koru |
| Kahin | 0-1 | Her gece birinin rolünü öğren |
| Köylü | 2-3 | Vampirleri bul ve as |

## Tek Bilgisayarda Test

6 farklı tarayıcı sekmesi veya gizli pencere açarak tek başına test edebilirsiniz.
