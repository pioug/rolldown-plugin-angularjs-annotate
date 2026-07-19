const test = require('node:test');
const {
  assertEquivalentTransform,
  assertUnchangedTransform,
} = require('../test-support/transform');

test('Resolve a later const when its Angular registration is deferred until after initialization', () => {
  const input = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    const Later = function(laterDep) {};
    register();
  `;
  const expected = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    const Later = function(laterDep) {};
    Later.$inject = ['laterDep'];
    register();
  `;
  assertEquivalentTransform(input, expected);
});

test('Resolve a later class when its Angular registration is deferred until after initialization', () => {
  const input = `
    function register() {
      angular.module('x').service('Service', Service);
    }
    class Service {
      constructor(classDep) {}
    }
    register();
  `;
  const expected = `
    function register() {
      angular.module('x').service('Service', Service);
    }
    class Service {
      constructor(classDep) {}
    }
    Service.$inject = ['classDep'];
    register();
  `;
  assertEquivalentTransform(input, expected);
});

test('Resolve only initialized and effectively immutable later mutable bindings', async t => {
  const cases = [
    { kind: 'let', shape: 'initialized once', declaration: 'let Later = function(letDep) {};', dependency: 'letDep' },
    { kind: 'let', shape: 'assigned after declaration', declaration: 'let Later;\nLater = function(letDep) {};' },
    { kind: 'let', shape: 'reassigned', declaration: 'let Later = function(firstDep) {};\nLater = function(secondDep) {};' },
    { kind: 'var', shape: 'initialized once', declaration: 'var Later = function(varDep) {};', dependency: 'varDep' },
    { kind: 'var', shape: 'assigned after declaration', declaration: 'var Later;\nLater = function(varDep) {};' },
    { kind: 'var', shape: 'reassigned', declaration: 'var Later = function(firstDep) {};\nLater = function(secondDep) {};' },
  ];

  for (const fixture of cases) {
    await t.test(`${fixture.kind}: ${fixture.shape}`, () => {
      const input = `
        function register() {
          angular.module('x').controller('Later', Later);
        }
        ${fixture.declaration}
        register();
      `;

      if (!fixture.dependency) {
        assertUnchangedTransform(input);
        return;
      }

      const expected = `
        function register() {
          angular.module('x').controller('Later', Later);
        }
        ${fixture.declaration}
        Later.$inject = ['${fixture.dependency}'];
        register();
      `;
      assertEquivalentTransform(input, expected);
    });
  }
});
