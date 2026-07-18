const test = require('node:test');
const assert = require('node:assert');
const { assertTransform, transform } = require('../test-support/transform');

test('Recognize proven local Angular aliases', async t => {
  const cases = [
    {
      name: 'ES module default import',
      input: "import angular from 'angular'; angular.module('x').run(function(importDep) {});",
      expected: "import angular from 'angular'; angular.module('x').run(['importDep', function(importDep) {}]);",
    },
    {
      name: 'ES module namespace import',
      input: "import * as angular from 'angular'; angular.module('x').run(function(namespaceDep) {});",
      expected: "import * as angular from 'angular'; angular.module('x').run(['namespaceDep', function(namespaceDep) {}]);",
    },
    {
      name: 'AMD parameter',
      input: "define(['angular'], function(angular) { angular.module('x').run(function(amdDep) {}); });",
      expected: "define(['angular'], function(angular) { angular.module('x').run(['amdDep', function(amdDep) {}]); });",
    },
    {
      name: 'window.angular alias',
      input: "const angular = window.angular; angular.module('x').run(function(windowDep) {});",
      expected: "const angular = window.angular; angular.module('x').run(['windowDep', function(windowDep) {}]);",
    },
    {
      name: 'globalThis.angular alias',
      input: "const angular = globalThis.angular; angular.module('x').run(function(globalDep) {});",
      expected: "const angular = globalThis.angular; angular.module('x').run(['globalDep', function(globalDep) {}]);",
    },
    {
      name: 'CommonJS default export alias',
      input: "const angular = require('angular').default; angular.module('x').run(function(commonjsDep) {});",
      expected: "const angular = require('angular').default; angular.module('x').run(['commonjsDep', function(commonjsDep) {}]);",
    },
    {
      name: 'intermediate CommonJS default export alias',
      input: `
        const angularModule = require('angular');
        const angular = angularModule.default;
        angular.module('x').run(function(commonjsDep) {});
      `,
      expected: `
        const angularModule = require('angular');
        const angular = angularModule.default;
        angular.module('x').run(['commonjsDep', function(commonjsDep) {}]);
      `,
    },
    {
      name: 'named AMD factory',
      input: `
        define(['angular'], factory);
        function factory(angular) {
          angular.module('x').run(function(namedDep) {});
        }
      `,
      expected: `
        define(['angular'], factory);
        function factory(angular) {
          angular.module('x').run(['namedDep', function(namedDep) {}]);
        }
      `,
    },
    {
      name: 'named AMD factory with referenced dependencies',
      input: `
        const dependencies = ['angular'];
        define(dependencies, factory);
        function factory(angular) {
          angular.module('x').run(function(referencedDep) {});
        }
      `,
      expected: `
        const dependencies = ['angular'];
        define(dependencies, factory);
        function factory(angular) {
          angular.module('x').run(['referencedDep', function(referencedDep) {}]);
        }
      `,
    },
    {
      name: 'RequireJS factory',
      input: "requirejs(['angular'], function(angular) { angular.module('x').run(function(requirejsDep) {}); });",
      expected: "requirejs(['angular'], function(angular) { angular.module('x').run(['requirejsDep', function(requirejsDep) {}]); });",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => assertTransform(fixture.input, fixture.expected));
  }
});

test('Do not treat an unrelated shadow binding as Angular', () => {
  const input = `
    const angular = window.angular;
    angular.module('x').run(function(realDep) {});
    function testShadow() {
      const angular = fakeAngular;
      angular.module('x').run(function(fakeDep) {});
    }
  `;
  const expected = `
    const angular = window.angular;
    angular.module('x').run(['realDep', function(realDep) {}]);
    function testShadow() {
      const angular = fakeAngular;
      angular.module('x').run(function(fakeDep) {});
    }
  `;
  assertTransform(input, expected);
});

test('Do not treat named imports from Angular as the Angular namespace', () => {
  const input = "import { version } from 'angular'; version.module('x').run(function(falsePositiveDep) {});";
  assert.equal(transform(input).code, input);
});

test('Recognize proven Angular aliases passed to direct IIFEs', () => {
  const input = `
    (function(angular) {
      angular.module('x').run(function(umdDep) {});
    })(window.angular);
    (angular => angular.module('x').run(function(arrowDep) {}))(globalThis.angular);
  `;
  const expected = `
    (function(angular) {
      angular.module('x').run(['umdDep', function(umdDep) {}]);
    })(window.angular);
    (angular => angular.module('x').run(['arrowDep', function(arrowDep) {}]))(globalThis.angular);
  `;
  assertTransform(input, expected);
});

test('Recognize proven destructured Angular aliases', () => {
  const input = `
    const { default: angular } = require('angular');
    angular.module('x').run(function(cjsDep) {});
    function nested() {
      const { angular } = window;
      angular.module('x').run(function(windowDep) {});
    }
    function renamed() {
      const { angular: ng } = globalThis;
      ng.module('x').run(function(globalDep) {});
    }
  `;
  const expected = `
    const { default: angular } = require('angular');
    angular.module('x').run(['cjsDep', function(cjsDep) {}]);
    function nested() {
      const { angular } = window;
      angular.module('x').run(['windowDep', function(windowDep) {}]);
    }
    function renamed() {
      const { angular: ng } = globalThis;
      ng.module('x').run(['globalDep', function(globalDep) {}]);
    }
  `;
  assertTransform(input, expected);
});

test('Reject unproven and shadowed destructured Angular aliases', () => {
  const input = `
    const { version: angular } = require('angular');
    angular.module('x').run(function(namedDep) {});
    function nested() {
      const window = fakeWindow;
      const { angular } = window;
      angular.module('x').run(function(shadowedDep) {});
    }
  `;
  assert.equal(transform(input).code, input);
});

test('Recognize parenthesized long-form Angular receivers', () => {
  const input = "const angular = window.angular; (angular).module('x').run(function(wrappedDep) {});";
  const expected = "const angular = window.angular; (angular).module('x').run(['wrappedDep', function(wrappedDep) {}]);";
  assertTransform(input, expected);
});

test('Allow regexp to match a call-expression module receiver', () => {
  const input = "require('app-module').controller('Controller', function(callDep) {});";
  const expected = "require('app-module').controller('Controller', ['callDep', function(callDep) {}]);";
  assertTransform(input, expected, { options: { regexp: '^require\\(.+\\)$' } });
});
