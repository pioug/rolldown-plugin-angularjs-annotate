const test = require('node:test');
const assert = require('node:assert');
const { assertTransform, transform } = require('../test-support/transform');

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
  assertTransform(input, expected);
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
  assertTransform(input, expected);
});

test('Resolve only initialized and effectively immutable later let bindings', () => {
  const safeInput = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    let Later = function(laterDep) {};
    register();
  `;
  const safeExpected = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    let Later = function(laterDep) {};
    Later.$inject = ['laterDep'];
    register();
  `;
  assertTransform(safeInput, safeExpected);

  const assignedLater = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    let Later;
    Later = function(laterDep) {};
    register();
  `;
  assert.equal(transform(assignedLater).code, assignedLater);

  const reassigned = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    let Later = function(firstDep) {};
    Later = function(secondDep) {};
    register();
  `;
  assert.equal(transform(reassigned).code, reassigned);
});

test('Resolve only initialized and effectively immutable later var bindings', () => {
  const safeInput = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    var Later = function(varDep) {};
    register();
  `;
  const safeExpected = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    var Later = function(varDep) {};
    Later.$inject = ['varDep'];
    register();
  `;
  assertTransform(safeInput, safeExpected);

  const assignedLater = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    var Later;
    Later = function(varDep) {};
    register();
  `;
  assert.equal(transform(assignedLater).code, assignedLater);

  const reassigned = `
    function register() {
      angular.module('x').controller('Later', Later);
    }
    var Later = function(firstDep) {};
    Later = function(secondDep) {};
    register();
  `;
  assert.equal(transform(reassigned).code, reassigned);
});
