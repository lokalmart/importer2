function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 32 * 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Request terlalu besar. Maksimum ${Math.round(maxBytes / 1024 / 1024)}MB.`));
        req.destroy();
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Body bukan JSON valid.'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { sendJson, readJsonBody };
