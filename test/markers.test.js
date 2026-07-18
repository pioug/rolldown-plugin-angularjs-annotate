const test = require('node:test');
const assert = require('node:assert');
const { assertTransform, transform } = require('../test-support/transform');

test('Recognize parenthesized annotation wrapper callees', () => {
  const input = `
    angular.module('x')
      .factory('factory', (ngInject)(function(factoryDep) {}))
      .provider('provider', (ngNoInject)(function(outer) {
        this.$get = function(providerDep) {};
      }));
  `;
  const expected = `
    angular.module('x')
      .factory('factory', (ngInject)(['factoryDep', function(factoryDep) {}]))
      .provider('provider', (ngNoInject)(function(outer) {
        this.$get = ['providerDep', function(providerDep) {}];
      }));
  `;
  assertTransform(input, expected);
});

test('Ignore explicit prologues in non-injectable methods and accessors', () => {
  const input = "class Service { method(methodDep) { 'ngInject'; } static other(staticDep) { 'ngInject'; } } const object = { set value(setterDep) { 'ngInject'; } };";
  assert.equal(transform(input).code, input);
});

test('Reject an explicitly marked existing array with too few annotations', () => {
  const input = "angular.module('x').run(['first', function(first, second) { 'ngInject'; }]);";
  assert.throws(
    () => transform(input, { id: 'mismatch.js' }),
    error => {
      assert.match(error.message, /Function parameters do not match existing annotations/);
      assert.equal(error.id, 'mismatch.js');
      assert.equal(error.pluginCode, 'ANNOTATION_MISMATCH');
      assert.ok(Number.isInteger(error.start));
      return true;
    },
  );
});

test('Warn about an explicitly marked existing array with mismatched annotations', () => {
  const input = "angular.module('x').run(['wrong', function(actual) { 'ngInject'; }]);";
  const { warnings } = transform(input, { id: 'mismatch.js' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].log.message, /Function parameters do not match existing annotations/);
  assert.equal(warnings[0].log.id, 'mismatch.js');
  assert.equal(warnings[0].log.pluginCode, 'ANNOTATION_MISMATCH');
  assert.ok(Number.isInteger(warnings[0].position));
});

test('Apply a declaration-level ngInject marker to every object declarator', () => {
  const input = `
    /* @ngInject */
    const first = { start: function(firstDep) {} },
      second = { nested: { start: function(secondDep) {} } };
  `;
  const expected = `
    /* @ngInject */
    const first = { start: ['firstDep', function(firstDep) {}] },
      second = { nested: { start: ['secondDep', function(secondDep) {}] } };
  `;
  assertTransform(input, expected);
});

test('Apply a declaration-level ngNoInject marker to every object declarator', () => {
  const input = `
    /* @ngNoInject */
    const first = { start: function(firstDep) { 'ngInject'; } },
      second = { nested: { start: function(secondDep) { 'ngInject'; } } };
  `;
  assert.equal(transform(input).code, input);
});

test('Honor explicit markers before parenthesized callables', () => {
  const input = `
    const named = /* @ngInject */ (function(namedDep) {});
    consume(/* @ngInject */ ((function(argumentDep) {})));
    const blocked = /* @ngNoInject */ (function(blockedDep) { 'ngInject'; });
  `;
  const expected = `
    const named = /* @ngInject */ (function(namedDep) {});
    named.$inject = ['namedDep'];
    consume(/* @ngInject */ ((['argumentDep', function(argumentDep) {}])));
    const blocked = /* @ngNoInject */ (function(blockedDep) { 'ngInject'; });
  `;
  assertTransform(input, expected);
});

test('Use multi-function ngNoInject only to suppress explicit annotations', () => {
  const declaration = `
    /* @ngNoInject */
    const first = function(firstDep) { 'ngInject'; },
      second = function(secondDep) { 'ngInject'; };
  `;
  assert.equal(transform(declaration).code, declaration);
  assert.equal(transform(declaration, { options: { explicitOnly: true } }).code, declaration);

  const registered = `
    ${declaration}
    angular.module('x')
      .controller('first', first)
      .controller('second', second);
  `;
  const expected = `
    ${declaration}
    first.$inject = ['firstDep'];
    second.$inject = ['secondDep'];
    angular.module('x')
      .controller('first', first)
      .controller('second', second);
  `;
  assertTransform(registered, expected);
  assert.equal(transform(registered, { options: { explicitOnly: true } }).code, registered);
});

test('Use multi-class ngNoInject only to suppress explicit constructor annotations', () => {
  const declaration = `
    /* @ngNoInject */
    const First = class { constructor(firstDep) { 'ngInject'; } },
      Second = class { constructor(secondDep) { 'ngInject'; } };
  `;
  assert.equal(transform(declaration).code, declaration);
  assert.equal(transform(declaration, { options: { explicitOnly: true } }).code, declaration);

  const registered = `
    ${declaration}
    angular.module('x')
      .service('First', First)
      .service('Second', Second);
  `;
  const output = transform(registered).code;
  assert.match(output, /First\.\$inject = \["firstDep"\];/);
  assert.match(output, /Second\.\$inject = \["secondDep"\];/);
  assert.equal(transform(registered, { options: { explicitOnly: true } }).code, registered);
});

test('Do not interpret parenthesized strings as directive prologues', () => {
  const input = `
    const unrelated = function(explicitDep) { ('ngInject'); };
    angular.module('x').run(function(contextDep) { ('ngNoInject'); });
  `;
  const expected = `
    const unrelated = function(explicitDep) { ('ngInject'); };
    angular.module('x').run(['contextDep', function(contextDep) { ('ngNoInject'); }]);
  `;
  assertTransform(input, expected);
});

test('Keep the complete leading comment group attached to a marked declaration', () => {
  const input = "// documentation\n// @ngInject\nfunction marked(dep) {}";
  const expected = "marked.$inject = [\"dep\"];\n// documentation\n// @ngInject\nfunction marked(dep) {}";
  assert.equal(transform(input).code, expected);
});

test('Match upstream marker placement after an existing directive prologue', () => {
  const input = "'use strict';\n// @ngInject\nfunction marked(dep) {}";
  const expected = "'use strict';\n// @ngInject\nmarked.$inject = [\"dep\"];\nfunction marked(dep) {}";
  assert.equal(transform(input).code, expected);
});

test('Ignore declaration-level markers on exported multi-declarator statements', () => {
  const input = "/* @ngInject */ export const first = { start: function(firstDep) {} }, second = { start: function(secondDep) {} };";
  assert.equal(transform(input).code, input);
});
