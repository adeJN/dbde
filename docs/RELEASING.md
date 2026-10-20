# Rilis dan update aplikasi

Panduan ini untuk maintainer yang membuat installer dan mengunggah update. **Kolaborator tidak membutuhkan private key** untuk menjalankan aplikasi atau mengirim pull request.

[Kembali ke README](../README.md) · [Panduan kontribusi](../CONTRIBUTING.md)

## Pahami alurnya

```text
Perubahan kode → tes → build installer dan arsip update bertanda tangan
              → buat latest.json → unggah ke GitHub Releases
              → pengguna memeriksa update dari aplikasi
```

Push ke branch `main` hanya mengunggah source code. Itu belum membuat installer dan belum menyediakan file untuk updater. Script rilis di repository ini tidak mempublikasikan Release secara otomatis.

Endpoint yang dipakai aplikasi:

```text
https://github.com/adeJN/dbde/releases/latest/download/latest.json
```

Repository dan aset rilis harus dapat diunduh publik. Jangan memasukkan GitHub access token ke aplikasi. Jika informasi rilis belum tersedia, aplikasi menampilkan **Update information is not available yet**; kondisi itu berbeda dari hasil pemeriksaan valid **You’re up to date**.

## Build lokal tanpa private key

Untuk memeriksa executable desktop tanpa membuat installer atau arsip update:

```bash
npm run tauri -- build --no-bundle
```

Untuk pekerjaan pengembangan sehari-hari cukup gunakan `npm run tauri dev`.

## Persiapan maintainer

### Nomor versi

Versi awal yang menyertakan updater adalah **0.2.0**. Untuk pembaruan berikutnya, gunakan versi yang lebih tinggi daripada versi yang sudah dibagikan, misalnya `0.2.1`.

Samakan versi di:

- `package.json` dan metadata root di `package-lock.json`.
- `src-tauri/Cargo.toml`.
- `src-tauri/tauri.conf.json`.

Sinkronkan `Cargo.lock` dengan Cargo ketika versi paket berubah. `npm run release:build` akan menolak versi aplikasi yang tidak konsisten.

### Kunci updater

Private key maintainer disimpan di luar repository:

```text
~/.tauri/dbde-updater.key
```

Public key pasangannya tertanam di `src-tauri/tauri.conf.json`. Gunakan **private key yang sama untuk setiap rilis**, buat backup yang aman, dan jangan mengunggahnya ke GitHub atau membagikannya kepada kolaborator biasa. Kehilangan key menghambat distribusi update yang dipercaya oleh instalasi lama.

Pada mesin build lain, maintainer perlu memulihkan key yang sama atau mengisi `TAURI_SIGNING_PRIVATE_KEY` melalui environment yang aman. Jika key memakai password, isi juga `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Jangan menaruh nilainya dalam source code, Issue, PR, atau screenshot.

### Signing macOS

Tanda tangan updater memverifikasi file update. **Apple Developer ID signing dan notarization adalah proses terpisah.** Konfigurasi macOS saat ini memakai ad-hoc signing. Untuk distribusi yang diterima Gatekeeper tanpa peringatan, maintainer perlu menyiapkan sertifikat Developer ID dan kredensial notarization sebelum membangun rilis.

## Membuat rilis Apple Silicon

Jalankan langkah berikut di Mac Apple Silicon dengan dependency build dan private key yang benar. Untuk rilis pertama gunakan versi `0.2.0`; untuk rilis berikutnya sesuaikan nomor versi dan tag.

### 1. Jalankan pemeriksaan

Ikuti pemeriksaan yang relevan pada [CONTRIBUTING.md](../CONTRIBUTING.md#pemeriksaan-sebelum-pull-request). Pastikan perubahan sudah siap didistribusikan.

### 2. Buat installer dan arsip update

```bash
npm run release:build -- --target aarch64-apple-darwin
```

Script memuat path key tanpa mencetak isi key. Hasil build berada di:

```text
src-tauri/target/aarch64-apple-darwin/release/bundle/
  dmg/                  Installer .dmg untuk pemasangan manual
  macos/DBde.app        Aplikasi macOS
  macos/DBde.app.tar.gz  Arsip yang diunduh updater
  macos/DBde.app.tar.gz.sig  Tanda tangan arsip update
```

Periksa nama file yang benar pada output build. Path bisa berbeda jika memakai target atau direktori build lain.

### 3. Buat manifest update

```bash
npm run updater:manifest -- \
  --artifact src-tauri/target/aarch64-apple-darwin/release/bundle/macos/DBde.app.tar.gz \
  --platform darwin-aarch64 \
  --output src-tauri/target/latest.json
```

Tambahkan `--notes path/catatan-rilis.md` untuk catatan yang ditampilkan di dialog update. Script membaca file `.sig` yang bersebelahan dengan arsip. Nilai signature harus berupa isi file tersebut, bukan path file.

Jika `latest.json` sudah ada, script hanya menggabungkan platform untuk **versi yang sama**. Sebelum membuat manifest versi berikutnya, simpan/pindahkan manifest lama terlebih dahulu. Jangan mencampur platform dari versi berbeda.

### 4. Publikasikan GitHub Release

Buka [Releases adeJN/dbde](https://github.com/adeJN/dbde/releases), lalu buat Release normal dengan tag yang cocok, misalnya **v0.2.0**.

| File yang diunggah    | Kegunaan                                                 |
| --------------------- | -------------------------------------------------------- |
| Installer `.dmg`      | Dipasang manual oleh pengguna Mac                        |
| `DBde.app.tar.gz`     | Diunduh dan dipasang oleh updater                        |
| `DBde.app.tar.gz.sig` | Tanda tangan arsip update                                |
| `latest.json`         | Versi, URL arsip, dan signature untuk pemeriksaan update |

Nama arsip yang diunggah harus sama dengan URL di manifest. Unggah arsip terlebih dahulu dan manifest sesudahnya, lalu publikasikan Release sebagai **Latest**. Draft dan prerelease bukan jalur update default. Jangan mengunggah private key.

### 5. Uji dari instalasi lama

- Gunakan perangkat percobaan dengan build lama yang sudah mendukung updater.
- Buka **App updates** melalui ikon panah naik di sebelah Help.
- Pastikan versi baru dan catatan rilis tampil.
- Simpan SQL/edit tabel, selesaikan transaksi, tutup koneksi dan jendela tabel tambahan, lalu tunggu import/export selesai.
- Unduh, pasang, dan pastikan aplikasi restart ke versi baru.
- Periksa juga unduhan terputus serta signature yang tidak valid sebelum distribusi luas.

Versi yang sama tidak ditawarkan sebagai pembaruan. Pengguna build sebelum 0.2.0 perlu memasang build yang mendukung updater satu kali secara manual.

## Intel dan platform lain

Untuk Mac Intel, build target `x86_64-apple-darwin` pada lingkungan yang sesuai dan gunakan platform manifest `darwin-x86_64`. Setiap perangkat hanya menerima arsip untuk platformnya.

Jika satu Release mendukung lebih dari satu arsitektur, gunakan nama arsip yang berbeda, misalnya `DBde-aarch64.app.tar.gz` dan `DBde-x86_64.app.tar.gz`. Rename arsip beserta `.sig` pasangannya sebelum menjalankan pembuat manifest, lalu gabungkan hasil untuk versi yang sama. Jangan memakai arsip Apple Silicon untuk Intel.

Windows/Linux memerlukan build, format installer, dan pengujian pada lingkungan masing-masing. Adanya kode lintas platform tidak berarti installer semua platform sudah diverifikasi.

Tes script manifest:

```bash
node --test scripts/update-manifest.check.mjs
```
