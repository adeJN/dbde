# Berkontribusi ke DBde

Panduan ini membantu kolaborator menyiapkan proyek, mengerjakan perubahan, dan mengirim pull request.

[README](README.md) · [Panduan penggunaan](docs/USER_GUIDE.md) · [Rilis dan update](docs/RELEASING.md)

## 1. Jalankan proyek terlebih dahulu

Ikuti [langkah instalasi di README](README.md#mulai-menjalankan). Setelah `npm ci`:

```bash
# Desktop, terhubung ke database lokal/server
npm run tauri dev
```

Atau gunakan `npm run dev` untuk browser sandbox. Sandbox cukup untuk sebagian pekerjaan tampilan; perubahan koneksi, SSH, keychain, file native, dan updater perlu diuji pada desktop.

Tidak ada password database bersama atau file `.env` wajib untuk menjalankan sandbox. Buat koneksi sendiri lewat UI jika perlu menguji database. Gunakan database percobaan yang datanya boleh berubah.

## 2. Buat branch untuk pekerjaan Anda

Jika memiliki akses tulis ke repository:

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/nama-fitur
```

Gunakan `fix/nama-perbaikan` untuk bug atau `docs/nama-dokumentasi` untuk dokumentasi. Jika belum memiliki akses tulis, fork repository melalui GitHub, clone fork Anda, lalu kirim PR ke `adeJN/dbde:main`.

## 3. Pahami struktur proyek

```text
src/
  App.tsx             Alur workspace dan penghubung fitur
  components/         UI tabel, dialog, explorer, dan database tools
  lib/                API bridge, SQL, validasi, clipboard, dan helper
  hooks/              React hooks
  store.ts            State workspace (Zustand)
  types.ts            Tipe data frontend
  styles.css          Layout dan komponen
  theme.css           Warna tema gelap/terang
src-tauri/
  src/                Backend Rust: koneksi, query, record, file, SSH, updater
  tauri.conf.json     Konfigurasi aplikasi, build, dan updater
  capabilities/       Izin webview
scripts/              Build rilis dan pembuat manifest update
docs/                 Panduan dan screenshot
design-system/        Referensi desain workspace
```

Sebagian tes frontend berada di samping file terkait sebagai `*.test.ts` atau `*.test.tsx`. Tes Rust berada di modul masing-masing.

## 4. Kerjakan perubahan dengan cakupan yang jelas

- Untuk UI, gunakan pola komponen yang sudah ada dan warna pada `src/theme.css`. Periksa mode gelap, terang, dan otomatis. Ikuti [referensi desain](design-system/DBde.md).
- Untuk API native, jaga kecocokan command Rust, pemanggilan di `src/lib/api.ts`, dan tipe TypeScript. Periksa juga perilaku sandbox bila fitur tersedia di browser.
- Untuk operasi database, gunakan bind parameter untuk nilai dan helper quoting untuk identifier. Jangan mengandalkan validasi frontend saja; backend harus memeriksa metadata dan izin/constraint database.
- Perubahan filter/sort perlu tetap benar ketika berpindah halaman. Bedakan pencarian pada halaman aktif dengan filter seluruh tabel.
- Tangani edit yang belum disimpan, transaksi, pembatalan, dan kegagalan operasi. Jangan menghilangkan draft pengguna ketika query gagal.
- Tambahkan tes yang memeriksa perilaku untuk perubahan logika. Untuk perubahan visual sederhana, sertakan hasil pemeriksaan dan screenshot.
- Jangan commit kredensial, dump database pribadi, private key, hasil build, atau `node_modules`.

## Pemeriksaan sebelum pull request

Jalankan dari root proyek. Pilih pemeriksaan yang sesuai dengan bagian yang diubah, dan tulis hasilnya di PR.

| Perubahan                         | Pemeriksaan                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| Frontend/logika TypeScript        | `npm test` dan `npm run build`                                                            |
| Rust/backend                      | `cargo test --manifest-path src-tauri/Cargo.toml --locked`                                |
| Kualitas Rust                     | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings` |
| Format frontend/dokumentasi utama | `npm run format:check`                                                                    |
| Format Rust                       | `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                  |
| Script manifest update            | `node --test scripts/update-manifest.check.mjs`                                           |

Menjalankan satu file tes saat iterasi:

```bash
npm test -- src/components/AppUpdater.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --locked updates::tests
```

`npm run build` memeriksa TypeScript dan membuat frontend; ini belum membuat installer desktop. Tes Rust tertentu berstatus `ignored` karena membutuhkan server/konfigurasi integrasi. Baca prasyarat di tes tersebut dan jalankan hanya pada database percobaan. Jangan memasukkan URL koneksi yang berisi password ke Issue atau PR.

Tes SSH lokal menggunakan port localhost; firewall atau lingkungan sandbox yang melarang socket dapat membuat tes itu gagal. Kegagalan ini perlu dibedakan dari kegagalan logika aplikasi.

## 5. Kirim pull request

Contoh jika branch Anda bernama `feat/nama-fitur`:

```bash
git add path/file-yang-diubah
git commit -m "feat: jelaskan perubahan secara singkat"
git push -u origin feat/nama-fitur
```

Sesuaikan nama branch dan path file dengan pekerjaan Anda. Buka PR ke **main** melalui GitHub. Sertakan:

1. Masalah atau kebutuhan yang diselesaikan.
2. Perilaku setelah perubahan dan langkah untuk mencobanya.
3. Perintah tes yang dijalankan beserta hasilnya.
4. Screenshot sebelum/sesudah jika mengubah tampilan.
5. Batasan atau kebutuhan pengujian pada engine/OS lain.

Jangan mengubah nomor versi, public key updater, atau konfigurasi rilis untuk PR fitur biasa. Perubahan versi dan publikasi installer dikelola maintainer sesuai [panduan rilis](docs/RELEASING.md).

## Screenshot dokumentasi

Simpan screenshot di `docs/images/` dengan nama yang menjelaskan tampilan, misalnya `table-dark.png`. Gunakan path relatif pada Markdown supaya gambar ikut tampil di GitHub:

```markdown
![Tampilan tabel pada mode gelap](docs/images/table-dark.png)
```

Contoh tersebut berlaku dari README di root. Dari file di `docs/`, gunakan `images/table-dark.png`.

Gunakan data sandbox atau data contoh; jangan tampilkan alamat server pribadi, password, token, atau data pengguna. Screenshot yang ada di README diambil pada viewport 1440 × 900. Perbarui gambar yang relevan jika UI berubah.

## Mengurangi ukuran folder pengembangan

- `node_modules/`: dependency npm; bisa dibuat ulang dengan `npm ci`.
- `dist/`: hasil build frontend; bisa dibuat ulang dengan `npm run build`.
- `src-tauri/target/`: cache dan hasil kompilasi Rust, termasuk installer lokal.

Ketika aplikasi dev sudah dihentikan dan installer yang ingin disimpan sudah disalin ke tempat lain, cache Rust dapat dibersihkan:

```bash
cargo clean --manifest-path src-tauri/Cargo.toml
```

Perintah ini menghapus hasil kompilasi dan bundle di target; build berikutnya akan lebih lama. Jangan menghapus source code, file database percobaan yang masih diperlukan, atau key penandatanganan di luar proyek.
