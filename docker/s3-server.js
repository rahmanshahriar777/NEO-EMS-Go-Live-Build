const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.S3_PORT || '9000', 10);
const HOST = process.env.S3_HOST || '127.0.0.1';
const DATA_DIR = process.env.MINIO_DATA_DIR || '/var/lib/minio/data';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'ems-documents'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'ems-avatars'), { recursive: true });

function parseXmlKeyList(xml) {
  const keys = [];
  const regex = /<Key>([^<]+)<\/Key>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  const parts = pathname.slice(1).split('/');
  const bucket = parts[0];
  const key = parts.slice(1).join('/');

  if (!bucket) {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
    return;
  }

  const bucketDir = path.join(DATA_DIR, bucket);

  // Bucket-level operations
  if (!key) {
    if (req.method === 'HEAD') {
      res.writeHead(fs.existsSync(bucketDir) ? 200 : 404);
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      fs.mkdirSync(bucketDir, { recursive: true });
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'POST' && url.searchParams.has('delete')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const keys = parseXmlKeyList(body);
        for (const k of keys) {
          const p = path.join(bucketDir, k);
          if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); } catch (_) {}
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('<DeleteResult></DeleteResult>');
      });
      return;
    }
    res.writeHead(200);
    res.end();
    return;
  }

  const filePath = path.join(bucketDir, key);

  // Object-level operations
  if (req.method === 'PUT') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const out = fs.createWriteStream(filePath);
    const hash = crypto.createHash('md5');
    req.on('data', chunk => {
      out.write(chunk);
      hash.update(chunk);
    });
    req.on('end', () => {
      out.end();
      const etag = hash.digest('hex');
      res.writeHead(200, {
        'ETag': `"${etag}"`,
        'Content-Type': 'text/plain',
        'Access-Control-Expose-Headers': 'ETag',
      });
      res.end();
    });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
      return;
    }
    const stat = fs.statSync(filePath);
    const range = req.headers.range;

    if (range && req.method === 'GET') {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
        const chunkLen = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkLen,
          'Content-Type': 'application/octet-stream',
          'Last-Modified': stat.mtime.toUTCString(),
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Last-Modified': stat.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  if (req.method === 'DELETE') {
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(200);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`🪣 Embedded S3 Object Storage listening on http://${HOST}:${PORT}`);
});
