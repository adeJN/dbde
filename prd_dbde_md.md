# Product Requirement Document (PRD)

## **DBde (Database Desktop)**
**Document Version:** 1.0  
**Status:** Approved / Ready for Engineering  
**Target Platform:** Desktop (Windows, macOS, Linux)  
**Author:** DBde Architecture Team  

---

### **1. Executive Summary**
**DBde** adalah aplikasi *database GUI client* lokal sekelas Navicat yang didesain ultra-ringan, hemat ruang penyimpanan (*storage*), dan memiliki performa kencang. Dibangun dengan **Tauri v2 (Rust)** sebagai *desktop backend* lokal dan **React (TypeScript)** sebagai *frontend*, DBde menyediakan antarmuka modern *multi-database* untuk mengelola MySQL, PostgreSQL, SQLite, dan MongoDB secara efisien tanpa *overhead* memori yang besar.

---

### **2. Product Goals & Success Metrics**

#### **2.1 Core Goals**
1. **Ultra-Lightweight Footprint:** Menghasilkan ukuran file installer dan penggunaan penyimpanan lokal sekecil mungkin (< 15 MB installer).
2. **Low Memory Consumption:** Penggunaan RAM saat aplikasi *idle* berada di kisaran ~30 – 50 MB (jauh lebih hemat dibandingkan client berbasis Electron/Java).
3. **Multi-Database Flexibility:** Mengintegrasikan pengelolaan database relasional (MySQL, PostgreSQL, SQLite) dan dokument/NoSQL (MongoDB) dalam satu antarmuka terpadu.
4. **Native Security:** Menjamin keamanan kredensial database dengan enkripsi native berbasis OS Keyring/Vault.

#### **2.2 Key Performance Indicators (KPIs)**
* **App Startup Time:** Aplikasi siap digunakan dalam waktu < 1.5 detik sejak dijalankan.
* **Large Dataset Rendering:** Mampu me-render 50.000+ baris data tanpa *UI lag/freeze* menggunakan teknik *virtual scrolling*.
* **Storage Footprint:** Total ukuran file aplikasi terinstal < 30 MB.
* **Execution Latency:** IPC (Inter-Process Communication) antara React frontend dan Rust backend < 5ms.

---

### **3. Target User & Use Cases**

* **Software Engineers & Developers:** Membutuhkan GUI client lokal kencang untuk kebutuhan query harian, skema eksplorasi, dan debugging tanpa menguras daya laptop atau RAM.
* **Database Administrators (DBA) & DevOps:** Mengelola beberapa instance database lokal maupun remote melalui koneksi terenkripsi dan SSH Tunneling.
* **Data Analysts:** Menjalankan *custom query* kompleks dan mengidentifikasi data menggunakan antarmuka tabel yang fleksibel dan cepat.

---

### **4. System Architecture & Tech Stack**

#### **4.1 System Diagram**
```text
┌─────────────────────────────────────────────────────────┐
│                    DBde Frontend                        │
│         React + TypeScript + Tailwind CSS               │
│   (Monaco Editor, TanStack Table, TanStack Virtual)    │
└───────────────────────────┬─────────────────────────────┘
                            │ Tauri v2 IPC Bridge
                            ▼
┌─────────────────────────────────────────────────────────┐
│                 DBde Desktop Backend                    │
│                      Tauri v2                           │
│  (Rust Core, State Connection Manager, Keyring Vault)   │
└──────┬────────────────────┬─────────────────────┬───────┘
       │ TCP / Driver       │ TCP / Driver        │ File I/O
       ▼                    ▼                     ▼
┌──────────────┐    ┌──────────────┐     ┌──────────────┐
│  PostgreSQL  │    │    MySQL     │     │    SQLite    │ ...
└──────────────┘    └──────────────┘     └──────────────┘
```

#### **4.2 Tech Stack Selection**
* **Desktop Shell:** Tauri v2
* **Backend Engine (Local Core):** Rust
  * `sqlx` (Asynchronous SQL driver for MySQL, PostgreSQL, SQLite)
  * `mongodb` (Async driver for MongoDB)
  * `keyring` (OS Native Credential Vault integration)
  * `tokio` (Async runtime)
  * `russh` / `ssh2` (SSH Tunneling & Port Forwarding)
* **Frontend Framework:** React 18 + TypeScript + Vite
* **UI Components & Styling:** Tailwind CSS, Lucide Icons, Shadcn UI
* **Editor & Data Grid:**
  * `@monaco-editor/react` (SQL Workspace with syntax highlighting & shortcuts)
  * `@tanstack/react-table` + `@tanstack/react-virtual` (Virtualized High-Performance Grid)
* **State Management:** Zustand

---

### **5. Functional Requirements & Specifications**

#### **5.1 Connection Manager & Security Module**
* **Multi-DB Connection Form:** Mendukung parameter Host, Port, Username, Password, Database Name, SSL Mode, serta File Path (khusus SQLite).
* **OS Keyring Integration:** Password database dan SSH private key tidak pernah disimpan dalam *plain text*. Disimpan secara terenkripsi melalui OS Credential Store (Windows Credential Manager, macOS Keychain, Linux Secret Service).
* **SSH Tunneling:** Fitur *port forwarding* terintegrasi untuk mengakses database di dalam Private Network/VPC melalui server bastion.
* **Ping / Test Connection:** Memvalidasi kredensial dan ketersediaan koneksi sebelum menyimpan profil ke dalam penyimpanan lokal.

#### **5.2 Database Explorer (Sidebar Tree)**
* **Lazy-Loaded Schema Tree:** Navigasi hirarkis dinamis: `Active Connection` $\rightarrow$ `Databases/Schemas` $\rightarrow$ `Tables/Collections` $\rightarrow$ `Columns/Indexes`. Data skema hanya di-fetch saat node di-expand.
* **Multi-Connection Active State:** Memungkinkan beberapa koneksi database dari tipe berbeda terbuka secara bersamaan di dalam sidebar.
* **Quick Actions:** Context menu (klik kanan) pada tabel untuk opsi: *View Data*, *Edit Structure*, *Truncate*, *Drop*, dan *Export Schema*.

#### **5.3 SQL & Command Query Workspace**
* **Multi-Tab Workspace:** Pengguna dapat membuka banyak tab query sekaligus dengan nama tab yang dapat diubah.
* **Monaco SQL Editor:**
  * Syntax Highlighting khusus Dialek SQL (MySQL, Postgres, SQLite, MongoDB Aggregations).
  * Auto-completion dasar untuk *keywords* SQL dan nama tabel/kolom yang sedang aktif.
  * Formatting / Beautify Query SQL.
* **Execution Shortcuts:** Penggunaan pintasan keyboard `Ctrl+Enter` / `Cmd+Enter` untuk mengeksekusi query aktif atau teks yang diblok/diseleksi.

#### **5.4 High-Performance Virtualized Data Grid**
* **Dynamic Table Column Rendering:** Kolom dan baris data dibentuk secara otomatis berbasis skema JSON yang diterima dari backend Rust.
* **DOM Virtualization:** Menggunakan `@tanstack/react-virtual` untuk me-render hanya elemen tabel yang terlihat di viewport monitor, memungkinkan pemrosesan 50.000+ baris data secara instan.
* **Execution Feedback Panel:** Menampilkan informasi *Execution Time* (ms), *Affected Rows*, total baris yang diambil, serta log error mendetail jika query gagal.

---

### **6. Tauri IPC API Contracts (Rust $\leftrightarrow$ React)**

| Command Name | Input Parameter | Output Response | Deskripsi |
| --- | --- | --- | --- |
| `dbde_test_connection` | `config: ConnectionConfig` | `Result<bool, String>` | Mengetes jalur koneksi database tanpa menyimpan profil. |
| `dbde_connect` | `config: ConnectionConfig` | `Result<String, String>` | Menginisialisasi pool koneksi dan mengembalikan `connection_id` (UUID). |
| `dbde_disconnect` | `connection_id: String` | `Result<(), String>` | Memutuskan pool koneksi aktif dan membebaskan RAM. |
| `dbde_get_schema_tree` | `connection_id: String` | `Result<SchemaTree, String>` | Mengambil struktur hierarki database, skema, dan tabel. |
| `dbde_execute_query` | `connection_id: String, query: String` | `Result<QueryResult, String>` | Menjalankan raw query SQL/Command dan mengembalikan dataset JSON. |

---

### **7. Non-Functional Requirements (NFRs)**

* **Performance & Stability:** Bebas dari *Memory Leak*. Memori harus langsung kembali netral (*idle*) setelah tab query besar ditutup atau koneksi diputus.
* **Portability:** Aplikasi bersifat *standalone/portable*. Dapat berjalan tanpa ketergantungan pada instalasi runtime eksternal (seperti Node.js, Python, atau Java JRE).
* **Crash Resilience:** Kegagalan atau query yang *timeout* pada database remote tidak boleh menyebabkan aplikasi GUI utama *crash* atau *unresponsive*.

---

### **8. Roadmap & Phased Development**

* **Phase 1 (MVP - Current Scope):**
  * Core Architecture Tauri v2 + React.
  * Dukungan dasar MySQL, PostgreSQL, dan SQLite.
  * Monaco Editor + Virtualized Data Grid.
  * Save Connection dengan OS Keyring.

* **Phase 2:**
  * Dukungan penuh MongoDB (Aggregation Pipeline GUI).
  * Fitur SSH Tunneling (Bastion Host).
  * Data Export / Import (CSV, JSON, Dump SQL).

* **Phase 3:**
  * Visual Table Structure Editor (DDL GUI Editor).
  * ER Diagram Viewer.