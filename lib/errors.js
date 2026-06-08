function simplifyError(err) {
  const raw = String(err && (err.stack || err.message || err) || 'Unknown error');
  const compact = raw.replace(/\s+/g, ' ').trim();

  const rules = [
    [/Changing the type of a field is not yet supported/i, 'Odoo menolak perubahan tipe field. Field custom sudah ada dengan tipe berbeda; lewati field itu atau buat nama field baru.'],
    [/External ID.*not found|External ID.*tidak ditemukan|not enough values to unpack/i, 'Relasi External ID tidak ditemukan atau format relasi tidak valid. Pastikan record induk sudah diimport lebih dulu.'],
    [/Access Denied|not allowed|You are not allowed/i, 'Akses ditolak. Pastikan user Odoo punya hak create/write untuk model ini atau ACL custom model sudah dibuat.'],
    [/Invalid field/i, 'Ada kolom/field yang tidak ada di model target. Jalankan preflight atau hapus kolom tersebut.'],
    [/required/i, 'Ada field wajib yang belum diisi atau relasi wajib belum ditemukan.'],
    [/timeout|ETIMEDOUT|ECONNRESET/i, 'Koneksi timeout atau terputus. Kurangi batch size atau coba ulang batch ini.'],
    [/duplicate key|already exists|Barcode\(s\) already assigned/i, 'Data duplikat, kemungkinan barcode/nama unik/external ID sudah ada. Gunakan upsert atau perbaiki nilai unik.']
  ];

  for (const [pattern, message] of rules) {
    if (pattern.test(compact)) return { message, detail: compact.slice(0, 3000) };
  }
  return { message: compact.slice(0, 500) || 'Error tidak diketahui.', detail: compact.slice(0, 3000) };
}

module.exports = { simplifyError };
