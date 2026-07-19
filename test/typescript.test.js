const test = require('node:test');
const { assertEquivalentTransform } = require('../test-support/transform');

test('Recognize TypeScript-wrapped long-form Angular receivers', () => {
  const input = `
    declare const angular: any;
    (angular as any).module('x').run(function(assertedDep: Service) {});
    angular!.module('x').run(function(nonNullDep: Service) {});
  `;
  const expected = `
    declare const angular: any;
    (angular as any).module('x').run(['assertedDep', function(assertedDep: Service) {}]);
    angular!.module('x').run(['nonNullDep', function(nonNullDep: Service) {}]);
  `;
  assertEquivalentTransform(input, expected, { id: 'fixture.ts' });
});

test('Recognize TypeScript-wrapped annotation wrapper callees', () => {
  const input = `
    angular.module('x').factory(
      'factory',
      (ngInject as typeof ngInject)(function(tsDep: Service) {}),
    );
  `;
  const expected = `
    angular.module('x').factory(
      'factory',
      (ngInject as typeof ngInject)(['tsDep', function(tsDep: Service) {}]),
    );
  `;
  assertEquivalentTransform(input, expected, { id: 'fixture.ts' });
});

test('Ignore TypeScript fake this parameters when deriving dependencies', () => {
  const input = `
    interface Context {}
    interface Service {}
    angular.module('x').run(function(this: Context, dep: Service) {});
  `;
  const expected = `
    interface Context {}
    interface Service {}
    angular.module('x').run(['dep', function(this: Context, dep: Service) {}]);
  `;
  assertEquivalentTransform(input, expected, { id: 'fixture.ts' });
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
  const expected = `
    interface Dependency {}
    class Service {
      constructor(overloadName: Dependency);
      constructor(runtimeDep: Dependency) {}
    }
    Service.$inject = ['runtimeDep'];
    angular.module('x').service('Service', Service);
  `;
  assertEquivalentTransform(input, expected, { id: 'fixture.ts' });
});
