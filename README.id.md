<div align="center">

<img src="public/favicon.svg" width="96" alt="Logo Moonlit Unicorn" />

# Moonlit Unicorn

**Seekor unicorn toon kecil yang "hidup" melayang di antara awan volumetrik di bawah bulan raksasa: scene WebGL yang sinematik dan interaktif.**

[English](README.md) · [Bahasa Indonesia](README.id.md)

<sub>Dibuat oleh <b>Odyworks</b> · Three.js · TypeScript · Vite</sub>

<img src="docs/desktop.png" alt="Moonlit Unicorn, tampilan desktop" width="860" />

</div>

---

## Tentang

Moonlit Unicorn adalah karya seni interaktif, bukan landing page: satu karakter utama, banyak ruang gelap, dan dunia dengan kedalaman yang nyata. Kamera bergerak pelan seperti pengamat sinematik, depth of field mengaburkan awan di depan dan mengubah bintang jauh menjadi bokeh, dan semuanya bereaksi lembut terhadap pointer.

Unicorn-nya **hidup**: berkedip, menatap kursor kamu, menggerakkan telinga, mengibaskan ekor, bernapas, dan mengantuk kalau dibiarkan sendirian.

## Fitur

- **Tampilan sinematik:** depth of field bokeh berbasis kedalaman, bloom yang tertahan, vignette, film grain, dan chromatic aberration yang nyaris tak terlihat.
- **Awan volumetrik:** di-raymarch per awan (cahaya Beer-Lambert, tepi perak ke arah bulan), dirender setengah resolusi lalu digabung ke depth of field.
- **Dunia bermandikan cahaya bulan:** bulan 3D yang jauh dengan detail permukaan, bintang berkelompok di beberapa kedalaman, debu melayang, dan siluet unicorn di kejauhan.
- **Unicorn toon:** cel shading buatan sendiri, garis tinta, rambut berbasis helai dengan helai liar, dan mata ekspresif dengan kilau gambar. Gaya realistis tinggal satu pengaturan.
- **Hidup:** tatapan dengan kontak mata dan gerakan mata cepat, kedipan, suasana hati (senang, kaget, mengantuk), telinga berkedut, napas, kibasan ekor, dan surai yang mengikuti angin.
- **Fisika lembut:** seret unicorn dan ia kembali dengan efek pegas; hembusan angin mendorong surai, ekor, debu, dan awan.
- **Detail rapi:** preloader beranimasi, guide bar di bawah, dukungan reduced-motion, layout responsif untuk desktop dan HP, serta kualitas adaptif.

<div align="center">
<img src="docs/toon-vs-realistic.jpg" alt="Gaya toon (kiri) dan realistis (kanan)" width="560" />
<br /><sub>Toon (default) dan realistis, bisa diganti langsung.</sub>
</div>

<div align="center">
<img src="docs/mobile.png" alt="Tampilan HP" height="420" />&nbsp;&nbsp;<img src="docs/eyes.jpg" alt="Mata toon yang ekspresif" height="420" />
<br /><sub>Tampilan HP · Mata toon yang ekspresif</sub>
</div>

## Interaksi

| Aksi | Mouse / keyboard | Sentuh |
| --- | --- | --- |
| Melihat sekeliling (parallax) | Gerakkan pointer | Seret di langit |
| Menyeret unicorn | Tekan dan seret | Tekan dan seret |
| Mencolek unicorn | Klik · `Enter` / `Space` | Ketuk |
| Menyalakan bintang | Klik 5 bintang bercahaya (saling terhubung jadi rasi bintang) | Ketuk |
| Bintang jatuh | Klik langit kosong | Ketuk langit |
| Membuat permohonan | Tekan dan tahan di langit | Tekan dan tahan |
| Hembusan angin | Usap cepat | Usap cepat |
| Zoom | Scroll | Cubit (pinch) |
| Menggeser unicorn | Tombol panah | n/a |

Nyalakan kelima bintang untuk hujan meteor dan putaran unicorn. Guide bar di bawah menunjukkan interaksi mana yang sudah kamu temukan, dan setiap chip adalah tombol yang menjalankannya.

## Memulai

Membutuhkan **Node.js 20.19+ atau 22+**.

```bash
npm install
npm run dev        # http://localhost:5173 (atau port yang ditampilkan Vite)
```

```bash
npm run build      # type-check + build produksi ke dist/
npm run preview    # jalankan build produksi secara lokal
```

Buka hasil build `dist/` lewat web server (bukan dengan klik dua kali `index.html`): browser memblokir script modul pada `file://`.

### Opsi URL

| URL | Efek |
| --- | --- |
| `/?quality=low` | Paksa kualitas lebih ringan (yang dipakai HP) |
| `/?debug` | Panel pengaturan langsung (**hanya build development**) |

## Mengatur tampilan

Semua nilai artistik ada di **[`src/config/sceneConfig.ts`](src/config/sceneConfig.ts)**: kamera dan komposisi, bulan, warna langit, pencahayaan, awan, bintang, depth of field, bloom, palet toon dan tebal garis, kekuatan interaksi, kualitas. Panel `?debug` mengubah objek yang sama secara langsung.

```ts
hero: { style: 'toon', /* atau 'realistic' */ yaw: 0.88, floatAmplitude: 0.2 },
dof:  { focusRange: 1.15, nearBlur: 0.034, farBlur: 0.02 },
```

## Struktur proyek

```
src/
  config/sceneConfig.ts     semua nilai artistik
  scene/
    World.ts                orkestrator: loop, interaksi, kualitas
    CameraRig.ts            kamera sinematik, parallax pointer, zoom
    Moon.ts                 kubah langit, bulan, kabut, environment map
    Clouds.ts               awan volumetrik (raymarching)
    Stars.ts  Particles.ts  Beams.ts   bintang, bokeh, debu, meteor, rasi bintang
    UnicornController.ts    sang karakter: tulang, gerakan, suasana hati, gaya, outline
    HeroEyes.ts  HeroHair.ts  HeroShading.ts   mata, rambut helai, shader toon + aman-NaN
    Interaction.ts          pointer, sentuh, wheel, keyboard
    PostProcessing.ts       DOF bokeh, bloom, grading
    Debug.ts                panel pengaturan (khusus dev)
  ui/GuideBar.ts            guide bar di bawah
public/models/unicorn.glb   modelnya
```

## Performa

Target di desktop 60+ fps pada GPU kelas menengah; resolusi dibatasi (DPR 1,75 desktop, 1,5 mobile) dan turun otomatis kalau frame melambat. HP mendapat partikel lebih sedikit, lapisan rambut lebih sedikit, awan lebih ringan, dan tanpa bayangan.

## Catatan

- Karakter berasal dari proyek model terpisah dan diekspor ke `public/models/unicorn.glb`. Tulang surai dan ekornya bersaudara dengan pivot badan, jadi gerakan seluruh badan diterapkan pada grup induk.
- Shader rambut dan tangent-space dibuat **aman dari NaN**: beberapa wajah surai bagian dalam punya tangent yang rusak, dan satu piksel NaN saja bisa menghitamkan seluruh layar lewat bloom.

## Kredit

Dibuat oleh **Odyworks**. Dibangun dengan [Three.js](https://threejs.org/), [Vite](https://vite.dev/), dan TypeScript.
