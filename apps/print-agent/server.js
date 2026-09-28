// Ravaa print-agent — tanpa dependencies (http + fs bawaan Node).
// Web kasir POST { data_base64 } ke http://localhost:9100/print
// lalu bytes ESC/POS diteruskan ke printer thermal 58mm.
//
// Target printer (prioritas):
//   1. PRINTER_PATH env (cth: /dev/usb/lp0 di Linux, //./COM3 di Windows adaptor USB-serial)
//   2. /dev/usb/lp0 (Linux USB thermal umum, termasuk Kassen/Xprinter mode RAW)
//   3. fallback: simpan ke ./out/receipt-<ts>.bin agar bisa dicetak manual via CUPS
//
// Linux: pastikan user masuk grup lp:  sudo usermod -aG lp $USER  (lalu relogin)
// Alternatif CUPS: tambahkan printer sebagai RAW, lalu set PRINTER_PATH=/dev/usb/lp0 tetap bisa.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.AGENT_PORT || 9100);
const OUT_DIR = path.join(__dirname, 'out');

function pickPrinter() {
  if (process.env.PRINTER_PATH && fs.existsSync(process.env.PRINTER_PATH)) {
    return process.env.PRINTER_PATH;
  }
  if (fs.existsSync('/dev/usb/lp0')) return '/dev/usb/lp0';
  return null;
}

function send(port, req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
  req.on('end', () => {
    try {
      const { data_base64: b64 } = JSON.parse(body || '{}');
      if (!b64) { res.writeHead(400); return res.end(JSON.stringify({ error: 'data_base64 wajib' })); }
      const buf = Buffer.from(b64, 'base64');
      const printer = pickPrinter();
      if (printer) {
        fs.writeFileSync(printer, buf); // tulis langsung ke device USB (mode RAW)
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, via: printer }));
      }
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const f = path.join(OUT_DIR, `receipt-${Date.now()}.bin`);
      fs.writeFileSync(f, buf);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, via: 'file', file: f, note: 'printer tidak ditemukan, tersimpan sebagai file' }));
    } catch (e) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, printer: pickPrinter() }));
  }
  if (req.method === 'POST' && req.url === '/print') return send(PORT, req, res);
  res.writeHead(404);
  return res.end(JSON.stringify({ error: 'gunakan POST /print atau GET /health' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`print-agent :${PORT} printer=${pickPrinter() || '(belum ketemu, mode file)'}`);
  console.log(`tes: curl localhost:${PORT}/health`);
});
