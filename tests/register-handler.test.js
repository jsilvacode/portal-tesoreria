const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/app.js', 'utf8');
const identityFunctions = source.slice(source.indexOf('function normalizePersonName('), source.indexOf('function matchesSearch('));

test('registration retains form reference after the asynchronous response', async () => {
  const begin = source.indexOf('$("#register-form").addEventListener');
  const end = source.indexOf('$$("[data-show-register]")', begin);
  let handler, reset = false, mode, resolve, payload;
  const messages = [];
  const button = {disabled: false};
  const form = {querySelector: () => button, reset: () => {reset = true;}};
  const context = {
    $: selector => ({addEventListener: (_, callback) => {if (selector === '#register-form') handler = callback;}}),
    FormData: class {get(key) {return key === 'name' ? '  JOSÉ  péREZ ' : 'synthetic';}},
    api: (_, options) => {payload = JSON.parse(options.body); return new Promise(done => {resolve = done;});},
    setAuthMode: value => {mode = value;},
    toast: (...args) => messages.push(args),
  };
  vm.runInNewContext(identityFunctions + source.slice(begin, end), context);
  const event = {currentTarget: form, preventDefault() {}};
  const pending = handler(event);
  // Browsers clear currentTarget when synchronous event dispatch finishes.
  event.currentTarget = null;
  resolve({message: 'Solicitud enviada'});
  await pending;
  assert.equal(reset, true);
  assert.equal(mode, 'login');
  assert.equal(messages[0][1], 'success');
  assert.equal(button.disabled, false);
  assert.equal(payload.name, 'José Pérez');
});

test('session identity displays only name and department and escapes markup', () => {
  const badge = {innerHTML: ''};
  const escaping = source.slice(source.indexOf('function escapeHTML('), source.indexOf('function normalizedSearch('));
  const context = {$: () => badge};
  vm.runInNewContext(escaping + identityFunctions, context);
  context.renderUserIdentity({full_name: 'José Pérez', email: 'hidden@example.test', department_name: 'Escuela Sabática'});
  assert.equal(badge.innerHTML, '<span class="user-name">José Pérez</span><span class="user-department">Escuela Sabática</span>');
  assert.ok(!badge.innerHTML.includes('hidden@example.test'));
  context.renderUserIdentity({full_name: '<script>', department_name: 'A & B'});
  assert.ok(badge.innerHTML.includes('&lt;script&gt;'));
  assert.ok(badge.innerHTML.includes('A &amp; B'));
  context.renderUserIdentity({is_superuser: true, department_name: 'Previous department'});
  assert.ok(badge.innerHTML.includes('Superusuario'));
  assert.ok(!badge.innerHTML.includes('Previous department'));
});

test('browser name normalization preserves accents, hyphens and apostrophes', () => {
  const context = {};
  vm.runInNewContext(identityFunctions, context);
  assert.equal(context.normalizePersonName(' marÍA-josÉ  o’CONNOR '), 'María-José O’Connor');
  assert.equal(context.normalizePersonName('jose\u0301 pérez'), 'José Pérez');
});

test('superuser has administrative access while retaining its distinct role', () => {
  const context = {};
  vm.runInNewContext(identityFunctions, context);
  assert.equal(context.hasAdminAccess({role: 'superuser', is_superuser: true}), true);
  assert.equal(context.userDepartmentLabel({role: 'superuser', is_superuser: true}), 'Superusuario');
  assert.equal(context.hasAdminAccess({role: 'treasurer'}), true);
  assert.equal(context.userDepartmentLabel({role: 'treasurer'}), 'Tesorería');
  assert.equal(context.hasAdminAccess({role: 'department'}), false);
  assert.equal(context.hasAdminAccess(null), false);
});
