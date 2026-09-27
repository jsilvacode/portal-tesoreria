const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('registration retains form reference after the asynchronous response', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const begin = source.indexOf('$("#register-form").addEventListener');
  const end = source.indexOf('$$("[data-show-register]")', begin);
  let handler, reset = false, mode, resolve;
  const messages = [];
  const button = {disabled: false};
  const form = {querySelector: () => button, reset: () => {reset = true;}};
  const context = {
    $: () => ({addEventListener: (_, callback) => {handler = callback;}}),
    FormData: class {get() {return 'synthetic';}},
    api: () => new Promise(done => {resolve = done;}),
    setAuthMode: value => {mode = value;},
    toast: (...args) => messages.push(args),
  };
  vm.runInNewContext(source.slice(begin, end), context);
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
});
