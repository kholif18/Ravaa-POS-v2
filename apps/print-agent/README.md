# print-agent

Bridge kecil (tanpa dependencies) dari web kasir ke printer thermal 58mm ESC/POS.
Wajib jalan di **PC kasir** (bukan di server), karena yang punya colokan USB printer.

```bash
cd apps/print-agent
AGENT_PORT=9100 PRINTER_PATH=/dev/usb/lp0 npm start
curl localhost:9100/health
```

* Linux: tambahkan user ke grup `lp` agar bisa tulis ke `/dev/usb/lp0`.
* Windows: isi `PRINTER_PATH` ke port printer (misal mode USB-serial `COM3`),
  atau share printer sebagai RAW lalu arahkan ke path tersebut.
* Android fallback: agent tidak ada -> web otomatis tampilkan modal struk
  (tombol Cetak browser / Share). Untuk cetak langsung dari HP, pakai printer
  combo USB+Bluetooth dan aplikasi RawBT.
* Bila printer tidak ketemu, bytes struk disimpan di `out/receipt-<ts>.bin`.
