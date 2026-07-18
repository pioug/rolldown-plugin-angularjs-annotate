const assert = require('node:assert');
const { minifySync } = require('rolldown/utils');
const angularjsAnnotate = require('..');

function transform(code, settings = {}) {
  const warnings = [];
  const plugin = angularjsAnnotate(settings.options);
  const result = plugin.transform.handler.call({
    warn(log, position) {
      warnings.push({ log, position });
    },
  }, code, settings.id || 'fixture.js', settings.meta);

  return {
    code: result ? result.code.toString() : code,
    warnings,
  };
}

function compact(code, id = 'fixture.js') {
  return minifySync(id, code, { compress: false, mangle: false }).code;
}

function assertTransform(input, expected, settings) {
  const actual = transform(input, settings).code;
  const id = settings?.id || 'fixture.js';
  assert.equal(compact(actual, id), compact(expected, id));
}

module.exports = { assertTransform, transform };
