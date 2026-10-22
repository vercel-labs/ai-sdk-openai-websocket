import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createWebSocketFetch } from '../dist/index.js';

const endpoint = 'https://example.test/v1/responses';
const options = { timeout: 5000 };

function request(fetch, authorization, input, signal) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: authorization },
    body: JSON.stringify({ stream: true, input }),
    signal,
  });
}

function complete(record, input) {
  record.socket.send(JSON.stringify({
    type: 'response.completed',
    response: { authorization: record.authorization, input },
  }));
}

function events(text) {
  return text.split('\n')
    .filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6)));
}

async function fixture(t, { deferred = false, onRequest } = {}) {
  const changes = new EventEmitter();
  const handshakes = [];
  const connections = [];
  const received = [];
  const closed = [];
  const transports = new Set();
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient(info, done) {
      const transport = info.req.socket;
      transports.add(transport);
      transport.once('close', () => transports.delete(transport));
      handshakes.push({
        authorization: info.req.headers.authorization,
        accept: () => done(true),
        reject: () => done(false, 401),
      });
      changes.emit('handshakes');
      if (!deferred) done(true);
    },
  });
  server.on('connection', (socket, req) => {
    const record = { socket, authorization: req.headers.authorization };
    connections.push(record);
    changes.emit('connections');
    socket.on('close', () => {
      closed.push(record);
      changes.emit('closed');
    });
    socket.on('message', raw => {
      const body = JSON.parse(raw.toString());
      received.push({ record, body });
      changes.emit('received');
      if (onRequest) onRequest(record, body);
      else complete(record, body.input);
    });
  });
  await once(server, 'listening');
  const fetch = createWebSocketFetch({
    url: `ws://127.0.0.1:${server.address().port}/responses`,
  });
  t.after(async () => {
    fetch.close();
    for (const socket of server.clients) socket.terminate();
    for (const transport of transports) transport.destroy();
    await new Promise((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  });

  const observed = { handshakes, connections, received, closed };
  async function waitFor(name, count) {
    while (observed[name].length < count) await once(changes, name);
    return observed[name];
  }
  return { fetch, ...observed, waitFor };
}

test('reuses an idle socket for the same credential', options, async t => {
  const f = await fixture(t);
  for (const input of ['first', 'second']) {
    const response = await request(f.fetch, 'test-credential-a', input);
    assert.deepEqual(events(await response.text()), [{
      type: 'response.completed',
      response: { authorization: 'test-credential-a', input },
    }]);
  }
  assert.equal(f.connections.length, 1);
});

test('switches credentials without retaining the previous idle socket', options, async t => {
  const f = await fixture(t);
  for (const authorization of ['test-credential-a', 'test-credential-b', '']) {
    const response = await request(f.fetch, authorization, 'input');
    assert.equal(events(await response.text())[0].response.authorization, authorization);
  }
  assert.deepEqual(f.handshakes.map(h => h.authorization), [
    'test-credential-a', 'test-credential-b', '',
  ]);
  await f.waitFor('closed', 2);
});

for (const secondCredential of ['test-credential-a', 'test-credential-b']) {
  test(`reserves pending handshakes (${secondCredential})`, options, async t => {
    const f = await fixture(t, { deferred: true });
    const first = request(f.fetch, 'test-credential-a', 'first');
    const second = request(f.fetch, secondCredential, 'second');
    await f.waitFor('handshakes', 2);
    for (const handshake of f.handshakes) handshake.accept();
    const responses = await Promise.all([first, second]);
    const results = await Promise.all(responses.map(response => response.text()));
    assert.deepEqual(results.map(text => events(text)[0].response), [
      { authorization: 'test-credential-a', input: 'first' },
      { authorization: secondCredential, input: 'second' },
    ]);
    assert.equal(f.connections.length, 2);
  });
}

test('reserves an open socket before concurrent callers can reuse it', options, async t => {
  const f = await fixture(t, {
    onRequest(record, body) {
      if (body.input === 'warm') complete(record, body.input);
    },
  });
  await (await request(f.fetch, 'test-credential-a', 'warm')).text();
  const first = request(f.fetch, 'test-credential-a', 'first');
  const second = request(f.fetch, 'test-credential-a', 'second');
  await f.waitFor('received', 3);
  for (const { record, body } of f.received.slice(1)) complete(record, body.input);
  const responses = await Promise.all([first, second]);
  const results = await Promise.all(responses.map(response => response.text()));
  assert.deepEqual(results.map(text => events(text)[0].response.input), ['first', 'second']);
  assert.ok(results.every(text => events(text).length === 1));
  assert.equal(f.connections.length, 2);
});

test('finishing an older request leaves the newer cached socket reusable', options, async t => {
  const f = await fixture(t, {
    onRequest(record, body) {
      if (body.input === 'reuse') complete(record, body.input);
    },
  });
  const first = await request(f.fetch, 'test-credential-a', 'first');
  const second = await request(f.fetch, 'test-credential-b', 'second');
  await f.waitFor('received', 2);
  complete(f.received[1].record, 'second');
  await second.text();
  complete(f.received[0].record, 'first');
  await first.text();
  await f.waitFor('closed', 1);
  const reused = await request(f.fetch, 'test-credential-b', 'reuse');
  assert.equal(events(await reused.text())[0].response.input, 'reuse');
  assert.equal(f.connections.length, 2);
});

test('cancelling a stream discards its socket before the next request', options, async t => {
  const f = await fixture(t, {
    onRequest(record, body) {
      if (body.input === 'next') complete(record, body.input);
    },
  });
  const cancelled = await request(f.fetch, 'test-credential-a', 'cancel');
  await f.waitFor('received', 1);
  await cancelled.body.cancel();
  const next = await request(f.fetch, 'test-credential-a', 'next');
  assert.equal(events(await next.text())[0].response.input, 'next');
  assert.equal(f.connections.length, 2);
});

test('aborting a stream discards its socket', options, async t => {
  const f = await fixture(t, {
    onRequest(record, body) {
      if (body.input === 'next') complete(record, body.input);
    },
  });
  const controller = new AbortController();
  const response = await request(f.fetch, 'test-credential-a', 'abort', controller.signal);
  await f.waitFor('received', 1);
  controller.abort();
  await assert.rejects(response.text(), { name: 'AbortError' });
  const next = await request(f.fetch, 'test-credential-a', 'next');
  await next.text();
  assert.equal(f.connections.length, 2);
});

test('a completed request cannot abort the next owner of its socket', options, async t => {
  const f = await fixture(t, {
    onRequest(record, body) {
      if (body.input === 'first') complete(record, body.input);
    },
  });
  const controller = new AbortController();
  await (await request(f.fetch, 'test-credential-a', 'first', controller.signal)).text();
  const next = await request(f.fetch, 'test-credential-a', 'next');
  await f.waitFor('received', 2);
  controller.abort();
  complete(f.received[1].record, 'next');
  assert.equal(events(await next.text())[0].response.input, 'next');
  assert.equal(f.connections.length, 1);
});

test('close shuts down every active socket', options, async t => {
  const f = await fixture(t, { onRequest() {} });
  const first = await request(f.fetch, 'test-credential-a', 'first');
  const second = await request(f.fetch, 'test-credential-b', 'second');
  await f.waitFor('received', 2);
  f.fetch.close();
  await Promise.all([first.text(), second.text()]);
  await f.waitFor('closed', 2);
});

test('close rejects pending handshakes and the wrapper can reconnect', options, async t => {
  const f = await fixture(t, { deferred: true });
  const pending = Promise.allSettled([
    request(f.fetch, 'test-credential-a', 'first'),
    request(f.fetch, 'test-credential-b', 'second'),
  ]);
  await f.waitFor('handshakes', 2);
  f.fetch.close();
  const results = await pending;
  assert.ok(results.every(result => result.status === 'rejected'));
  const next = request(f.fetch, 'test-credential-b', 'next');
  await f.waitFor('handshakes', 3);
  f.handshakes[2].accept();
  assert.equal(events(await (await next).text())[0].response.input, 'next');
});

test('a rejected handshake does not prevent subsequent connections', options, async t => {
  const f = await fixture(t, { deferred: true });
  const first = assert.rejects(request(f.fetch, 'test-credential-a', 'first'));
  await f.waitFor('handshakes', 1);
  f.handshakes[0].reject();
  await first;
  const next = request(f.fetch, 'test-credential-a', 'next');
  await f.waitFor('handshakes', 2);
  f.handshakes[1].accept();
  assert.equal(events(await (await next).text())[0].response.input, 'next');
});

test('non-WebSocket requests still use the standard fetch', options, async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return new Response('fallback');
  });
  const fetch = createWebSocketFetch();
  t.after(() => fetch.close());
  const cases = [
    [endpoint, { method: 'GET' }],
    ['https://example.test/v1/chat/completions', { method: 'POST' }],
    [endpoint, { method: 'POST', body: 'not json' }],
    [endpoint, { method: 'POST', body: JSON.stringify({ stream: false }) }],
  ];
  for (const args of cases) assert.equal(await (await fetch(...args)).text(), 'fallback');
  assert.deepEqual(calls, cases);
});
