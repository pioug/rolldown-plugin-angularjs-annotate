const assert = require('node:assert');
const MagicString = require('magic-string');
const { minifySync, parseSync } = require('rolldown/utils');
const angularjsAnnotate = require('..');
const annotate = require('../src/annotate');

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

function assertEquivalentTransform(input, expected, settings) {
  const { code: actual, warnings } = transform(input, settings);
  const id = settings?.id || 'fixture.js';
  assert.deepStrictEqual(warnings, []);
  assert.equal(compact(actual, id), compact(expected, id));
  return actual;
}

function assertExactTransform(input, expected, settings) {
  const { code: actual, warnings } = transform(input, settings);
  assert.deepStrictEqual(warnings, []);
  assert.equal(actual, expected);
  return actual;
}

function assertUnchangedTransform(input, settings) {
  return assertExactTransform(input, input, settings);
}

function transformCore(code, options, id = 'fixture.js') {
  const parsed = parseSync(id, code, { sourceType: 'unambiguous' });
  if (parsed.errors.length) throw parsed.errors[0];
  const magicString = new MagicString(code);
  const warnings = [];
  annotate(parsed.program, code, magicString, {
    ...options,
    comments: parsed.comments,
    onWarn: (message, diagnostic) => warnings.push({ message, diagnostic }),
  });
  assert.deepStrictEqual(warnings, []);
  return magicString.toString();
}

function assertEquivalentCoreTransform(input, expected, options, id = 'fixture.js') {
  const actual = transformCore(input, options, id);
  assert.equal(compact(actual, id), compact(expected, id));
  return actual;
}

module.exports = {
  assertEquivalentCoreTransform,
  assertEquivalentTransform,
  assertExactTransform,
  assertUnchangedTransform,
  transform,
  transformCore,
};
