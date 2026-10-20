# Panduan penggunaan DBde

[Kembali ke README](../README.md) · [Kontribusi](../CONTRIBUTING.md)

## Desktop dan sandbox

| Mode                                         | Digunakan untuk                                          | Penyimpanan                                                                |
| -------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Desktop (`npm run tauri dev` atau installer) | Menghubungkan MySQL/MariaDB, PostgreSQL, dan file SQLite | Profil di app-data; password tersimpan di credential vault OS jika dipilih |
| Browser (`npm run dev`)                      | Mencoba UI dan query SQLite dengan data contoh           | Database di memori; data kembali ke awal ketika reload                     |

Browser sandbox bukan koneksi ke database lokal Anda. Untuk pekerjaan nyata, gunakan aplikasi desktop.

## Membuat koneksi

1. Pilih **New connection** dari Explorer.
2. Isi tab **General** dengan nama koneksi dan tujuan database.
3. Gunakan **Test connection** sebelum menghubungkan.
4. Simpan profil jika ingin memakainya lagi tanpa mengisi ulang seluruh pengaturan.

### MySQL/MariaDB lokal

Host umumnya `127.0.0.1`, port umumnya `3306`. Gunakan username yang memang terdaftar pada server. Jika akun tidak mempunyai password, biarkan Password kosong. Server lokal tanpa TLS dapat memakai SSL **Disable**. Untuk koneksi remote, gunakan enkripsi/verifikasi sertifikat sesuai server.

Pesan `Access denied` berarti server menolak login. Periksa akun, password, host asal yang diizinkan, serta apakah port menunjuk ke instance MySQL yang benar.

### TiDB Cloud

Gunakan tipe koneksi **MySQL**, host/port/username dari panel **Connect** TiDB, dan TLS sesuai petunjuk endpoint. Jangan menonaktifkan SSL untuk endpoint cloud yang mewajibkan TLS.

Daftar tabel MySQL/TiDB dibaca melalui pool koneksi server yang sudah ada, dengan nama database sebagai bind parameter. Membuka daftar database lain tidak membuat pool baru atau menjalankan `USE` pada sesi bersama. Membuka data tabel atau query pada database lain tetap dapat memerlukan koneksi khusus.

`Connection reset by peer` berarti server atau jalur jaringan memutus koneksi; pesan itu saja belum menentukan penyebabnya. Jika muncul langsung, bandingkan endpoint/akun yang sama di client lain dan periksa status cluster, IP access list, serta quota di TiDB Cloud. Jika muncul setelah idle, periksa batas idle/lifetime. Pada Starter, quota yang habis dapat menolak koneksi baru meski koneksi lama masih ada. Lihat [batas koneksi dan quota resmi TiDB Cloud](https://docs.pingcap.com/tidbcloud/serverless-limitations/).

### Database yang ditampilkan

Tanpa daftar khusus, Explorer menampilkan database yang dapat diakses oleh akun. Buka tab **Databases** pada pengaturan koneksi untuk memilih database yang ingin ditampilkan dan menentukan **Auto Open**. Pilihan ini hanya mengatur tampilan; tidak membuat atau menghapus database di server.

### SSH dan pengaturan tambahan

- **SSH**: gunakan host, port, dan akun SSH yang sesuai. Host/port database di General dilihat dari sisi server SSH. Kunci host harus cocok dengan `known_hosts` atau fingerprint SHA256 yang telah diverifikasi.
- **SSL**: atur mode verifikasi, CA certificate, atau client certificate jika diperlukan server.
- **Advanced**: timeout, batas session, initial SQL, auto-connect, serta opsi engine yang tersedia.
- **Remarks**: catatan lokal untuk koneksi.

Password SSH dan database bisa berbeda. Jangan memasukkan password ke nama koneksi atau catatan. HTTP tunnel belum tersedia.

## Menjelajahi tabel

Klik nama database untuk membuka daftar tabel dalam tab. Panah di Explorer mengatur expand/collapse secara terpisah. Klik dua kali tabel untuk membuka datanya. Tabel yang sudah dibuka akan mengaktifkan tab yang sama pada konteks koneksi/database tersebut.

Gunakan pencarian Explorer untuk nama database atau tabel. Klik kanan pada koneksi, database, tabel, tab, atau sel untuk melihat aksi sesuai area. Aksi yang tidak dapat digunakan akan dinonaktifkan.

Sidebar dan lebar kolom dapat digeser. Tab dapat diurutkan dengan drag; tabel juga bisa dipindah ke jendela khusus agar area data lebih luas.

## Melihat dan mengubah record

- Tombol panah dan Tab memindahkan fokus antar sel.
- Klik dua kali, Enter, atau F2 untuk mulai mengedit sel yang didukung.
- Gunakan baris kosong di bagian bawah untuk menambahkan record. Kolom yang tidak diisi dapat memakai default database.
- Seleksi satu atau beberapa record dengan mouse/keyboard untuk copy atau delete.
- Edit/delete memerlukan identitas record yang didukung, biasanya primary key. Query gabungan atau tabel tanpa primary key dapat menjadi read-only.
- Nilai diperiksa sesuai tipe field. Constraint, unique key, foreign key, dan izin database tetap berlaku, termasuk ketika mengubah nilai primary key.

Dialog konfirmasi muncul untuk operasi permanen. Baca target tabel/database sebelum menyetujui penghapusan. Jika operasi gagal, baca pesan validasi sebelum mencoba ulang.

## Filter, sort, dan find/replace

| Alat                      | Cakupan                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- |
| **Filters** dengan AND/OR | Seluruh tabel sebelum pagination                                                      |
| Sort pada tabel           | Data yang sesuai filter, sebelum pagination                                           |
| **Filter this page**      | Record yang sudah dimuat pada halaman aktif                                           |
| Find/replace tabel        | Nilai pada halaman data yang sedang dimuat; bukan pembaruan otomatis seluruh database |
| **Rows per page**         | Jumlah record per halaman, 1–5.000; default 1.000                                     |

Tekan Enter atau keluar dari textbox Rows per page untuk menerapkan angka. **Table profiles** menyimpan pengaturan filter, sort, dan kolom untuk dipakai kembali; fitur ini bukan salinan data tabel.

## SQL dan transaksi

Gunakan **New query** untuk menulis SQL. Tekan `⌘/Ctrl+Enter` untuk menjalankan SQL terpilih atau isi editor. Query history dan saved queries membantu memakai kembali query. Tombol **? / Help** menjelaskan shortcut berdasarkan konteks.

**Begin Transaction** menahan rangkaian perubahan sampai diputuskan untuk commit atau rollback sesuai alur yang tersedia. Selesaikan transaksi sebelum menutup koneksi atau memasang update. Perilaku DDL dan rollback berbeda antar engine; jangan mengasumsikan setiap perintah dapat dibatalkan.

**Raw Mode** memasukkan ekspresi SQL yang didukung, seperti fungsi database, alih-alih teks literal. Gunakan dengan memahami ekspresinya; tipe data dan constraint tetap diperiksa server.

## Design Table dan database tools

Tekan `⌘/Ctrl+D` dari tabel aktif atau tabel terpilih untuk membuka **Design Table**. Pilih field untuk melihat/mengubah properti yang didukung, lalu tinjau SQL dan simpan. Pilihan properti berbeda antara MySQL/MariaDB, PostgreSQL, dan SQLite.

**Database tools** menyediakan transfer record, server monitor, informasi objek, visual SELECT builder, dan ER Model. Tampilan ER memperlihatkan tabel/field dan relasi yang tersedia dalam metadata. Ini bukan jaminan bahwa setiap jenis reverse/forward engineering atau sinkronisasi model sudah didukung.

## Import, export, dan copy tabel

Import/export menyediakan pilihan format, kolom, dan cakupan data sesuai dialog. Pilih cakupan secara eksplisit; hasil query, halaman aktif, dan seluruh tabel bisa mempunyai batas berbeda.

Copy/paste tabel antardatabase bergantung pada engine dan konteks koneksi. Untuk server berbeda gunakan transfer/export/import yang sesuai. Perpindahan banyak tabel bukan satu transaksi global; jika gagal sebagian, periksa tabel yang sudah berhasil sebelum mengulang. Dump SQL bukan backup konsisten penuh ketika database masih menerima perubahan.

## Batasan yang perlu diketahui

- Query desktop dibatasi sampai 50.000 baris hasil; timeout dapat diatur sesuai opsi yang tersedia.
- Total baris/ukuran pada daftar objek berasal dari metadata server dan bisa berupa estimasi.
- Data pada tab lain dapat menjadi snapshot lama; refresh untuk melihat perubahan terbaru.
- Dukungan engine/versi server dan hak akses memengaruhi fitur yang tersedia.
- MongoDB dan HTTP tunnel belum tersedia. Dukungan installer, SSH, dan integrasi live tetap perlu diuji pada OS/server yang dituju.
- Updater membutuhkan GitHub Release yang benar. Panduan penerbitan ada di [RELEASING.md](RELEASING.md).
