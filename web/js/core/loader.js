function notFound(path) {
  const err = new Error(`Data file not found: ${path}`);
  err.notFound = true;
  return err;
}

export function browserLoader(baseUrl = 'data/') {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return async function load(path, kind = 'json') {
    const res = await fetch(base + path);
    if (res.status === 404) throw notFound(path);
    if (!res.ok) throw new Error(`Failed to load ${path}: HTTP ${res.status}`);
    if (kind === 'json') return res.json();
    if (kind === 'bin') return res.arrayBuffer();
    if (kind === 'gz') {
      const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).arrayBuffer();
    }
    throw new Error(`Unknown loader kind: ${kind}`);
  };
}

export function nodeLoader(baseDir) {
  return async function load(path, kind = 'json') {
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    let buf;
    try {
      buf = await fs.readFile(nodePath.join(baseDir, path));
    } catch (e) {
      if (e.code === 'ENOENT') throw notFound(path);
      throw e;
    }
    if (kind === 'json') return JSON.parse(buf.toString('utf8'));
    if (kind === 'gz') {
      const zlib = await import('node:zlib');
      buf = zlib.gunzipSync(buf);
    }
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };
}
