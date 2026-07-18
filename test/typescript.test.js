const test = require('node:test');
const assert = require('node:assert');
const { transform } = require('../test-support/transform');

test('Recognize TypeScript-wrapped long-form Angular receivers', () => {
  const input = `
    declare const angular: any;
    (angular as any).module('x').run(function(assertedDep: Service) {});
    angular!.module('x').run(function(nonNullDep: Service) {});
  `;
  const output = transform(input, { id: 'fixture.ts' }).code;
  assert.match(output, /\.run\(\["assertedDep", function\(assertedDep: Service\)/);
  assert.match(output, /\.run\(\["nonNullDep", function\(nonNullDep: Service\)/);
});

test('Recognize TypeScript-wrapped annotation wrapper callees', () => {
  const input = `
    angular.module('x').factory(
      'factory',
      (ngInject as typeof ngInject)(function(tsDep: Service) {}),
    );
  `;
  const output = transform(input, { id: 'fixture.ts' }).code;
  assert.match(output, /ngInject as typeof ngInject\)\(\["tsDep", function\(tsDep: Service\)/);
});

test('Ignore TypeScript fake this parameters when deriving dependencies', () => {
  const input = `
    interface Context {}
    interface Service {}
    angular.module('x').run(function(this: Context, dep: Service) {});
  `;
  const output = transform(input, { id: 'fixture.ts' }).code;
  assert.match(output, /\.run\(\["dep", function\(this: Context, dep: Service\)/);
  assert.doesNotMatch(output, /\["this"/);
});

test('Use the TypeScript constructor implementation rather than an overload signature', () => {
  const input = `
    interface Dependency {}
    class Service {
      constructor(overloadName: Dependency);
      constructor(runtimeDep: Dependency) {}
    }
    angular.module('x').service('Service', Service);
  `;
  const output = transform(input, { id: 'fixture.ts' }).code;
  assert.match(output, /Service\.\$inject = \["runtimeDep"\];/);
  assert.doesNotMatch(output, /\["overloadName"\]/);
});
