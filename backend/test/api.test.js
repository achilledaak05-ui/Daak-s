'use strict';
// Parcours complet à travers l'API, sur une vraie base MySQL de test (VIDÉE avant de commencer).
//   TEST_DATABASE_URL=mysql://root:@127.0.0.1:3306/ouvrage_test npm test
// Sans TEST_DATABASE_URL, ce fichier est ignoré.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const DB = process.env.TEST_DATABASE_URL;

test('parcours client → admin → prestataire', { skip: !DB && 'TEST_DATABASE_URL non défini' }, async (t) => {
  Object.assign(process.env, {
    DATABASE_URL: DB, JWT_SECRET: 'j'.repeat(40), DATA_KEY: 'd'.repeat(40),
    PAYMENT_WEBHOOK_SECRET: 'w'.repeat(40), PAYMENTS_MODE: 'sandbox', DB_SSL_CA: '',
  });
  const mysql = require('mysql2/promise');
  const { connectionOptions } = require('../src/db');
  const conn = await mysql.createConnection(connectionOptions(DB, null));
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const [row] of (await conn.query('SHOW TABLES'))[0].map((r) => Object.values(r))) await conn.query(`DROP TABLE \`${row}\``);
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  await conn.end();
  const root = path.join(__dirname, '..');
  execFileSync('node', ['scripts/migrate.js'], { cwd: root, env: process.env });
  const out = execFileSync('node', ['scripts/create-admin.js', 'admin@test.ci', 'Ada', 'Admin', 'motdepasse-admin-123'], { cwd: root, env: process.env }).toString();
  const secret = /Secret : (\w+)/.exec(out)[1];

  const app = require('../src/app');
  const server = app.listen(0);
  t.after(async () => { server.close(); await require('../src/db').close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  async function call(space, token, method, p, body, expect) {
    const isForm = body instanceof FormData;
    const res = await fetch(`${base}/${space}${p}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const data = res.status === 204 ? null : await res.json();
    if (expect !== undefined) assert.equal(res.status, expect, `${method} ${space}${p} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  }

  // Inscriptions
  const client = await call('client', null, 'POST', '/auth/register', {
    firstName: 'Kofi', lastName: 'Yao', contact: 'kofi@test.ci', password: 'secret-client', city: 'Abidjan', zone: 'Cocody',
  }, 201);
  const pro = await call('pro', null, 'POST', '/auth/register', {
    firstName: 'Mariam', lastName: 'Traoré', contact: '+2250700000001', password: 'secret-pro-1', city: 'Abidjan',
    trades: ['Plomberie'], zones: ['Cocody'], basePrice: 15000,
  }, 201);
  await call('client', null, 'POST', '/auth/register', { firstName: 'X', lastName: 'Y', contact: 'KOFI@test.ci', password: 'secret-client', city: 'Abidjan' }, 409);

  // Cloisonnement : le jeton client ne marche pas côté pro, le compte client ne se connecte pas côté pro
  await call('pro', client.accessToken, 'GET', '/me', undefined, 401);
  await call('pro', null, 'POST', '/auth/login', { contact: 'kofi@test.ci', password: 'secret-client' }, 401);

  // Le prestataire non validé ne voit pas l'annuaire ni les demandes
  await call('pro', pro.accessToken, 'GET', '/requests', undefined, 403);
  assert.equal((await call('client', client.accessToken, 'GET', '/pros', undefined, 200)).items.length, 0);

  // Pièces justificatives
  for (const kind of ['cni', 'naiss']) {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'piece.pdf');
    await call('pro', pro.accessToken, 'POST', '/me/documents', fd, 201);
  }
  const bad = new FormData();
  bad.append('kind', 'cni');
  bad.append('file', new Blob(['<script>']), 'x.pdf');
  await call('pro', pro.accessToken, 'POST', '/me/documents', bad, 400);
  assert.deepEqual((await call('pro', pro.accessToken, 'GET', '/me/verification', undefined, 200)).missing, []);

  // Administration : connexion en deux étapes
  const step1 = await call('admin', null, 'POST', '/auth/login', { contact: 'admin@test.ci', password: 'motdepasse-admin-123' }, 401);
  assert.equal(step1.error.code, 'mfa_required');
  const { codeAt, base32Decode } = require('../src/lib/totp');
  const totp = codeAt(base32Decode(secret), Math.floor(Date.now() / 30000));
  const admin = await call('admin', null, 'POST', '/auth/login', { contact: 'admin@test.ci', password: 'motdepasse-admin-123', totp }, 200);
  const A = admin.accessToken;
  await call('admin', client.accessToken, 'GET', '/dashboard', undefined, 401);

  const doc = await fetch(`${base}/admin/pros/${pro.user.id}/documents/cni`, { headers: { Authorization: `Bearer ${A}` } });
  assert.equal(await doc.text(), '%PDF-1.4 test');
  await call('admin', A, 'POST', `/pros/${pro.user.id}/decision`, { decision: 'valide' }, 200);

  // Demande du client → distribution → offre → choix → paiement (sandbox) → mission → confirmation → avis
  const reqd = await call('client', client.accessToken, 'POST', '/requests', {
    trade: 'Plomberie', title: 'Fuite évier', description: 'Fuite sous l\'évier de la cuisine', address: 'Rue 12, Cocody', zone: 'Cocody', urgency: 'semaine',
  }, 201);
  assert.equal(reqd.ref, `DEM-${reqd.id}`);
  assert.equal((await call('admin', A, 'POST', `/requests/${reqd.id}/distribute`, undefined, 200)).sent, 1);
  const received = await call('pro', pro.accessToken, 'GET', '/requests', undefined, 200);
  assert.equal(received.items[0].address, null); // adresse cachée avant le choix
  await call('pro', pro.accessToken, 'POST', `/requests/${reqd.id}/offer`, { price: 20000, message: 'Dispo demain' }, 201);
  const detail = await call('client', client.accessToken, 'GET', `/requests/${reqd.id}`, undefined, 200);
  assert.equal(detail.offers[0].price, 20000);
  const { bookingId } = await call('client', client.accessToken, 'POST', `/requests/${reqd.id}/choose`, { proId: pro.user.id }, 201);

  await call('pro', pro.accessToken, 'POST', `/bookings/${bookingId}/start`, undefined, 409); // pas encore payé
  const paid = await call('client', client.accessToken, 'POST', `/bookings/${bookingId}/payments`, { method: 'Wave' }, 201);
  assert.equal(paid.booking.status, 'payee');
  await call('pro', pro.accessToken, 'POST', `/bookings/${bookingId}/start`, undefined, 200);
  await call('pro', pro.accessToken, 'POST', `/bookings/${bookingId}/messages`, { body: 'J\'arrive' }, 201);
  const msgs = await call('client', client.accessToken, 'GET', `/bookings/${bookingId}/messages`, undefined, 200);
  assert.deepEqual(msgs.items.map((m) => [m.body, m.mine]), [['J\'arrive', false]]);
  await call('pro', pro.accessToken, 'POST', `/bookings/${bookingId}/finish`, undefined, 200);
  assert.equal((await call('client', client.accessToken, 'POST', `/bookings/${bookingId}/confirm`, undefined, 200)).status, 'terminee');
  await call('client', client.accessToken, 'POST', `/bookings/${bookingId}/review`, { rating: 5, comment: 'Parfait' }, 201);
  await call('client', client.accessToken, 'POST', `/bookings/${bookingId}/review`, { rating: 1, comment: 'Encore' }, 409);

  // Portefeuille : 20 000 - 15 % = 17 000 ; retrait puis traitement par l'admin
  const wallet = await call('pro', pro.accessToken, 'GET', '/wallet', undefined, 200);
  assert.equal(wallet.available, 17000);
  await call('pro', pro.accessToken, 'POST', '/wallet/withdrawals', { amount: 18000, method: 'Wave', number: '0700000001' }, 400);
  const w = await call('pro', pro.accessToken, 'POST', '/wallet/withdrawals', { amount: 10000, method: 'Wave', number: '0700000001' }, 201);
  assert.equal((await call('pro', pro.accessToken, 'GET', '/wallet', undefined, 200)).available, 7000);
  const pending = await call('admin', A, 'GET', '/withdrawals?status=demande', undefined, 200);
  assert.equal(pending.items[0].number, '0700000001'); // déchiffré pour l'admin
  await call('admin', A, 'POST', `/withdrawals/${w.id}/start`, undefined, 200);
  await call('admin', A, 'POST', `/withdrawals/${w.id}/paid`, undefined, 200);

  // Réservation directe au prix du profil, puis litige tranché pour le client
  const direct = await call('client', client.accessToken, 'POST', '/bookings', {
    proId: pro.user.id, trade: 'Plomberie', service: 'Débouchage', mode: 'immediat', address: 'Rue 12', description: 'Évier bouché',
  }, 201);
  assert.equal(direct.price, 15000);
  await call('pro', pro.accessToken, 'POST', `/bookings/${direct.id}/accept`, undefined, 200);
  await call('client', client.accessToken, 'POST', `/bookings/${direct.id}/payments`, { method: 'Orange Money' }, 201);
  await call('pro', pro.accessToken, 'POST', `/bookings/${direct.id}/start`, undefined, 200);
  await call('pro', pro.accessToken, 'POST', `/bookings/${direct.id}/finish`, undefined, 200);
  await call('client', client.accessToken, 'POST', `/bookings/${direct.id}/dispute`, { type: 'Prestation non conforme', description: 'Toujours bouché après passage' }, 200);
  const disputes = await call('admin', A, 'GET', '/disputes', undefined, 200);
  await call('admin', A, 'POST', `/disputes/${disputes.items[0].id}/decide`, { decision: 'client', motif: 'Travaux non conformes' }, 200);
  assert.equal((await call('admin', A, 'GET', '/refunds', undefined, 200)).items[0].status, 'refund_pending');
  await call('admin', A, 'POST', `/bookings/${direct.id}/refunded`, undefined, 200);

  // Support et notifications
  await call('client', client.accessToken, 'POST', '/support/messages', { body: 'Bonjour, une question' }, 201);
  const threads = await call('admin', A, 'GET', '/support', undefined, 200);
  assert.ok(threads.items[0].awaitingReply);
  await call('admin', A, 'POST', `/support/${client.user.id}/messages`, { body: 'Bonjour, comment aider ?' }, 201);
  const notifs = await call('client', client.accessToken, 'GET', '/notifications', undefined, 200);
  assert.ok(notifs.unread > 0);
  await call('client', client.accessToken, 'POST', '/notifications/read', undefined, 204);

  const dash = await call('admin', A, 'GET', '/dashboard', undefined, 200);
  assert.equal(dash.missionsDone, 1);
  assert.equal(dash.commissions, 3000);

  // Rotation du refresh token et détection de rejeu
  const r1 = await call('client', null, 'POST', '/auth/refresh', { refreshToken: client.refreshToken }, 200);
  await call('client', null, 'POST', '/auth/refresh', { refreshToken: client.refreshToken }, 401);
  await call('client', null, 'POST', '/auth/refresh', { refreshToken: r1.refreshToken }, 401); // toutes révoquées après rejeu

  // Suspension
  await call('admin', A, 'POST', `/users/${client.user.id}/suspend`, { motif: 'Test de suspension' }, 200);
  const login = await call('client', null, 'POST', '/auth/login', { contact: 'kofi@test.ci', password: 'secret-client' }, 401);
  assert.equal(login.error.code, 'account_suspended');

  // Erreur de validation lisible
  const v = await call('client', null, 'POST', '/auth/register', { firstName: 'A' }, 400);
  assert.equal(v.error.code, 'validation_error');
});
