const { simplifyError } = require('./errors');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }


function photoItemsFromRows(rows) {
  const out = [];
  for (const row of rows) {
    const imageUrl = row.image_url || row.photo_url || row.image_1920_url || row.product_image_url || row.main_image_url;
    const recordExternalId = row.record_external_id || row.product_tmpl_id_external_id || row.target_external_id || row._target_external_id;
    if (!imageUrl && !recordExternalId) continue;
    out.push({
      rownum: row.__rownum,
      queue_external_id: row._external_id || '',
      model: row.model || row.target_model || 'product.template',
      record_external_id: recordExternalId,
      image_url: imageUrl,
      image_field: row.image_field || 'image_1920',
      image_alt: row.image_alt || '',
      image_note: row.image_note || row.note || ''
    });
  }
  return out;
}

async function importPhotoBatch({ odoo, sheet, rows, options = {} }) {
  const items = photoItemsFromRows(rows);
  const report = {
    sheet,
    model: 'photo_import_queue',
    rows: rows.length,
    queued: items.length,
    processed: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    target_found: 0,
    target_missing: 0,
    download_failed: 0,
    write_failed: 0,
    results: []
  };

  for (const item of items) {
    const result = { row: item.rownum, product: item.record_external_id, image_url: item.image_url, status: 'WAITING' };
    try {
      if (!item.record_external_id) {
        result.status = 'SKIPPED';
        result.message = 'record_external_id kosong.';
        report.skipped++;
        report.results.push(result);
        continue;
      }
      if (!item.image_url) {
        result.status = 'SKIPPED';
        result.message = 'image_url kosong.';
        report.skipped++;
        report.results.push(result);
        continue;
      }

      result.status = 'TARGET_CHECKING';
      const target = await odoo.findExternalId(item.record_external_id);
      if (!target) {
        result.status = 'TARGET_NOT_FOUND';
        result.message = `Produk tidak ditemukan: ${item.record_external_id}`;
        report.target_missing++;
        report.failed++;
        report.results.push(result);
        continue;
      }
      report.target_found++;

      result.status = 'DOWNLOADING';
      const imageBuffer = await downloadImage(item.image_url, options);

      result.status = 'WRITING';
      const base64 = imageBuffer.toString('base64');
      await odoo.write(item.model || target.model || 'product.template', [Number(target.res_id)], {
        [item.image_field || 'image_1920']: base64
      });

      result.status = 'DONE';
      result.message = `${item.image_field || 'image_1920'} updated`;
      report.done++;
    } catch (err) {
      const simple = simplifyError(err);
      result.status = /download|fetch|HTTP|image/i.test(simple.message + ' ' + simple.detail) ? 'DOWNLOAD_FAILED' : 'ERROR';
      result.message = simple.message;
      result.detail = simple.detail;
      if (result.status === 'DOWNLOAD_FAILED') report.download_failed++;
      else report.write_failed++;
      report.failed++;
      if (!options.continueOnError) {
        report.results.push(result);
        break;
      }
    }
    report.processed++;
    report.results.push(result);
    const delayMs = Number(options.imageDelayMs || 0);
    if (delayMs > 0) await sleep(delayMs);
  }

  return report;
}

async function downloadImage(url, options = {}) {
  const timeoutMs = Number(options.imageTimeoutMs || 20000);
  const maxBytes = Number(options.maxImageBytes || 5 * 1024 * 1024);
  const retryAttempts = Number(options.imageRetryAttempts ?? 3);
  const retryBaseDelayMs = Number(options.imageRetryBaseDelayMs || 1200);
  const userAgent = options.imageUserAgent || 'LokalmartImporterStudio/1.0.3 (photo import; contact: admin@lokalmart.local)';
  let lastErr = null;

  for (let attempt = 0; attempt <= retryAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Cache-Control': 'no-cache'
        }
      });

      if (!res.ok) {
        const retryable = [408, 409, 425, 429, 500, 502, 503, 504].includes(res.status);
        if (retryable && attempt < retryAttempts) {
          const retryAfter = Number(res.headers.get('retry-after') || 0);
          const delay = retryAfter ? retryAfter * 1000 : retryBaseDelayMs * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw new Error(`Gagal download image_url: HTTP ${res.status}`);
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType && !/^image\//i.test(contentType)) {
        throw new Error(`URL bukan image content-type: ${contentType}`);
      }
      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxBytes) throw new Error(`Ukuran gambar terlalu besar: ${ab.byteLength} bytes`);
      return Buffer.from(ab);
    } catch (err) {
      lastErr = err;
      if (attempt < retryAttempts && /abort|timeout|fetch|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(String(err && err.message))) {
        await sleep(retryBaseDelayMs * Math.pow(2, attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Gagal download image_url.');
}

module.exports = { importPhotoBatch, photoItemsFromRows };
