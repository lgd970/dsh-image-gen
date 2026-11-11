import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

test('registers tools and generates and edits through a local relay', async () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'test-model', supported_endpoint_types: ['image-generation'] }] } : { data: [{ b64_json: png.toString('base64') }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-image-test-'));
  try {
    const tools = new Map();
    apply({ tools: { register: tool => tools.set(tool.name, tool) } }, { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-key', outputDir: dir });
    assert.deepEqual([...tools.keys()], ['image_generate', 'image_edit', 'image_models']);
    const generated = await tools.get('image_generate').execute({ prompt: 'test' });
    assert.equal(generated.ok, true, generated.message);
    assert.deepEqual(await readFile(generated.files[0].file), png);
    const input = path.join(dir, 'input.png');
    await writeFile(input, png);
    const edited = await tools.get('image_edit').execute({ prompt: 'edit', images: [input], outputPath: path.join(dir, 'edited.png') });
    assert.equal(edited.ok, true, edited.message);
    assert.deepEqual(await readFile(edited.files[0].file), png);
    const models = await tools.get('image_models').execute({});
    assert.equal(models.ok, true, models.message);
    assert.deepEqual(models.models, ['test-model']);
    assert.deepEqual(seen.map(x => x.url), ['/v1/images/generations', '/v1/images/edits', '/v1/models']);
    assert.ok(seen.every(x => x.authorization === 'Bearer test-key'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
