# Vampir Köylü - 6 Kişilik Local Web Oyunu

## Proje Özeti

6 kişiyle moderatörsüz oynanabilen, local network üzerinde çalışan vampir köylü oyunu. Sunucu Mac'te çalışacak, oyuncular aynı WiFi'da telefonlarından bağlanacak. Tüm moderasyon (rol dağıtımı, gece aksiyonları, oylama, ölüm anonsu) site tarafından otomatik yapılacak.

## Teknoloji Stack

- **Backend:** Node.js + Express + Socket.IO (real-time için şart)
- **Frontend:** Tek HTML dosyası + vanilla JS (build step yok, basit tutalım)
- **Storage:** In-memory (sunucu kapanınca veri silinir, kasıtlı)
- **Çalıştırma:** `node server.js` → `http://<mac-ip>:3000`

## Klasör Yapısı

```
vampir-koylu/
├── server.js           # Tüm backend mantığı tek dosyada
├── package.json
├── public/
│   ├── index.html      # Tek sayfa, tüm ekranlar burada (show/hide ile)
│   ├── app.js          # Tüm frontend mantığı
│   └── style.css       # Mobil-first stil
└── README.md           # Nasıl çalıştırılır
```

## Oyun Kuralları (İmplementasyon İçin Tam Spek)

### Rol Dağılımı
- **2 Vampir** (her zaman)
- **1 Doktor** (her zaman)
- **1 Kahin** (opsiyonel — oyun başında sen seçeceksin)
- **2 veya 3 Köylü** (Kahin yoksa 3, varsa 2)

### Kazanma Koşulları
- **Vampirler kazanır:** Vampir sayısı ≥ köylü sayısı (köylü = vampir olmayan tüm canlılar)
- **Köylüler kazanır:** Tüm vampirler ölür

### Faz Akışı

**1. Lobby Fazı**
- İlk bağlanan kişi "host" olur (isteğe bağlı, sadece "başlat" butonu görür)
- Diğerleri isim girer, listede görünür
- 6 kişi olunca host "Kahin var mı?" toggle'ını ayarlar ve "Başlat"a basar
- Roller rastgele dağıtılır, herkes kendi rolünü ekranında görür
- Vampirler birbirinin ismini görür (önemli!)

**2. Gece Fazı**
- Tüm ekranlarda "Gece başladı, gözlerini kapat. Telefonu açık tut." mesajı
- Rollere göre paralel ekranlar açılır:
  - **Vampirler:** Canlı oyuncu listesi + seçim + birbiriyle chat (real-time mesajlaşma)
    - İki vampir aynı kişiyi seçmek zorunda. Biri seçer, diğeri "onayla" basar. Değiştirilebilir.
    - Eğer bir vampir öldüyse, kalan tek vampir tek başına seçer
  - **Doktor:** Canlı oyuncu listesi + seçim. Kendini de seçebilir ama 2 gecede 1 (ardışık iki gece kendini koruyamaz)
  - **Kahin:** Canlı oyuncu listesi + seçim → seçim sonrası kişinin rolünü ("Vampir" / "Vampir Değil") görür
  - **Köylüler:** "Uyuyorsun, gün doğmasını bekle" ekranı
- Tüm aksiyonlar tamamlanınca otomatik olarak gündüze geçilir

**3. Gündüz Açılış (day_reveal)**
- Tüm ekranlarda aynı anda: ya "X öldürüldü, rolü Y idi" ya da "Bu gece kimse ölmedi (doktor kurtardı)"
- Ölü oyuncu izleyici moduna geçer (aşağıda detay)
- Kazanan var mı kontrol et, varsa game_over'a geç

**4. Tartışma Fazı (day_discuss)**
- 5 dakikalık geri sayım (ayarlanabilir olsun, host değiştirebilsin: 3/5/7 dk)
- Bu sırada kimse ekranda bir şey yapmıyor, yüzyüze konuşuyor
- Süre dolunca otomatik oylamaya geçilir, ya da host "oylamaya geç" butonuna basar

**5. Oylama Fazı (day_vote)**
- Canlı oyuncular canlı oyuncular arasından birini seçer (kendine oy verebilir, "çekimser" seçeneği de olsun)
- Herkes oyunu verince ya da 60 saniye geçince sonuç açıklanır
- En çok oy alan asılır, rolü açıklanır
- Eşitlik durumunda → kimse asılmaz, gece fazına geçilir
- Kazanan var mı kontrol et

**6. Game Over**
- Kazanan taraf + tüm oyuncuların rolleri açıklanır
- "Yeni Oyun" butonu (host'a)

### İzleyici Modu (Önemli!)
- Ölen oyuncu ekranında tüm canlıların rollerini ve gece aksiyonlarını görebilir
- AMA hiçbir şey gönderemez (chat, oy, vs hepsi disable)
- Bu detay önemli çünkü ölü oyuncular masada hâlâ orada, telefonu görürse ipucu verir → bu yüzden net bir "izliyorsun" UI'ı olmalı

## Backend Detayları (server.js)

### State Yapısı

```javascript
let game = {
  phase: 'lobby',              // lobby | night | day_reveal | day_discuss | day_vote | game_over
  players: [],                  // [{ id, name, role, alive, socketId, isHost }]
  withSeer: true,
  nightActions: {
    vampire: { selectedTarget: null, confirmedBy: [] },
    doctor: { target: null, lastSelfProtect: -2 },  // gün numarası
    seer: { target: null, result: null }
  },
  votes: {},                    // { voterId: targetId | 'abstain' }
  vampireChat: [],              // [{ name, message, timestamp }]
  dayNumber: 0,
  lastNightDeath: null,         // { name, role } veya null
  discussDuration: 5,           // dakika
  winner: null                  // 'vampires' | 'villagers' | null
};
```

### Socket.IO Eventleri

**Client → Server:**
- `join_lobby` { name } → oyuncuyu lobby'ye ekle
- `start_game` { withSeer } → host gönderir, roller dağıtılır
- `vampire_select` { targetId } → vampir kurban seçer
- `vampire_confirm` → diğer vampir onaylar
- `vampire_message` { text } → vampir chat
- `doctor_select` { targetId }
- `seer_select` { targetId }
- `cast_vote` { targetId | 'abstain' }
- `start_voting` → host gönderir, tartışmadan oylamaya geçer
- `new_game` → host gönderir, lobby'ye döner (oyuncular kalır)
- `set_discuss_duration` { minutes }

**Server → Client:**
- `lobby_update` { players, isHost, gameState }
- `role_assigned` { role, fellowVampires }   // sadece o oyuncuya
- `phase_change` { phase, data }              // herkese
- `night_result` { deathName, deathRole }     // herkese
- `vote_update` { votedCount, totalVoters }
- `vote_result` { hangedName, hangedRole, voteBreakdown }
- `seer_result` { targetName, isVampire }     // sadece kahine
- `vampire_chat_update` { messages }          // sadece vampirlere
- `vampire_selection_update` { targetId, confirmedBy }  // sadece vampirlere
- `game_over` { winner, allRoles }
- `error` { message }

### Önemli Mantık Kuralları

1. **Disconnect handling:** Bir oyuncu bağlantıyı kaybederse oyundan atılmasın, tekrar bağlandığında aynı role devam etsin. Bunun için `localStorage`'da player ID tut, reconnect'te eski ID'yi gönder.

2. **Tek vampir kaldıysa:** Confirm mekanizması bypass edilsin, tek başına seçtiği anında onaylanmış sayılsın.

3. **Doktor kurtarması:** Vampirlerin seçtiği kişi = doktorun seçtiği kişi → o gece kimse ölmez.

4. **Race condition:** Phase geçişlerinde server otoriter. Client sadece istek gönderir, server validate edip phase'i değiştirir.

5. **Host transferi:** Host disconnect olursa diğer canlı oyunculardan biri otomatik host olur.

## Frontend Detayları (public/)

### Tek Sayfa Yapısı

`index.html` içinde her faz için ayrı bir `<div>` (id'li), JS ile aktif olan gösterilir:

```
#screen-name-entry      → ilk açılışta isim girme
#screen-lobby           → bekleme + isim listesi + (host için) başlat
#screen-role-reveal     → "Sen Vampirsin" tarzı 5 saniye gösterim
#screen-night-vampire   → vampir gece ekranı (chat + seçim)
#screen-night-doctor    → doktor gece ekranı
#screen-night-seer      → kahin gece ekranı
#screen-night-villager  → "uyuyorsun" ekranı
#screen-day-reveal      → "X öldü" anonsu
#screen-day-discuss     → geri sayım + (host için) "oylamaya geç" butonu
#screen-day-vote        → oylama UI
#screen-game-over       → sonuç + tüm roller + yeni oyun
#screen-spectator       → ölü oyuncu için her şeyi gören izleyici ekranı
```

### Mobil-First UI Notları

- Büyük butonlar (parmakla rahat basılır)
- Vampir chat scroll'lu olmalı, klavye açıldığında bozulmamalı
- Gece ekranları siyah/koyu tema, gündüz açık tema (dramatik efekt için)
- Oy verirken yanlışlıkla basmayı önlemek için "onayla" adımı olsun
- Rol gösterilirken titreşim (`navigator.vibrate`) ekstra güzel olur

### Reconnect Mantığı

```javascript
// İlk açılışta
let playerId = localStorage.getItem('vk_player_id');
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem('vk_player_id', playerId);
}
socket.emit('hello', { playerId });
// Server bu ID'yi tanırsa eski state'ini geri yollar
```

## package.json

```json
{
  "name": "vampir-koylu",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.19.0",
    "socket.io": "^4.7.0"
  }
}
```

## README.md İçeriği

Şunları içersin:
- Mac'te nasıl çalıştırılır (`npm install` → `npm start`)
- Mac'in local IP'sini nasıl bulur (`ipconfig getifaddr en0`)
- Telefondan nasıl bağlanılır (`http://192.168.x.x:3000`)
- Mac'te firewall uyarısı çıkarsa "İzin Ver"e basılması gerektiği
- Tüm cihazların aynı WiFi'da olması gerektiği

## İmplementasyon Sırası (Önerilen)

1. **İskelet:** Express + Socket.IO kurulumu, "merhaba dünya" düzeyi connection
2. **Lobby:** İsim girme, oyuncu listesi, host atama
3. **Rol dağıtımı:** Başlat → roller atanır → herkes kendi rolünü görür
4. **Gece - vampir:** Sadece vampir ekranı + seçim + chat (diğerleri "uyuyorsun")
5. **Gece - doktor + kahin:** Diğer rolleri ekle
6. **Gündüz açılış:** Ölüm hesaplama + anonsu
7. **Tartışma + oylama:** Geri sayım + oy verme + asma
8. **Kazanma kontrolü + game over**
9. **İzleyici modu:** Ölü oyuncular için
10. **Reconnect:** localStorage + state restore
11. **Polish:** Animasyon, ses, titreşim, koyu tema

## Test Senaryosu

Geliştirirken tek bilgisayarda 6 farklı browser tab/incognito ile test edebilirsin. Her tab farklı bir oyuncu olur. Bu sayede tek başına debug edersin.

## Edge Case'ler (Atlamayalım)

- Tüm oyuncular oy vermeden 60 saniye geçerse → mevcut oylar sayılır
- Tüm vampirler aynı gecede ölürse → o gecenin sonunda köylüler kazanır
- Doktor kendisi vampirlerin hedefiyse ve kendini koruyorsa → kurtulur
- Kahin kendi rolünü kontrol edemesin (kendi adı listede olmasın)
- Eşit oyda kimse asılmaz, gece fazına geçilir (sonsuz döngü olmasın diye max 10 gün limiti koy, dolarsa berabere sayılır)

---

Bu plan Claude Code'da step-by-step ilerlemen için yeterli detayda. İmplementasyon sırasındaki adımları sırayla "şimdi 1. adımı yap", "şimdi 2. adımı yap" diye ilerleyebilirsin, ya da hepsini birden isteyebilirsin (ama büyük olduğu için adım adım gitmek daha sağlıklı olur).
