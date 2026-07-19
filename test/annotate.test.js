const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { minifySync, parseSync } = require('rolldown/utils');
const {
  assertEquivalentCoreTransform,
  transformCore,
} = require('../test-support/transform');

test.describe('Direct annotation target discovery', () => {
  test('Annotate AngularJS callbacks and UI-Router targets', () => {
    const input = `
      angular.module('x').config(function($stateProvider) {
        function enter(Page) {}
        $stateProvider.state('x', {
          onEnter: enter,
          resolve: { x: function($http) {} },
        });
      });
    `;
    const expected = `
      angular.module('x').config(['$stateProvider', function($stateProvider) {
        enter.$inject = ['Page'];
        function enter(Page) {}
        $stateProvider.state('x', {
          onEnter: enter,
          resolve: { x: ['$http', function($http) {}] },
        });
      }]);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Annotate class constructors and object methods', () => {
    const input = `
      class Service { constructor($http) { 'ngInject'; } }
      const callbacks = { load($q) { 'ngInject'; } };
      angular.module('x').config(function($stateProvider) {
        $stateProvider.state('x', { controller($scope) {} });
      });
    `;
    const expected = `
      class Service { constructor($http) { 'ngInject'; } }
      Service.$inject = ['$http'];
      const callbacks = { load: ['$q', function($q) { 'ngInject'; }] };
      angular.module('x').config(['$stateProvider', function($stateProvider) {
        $stateProvider.state('x', { controller: ['$scope', function($scope) {}] });
      }]);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Skip unsafe parameter and accessor shapes', () => {
    const input = `
      angular.module('x').run(function({ value }, dep) {});
      angular.module('x').config(function($stateProvider) {
        $stateProvider.state('x', { set controller(dep) {} });
      });
    `;
    const expected = `
      angular.module('x').run(function({ value }, dep) {});
      angular.module('x').config(['$stateProvider', function($stateProvider) {
        $stateProvider.state('x', { set controller(dep) {} });
      }]);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Follow concise arrow IIFEs', () => {
    const input = `
      const factory = (() => function(dep) {})();
      angular.module('x').factory('factory', factory);
    `;
    const expected = `
      const factory = (() => function(dep) {})();
      factory.$inject = ['dep'];
      angular.module('x').factory('factory', factory);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Keep inline named registration targets scoped', () => {
    const input = `
      angular.module('x')
        .service('Class', class InnerClass { constructor(classDep) {} })
        .factory('Function', function InnerFunction(functionDep) {});
    `;
    const expected = `
      angular.module('x')
        .service('Class', ['classDep', class InnerClass { constructor(classDep) {} }])
        .factory('Function', ['functionDep', function InnerFunction(functionDep) {}]);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Leave explicitly marked IIFEs callable', () => {
    const input = "(function ExplicitIife(iifeDep) { 'ngInject'; })();";
    assert.equal(transformCore(input), input);
  });

  test('Preserve branch-valued callables', () => {
    const input = `
      const C = flag ? function(leftDep) {} : function(rightDep) {};
      C();
      angular.module('x').controller('C', C);
      const L = fallback || function(logicalDep) {};
      L();
      angular.module('x').factory('L', L);
    `;
    const output = transformCore(input);
    assert.equal(output, input);
    vm.runInNewContext(output, {
      flag: true,
      fallback() {},
      angular: { module: () => ({ controller() { return this; }, factory() { return this; } }) },
    });
  });

  test('Annotate simple IIFE-returned classes', () => {
    const input = `
      const K = (() => class { constructor(classDep) {} })();
      new K();
      angular.module('x').service('K', K);
    `;
    const expected = `
      const K = (() => class { constructor(classDep) {} })();
      K.$inject = ['classDep'];
      new K();
      angular.module('x').service('K', K);
    `;
    assertEquivalentCoreTransform(input, expected);
  });
});

test.describe('Direct annotation markers and existing annotations', () => {
  test('Preserve existing annotations', () => {
    const input = `
      Controller.$inject = ['token'];
      function Controller(minified) {}
      angular.module('x').controller('Controller', Controller);
    `;
    assert.equal(transformCore(input), input);
  });

  test('Remain idempotent', () => {
    const once = transformCore(`
      function Service(dep) {}
      angular.module('x').service('Service', Service);
    `);
    assert.equal(transformCore(once), once);
  });

  test('Honor explicitOnly', () => {
    const input = `
      angular.module('x').run(function(implicit) {});
      const explicit = function(marked) { 'ngInject'; };
    `;
    const expected = `
      angular.module('x').run(function(implicit) {});
      const explicit = function(marked) { 'ngInject'; };
      explicit.$inject = ['marked'];
    `;
    assertEquivalentCoreTransform(input, expected, { explicitOnly: true });
  });

  test('Use declarator names for explicitly marked function expressions', () => {
    const input = 'const exposed = /* @ngInject */ function internal(dep) {};';
    const expected = `
      const exposed = /* @ngInject */ function internal(dep) {};
      exposed.$inject = ['dep'];
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Skip explicitly marked non-standalone declarations', () => {
    const input = "for (let callback = function(loopDep) { 'ngInject'; }; false;) {}";
    assert.equal(transformCore(input), input);
  });

  test('Preserve every form of existing inject member', () => {
    const input = `
      Assigned.$inject = customDeps;
      function Assigned(dep) {}
      class Field {
        static $inject = customDeps;
        constructor(fieldDep) {}
      }
      class Getter {
        static get $inject() { return customDeps; }
        constructor(getterDep) {}
      }
      angular.module('x')
        .service('Assigned', Assigned)
        .service('Field', Field)
        .service('Getter', Getter);
    `;
    assert.equal(transformCore(input), input);
  });

  test('Preserve explicitly marked methods that use super', () => {
    const input = `
      const base = { method() {} };
      const object = {
        __proto__: base,
        /* @ngInject */
        method(methodDep) { super.method(); },
      };
    `;
    assert.equal(transformCore(input), input);
  });

  test('Safely name decorated anonymous default classes', () => {
    const input = '/* @ngInject */ export default @sealed class { constructor(dep) {} }';
    const output = transformCore(input);
    assert.match(output, /@sealed class _ngInjectAnonymousClass/);
    assert.match(output, /_ngInjectAnonymousClass\.\$inject = \["dep"\];/);
    assert.equal(parseSync('fixture.js', output, { sourceType: 'module' }).errors.length, 0);
  });

  test('Skip ambiguous declaration-level markers with multiple declarators', () => {
    const input = '/* @ngInject */ const first = function(one) {}, second = function(two) {};';
    assert.equal(transformCore(input), input);
  });

  test('Apply an existing annotation only to its effective write', () => {
    const input = `
      let C = function(first) {};
      C.$inject = ['first'];
      C = function(second) {};
      angular.module('x').controller('C', C);
    `;
    const expected = `
      let C = function(first) {};
      C.$inject = ['first'];
      C = function(second) {};
      C.$inject = ['second'];
      angular.module('x').controller('C', C);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Apply a static inject member only to its effective class write', () => {
    const input = `
      let K = class {
        static $inject = customDeps;
        constructor(firstClass) {}
      };
      K = class { constructor(secondClass) {} };
      angular.module('x').service('K', K);
    `;
    const expected = `
      let K = class {
        static $inject = customDeps;
        constructor(firstClass) {}
      };
      K = class { constructor(secondClass) {} };
      K.$inject = ['secondClass'];
      angular.module('x').service('K', K);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Apply a no-inject marker only to its effective write', () => {
    const input = `
      let N = /* @ngNoInject */ function(firstBlocked) {};
      N = function(secondAllowed) {};
      angular.module('x').factory('N', N);
    `;
    const expected = `
      let N = /* @ngNoInject */ function(firstBlocked) {};
      N = function(secondAllowed) {};
      N.$inject = ['secondAllowed'];
      angular.module('x').factory('N', N);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Associate explicit markers with decorators before export', () => {
    const input = '/* @ngInject */ @sealed export default class { constructor(dep) {} }';
    const output = transformCore(input);
    assert.match(output, /export default class _ngInjectAnonymousClass/);
    assert.match(output, /_ngInjectAnonymousClass\.\$inject = \["dep"\];/);
    assert.equal(parseSync('fixture.js', output, { sourceType: 'module' }).errors.length, 0);
  });

  test('Preserve inline class annotations', () => {
    const input = "angular.module('x').service('C', ['dep', class C { constructor(dep) { 'ngInject'; } }]);";
    assert.equal(transformCore(input), input);
  });
});

test.describe('Direct annotation binding resolution', () => {
  test('Resolve lexical bindings without annotating unrelated APIs', () => {
    const input = `
      function Controller(outer) {}
      function setup() {
        function Controller(inner) {}
        angular.module('x').controller('inner', Controller);
      }
      angular.module('x').controller('outer', Controller);
      store.state('x', { controller(dep) {} });
    `;
    const expected = `
      Controller.$inject = ['outer'];
      function Controller(outer) {}
      function setup() {
        Controller.$inject = ['inner'];
        function Controller(inner) {}
        angular.module('x').controller('inner', Controller);
      }
      angular.module('x').controller('outer', Controller);
      store.state('x', { controller(dep) {} });
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Preserve wrapped callables and annotate their binding', () => {
    const input = `
      const Wrapped = (function(wrapped) {});
      Wrapped();
      angular.module('x').controller('Wrapped', Wrapped);
    `;
    const expected = `
      const Wrapped = (function(wrapped) {});
      Wrapped.$inject = ['wrapped'];
      Wrapped();
      angular.module('x').controller('Wrapped', Wrapped);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Annotate the latest unconditional mutable binding', () => {
    const input = `
      let Mutable = function(first) {};
      Mutable = function(second) {};
      angular.module('x').controller('Mutable', Mutable);
    `;
    const expected = `
      let Mutable = function(first) {};
      Mutable = function(second) {};
      Mutable.$inject = ['second'];
      angular.module('x').controller('Mutable', Mutable);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Annotate the outer binding of a named function expression', () => {
    const input = `
      const Outer = function Inner(named) {
        angular.module('x').controller('Inner', Inner);
      };
      Outer();
    `;
    const expected = `
      const Outer = function Inner(named) {
        angular.module('x').controller('Inner', Inner);
      };
      Outer.$inject = ['named'];
      Outer();
    `;
    const output = assertEquivalentCoreTransform(input, expected);
    vm.runInNewContext(output, {
      angular: { module: () => ({ controller() { return this; } }) },
    });
  });

  test('Resolve duplicate var writes at each registration', () => {
    const input = `
      var Duplicate = function(early) {};
      angular.module('x').controller('early', Duplicate);
      var Duplicate = function(late) {};
      angular.module('x').controller('late', Duplicate);
    `;
    const expected = `
      var Duplicate = function(early) {};
      Duplicate.$inject = ['early'];
      angular.module('x').controller('early', Duplicate);
      var Duplicate = function(late) {};
      Duplicate.$inject = ['late'];
      angular.module('x').controller('late', Duplicate);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Resolve named class-expression references to their outer binding', () => {
    const input = `
      const Service = class InnerService {
        constructor(serviceDep) {}
        static register() { angular.module('x').service('inner', InnerService); }
      };
      Service.register();
    `;
    const expected = `
      const Service = class InnerService {
        constructor(serviceDep) {}
        static register() { angular.module('x').service('inner', InnerService); }
      };
      Service.$inject = ['serviceDep'];
      Service.register();
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Resolve bindings scoped to switch cases', () => {
    const input = `
      const C = function(outer) {};
      switch (mode) {
        case 1:
          const C = function(inner) {};
          angular.module('x').controller('inner', C);
          break;
      }
      angular.module('x').controller('outer', C);
    `;
    const expected = `
      const C = function(outer) {};
      C.$inject = ['outer'];
      switch (mode) {
        case 1:
          const C = function(inner) {};
          C.$inject = ['inner'];
          angular.module('x').controller('inner', C);
          break;
      }
      angular.module('x').controller('outer', C);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Skip ambiguous conditional writes', () => {
    const input = `
      let Maybe = function(first) {};
      if (flag) Maybe = function(second) {};
      angular.module('x').controller('maybe', Maybe);
    `;
    assert.equal(transformCore(input), input);
  });

  test('Do not follow bindings changed by destructuring or loop writes', () => {
    const input = `
      let C = function(first) {};
      [C] = [function(second) {}];
      angular.module('x').controller('C', C);
      let D = function(beforeObject) {};
      ({ D } = source);
      angular.module('x').controller('D', D);
      let E = function(beforeLoop) {};
      for (E of callbacks) {}
      angular.module('x').controller('E', E);
    `;
    assert.equal(transformCore(input), input);
  });

  test('Keep injections inside static blocks', () => {
    const input = `
      class Host {
        static {
          const C = function(staticDep) {};
          angular.module('x').controller('C', C);
        }
      }
    `;
    const expected = `
      class Host {
        static {
          const C = function(staticDep) {};
          C.$inject = ['staticDep'];
          angular.module('x').controller('C', C);
        }
      }
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Keep injections inside switch cases', () => {
    const input = `
      switch (mode) {
        case 1:
          function S(switchDep) {}
          angular.module('x').controller('S', S);
          break;
      }
    `;
    const expected = `
      switch (mode) {
        case 1:
          function S(switchDep) {}
          S.$inject = ['switchDep'];
          angular.module('x').controller('S', S);
          break;
      }
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Do not let unresolved annotations suppress shadowed declarations', () => {
    const input = `
      External.$inject = [];
      function setup() {
        function External(dep) {}
        angular.module('x').controller('External', External);
      }
    `;
    const expected = `
      External.$inject = [];
      function setup() {
        External.$inject = ['dep'];
        function External(dep) {}
        angular.module('x').controller('External', External);
      }
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Treat static blocks as var scopes', () => {
    const input = `
      var C = function(outer) {};
      class Host {
        static {
          var C = function(inner) {};
          angular.module('x').controller('inner', C);
        }
      }
      angular.module('x').controller('outer', C);
    `;
    const expected = `
      var C = function(outer) {};
      C.$inject = ['outer'];
      class Host {
        static {
          var C = function(inner) {};
          C.$inject = ['inner'];
          angular.module('x').controller('inner', C);
        }
      }
      angular.module('x').controller('outer', C);
    `;
    assertEquivalentCoreTransform(input, expected);
  });

  test('Ignore superseded hoisted declarations', () => {
    const input = `
      function Duplicate(first) { 'ngInject'; }
      function Duplicate(second) {}
      angular.module('x').controller('Duplicate', Duplicate);
    `;
    const expected = `
      Duplicate.$inject = ['second'];
      function Duplicate(first) { 'ngInject'; }
      function Duplicate(second) {}
      angular.module('x').controller('Duplicate', Duplicate);
    `;
    assertEquivalentCoreTransform(input, expected);
  });
});

test.describe('Direct annotation Angular receiver recognition', () => {
  test('Recognize CommonJS Angular aliases', () => {
    const input = `
      const angular = require('angular');
      angular.module('x').run(function(dep) {});
    `;
    const expected = `
      const angular = require('angular');
      angular.module('x').run(['dep', function(dep) {}]);
    `;
    assertEquivalentCoreTransform(input, expected);
  });
});

test.describe('Minified AngularJS runtime integration', () => {
  test('Bootstrap transformed code with strict dependency injection', async () => {
    const input = `
      class Service {
        constructor(token) {
          'ngInject';
          this.value = token;
        }
      }
      const callbacks = {
        start(Service) {
          'ngInject';
          globalThis.bootstrapResult = Service.value;
        },
      };
      angular.module('migrationSmoke', [])
        .constant('token', 'ready')
        .service('Service', Service)
        .run(callbacks.start);
    `;
    const code = minifySync('fixture.js', transformCore(input), { mangle: true }).code;
    const globalNames = [
      'window', 'document', 'location', 'navigator', 'Node', 'Element', 'angular', 'bootstrapResult',
    ];
    const descriptors = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(global, name)]));
    const angularModule = require.resolve('angular/angular');
    const cachedAngular = require.cache[angularModule];

    delete require.cache[angularModule];
    try {
      loadAngular();
      vm.runInThisContext(`(() => { ${code} })()`);
      const injector = global.angular.bootstrap(global.document.body, ['migrationSmoke'], { strictDi: true });
      assert.equal(injector.get('Service').value, 'ready');
      assert.equal(global.bootstrapResult, 'ready');
    } finally {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cachedAngular) require.cache[angularModule] = cachedAngular;
      else delete require.cache[angularModule];
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(global, name, descriptor);
        else delete global[name];
      }
    }
  });
});

function loadAngular() {
  function noop() {
    return undefined;
  }

  function element() {
    return {
      nodeType: 1,
      nodeName: 'DIV',
      style: {},
      childNodes: [],
      children: [],
      attributes: [],
      firstChild: null,
      setAttribute: noop,
      getAttribute: () => null,
      hasAttribute: () => false,
      removeAttribute: noop,
      appendChild: noop,
      insertBefore: noop,
      removeChild: noop,
      cloneNode: element,
      addEventListener: noop,
      removeEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
  }

  const document = element();
  document.nodeType = 9;
  document.documentElement = element();
  document.body = element();
  document.head = element();
  document.readyState = 'complete';
  document.createElement = tag => {
    const output = element();
    if (tag === 'a') {
      output.setAttribute = (name, value) => {
        if (name !== 'href') return;
        const url = new URL(value, 'http://localhost/');
        for (const key of ['href', 'protocol', 'host', 'search', 'hash', 'hostname', 'port', 'pathname']) {
          output[key] = url[key];
        }
      };
    }
    return output;
  };
  document.getElementsByTagName = tag => tag === 'head' ? [document.head] : [];

  defineGlobal('window', global);
  defineGlobal('document', document);
  defineGlobal('location', { href: 'http://localhost/' });
  defineGlobal('navigator', { userAgent: 'node' });
  defineGlobal('Node', function Node() {});
  defineGlobal('Element', function Element() {});
  require('angular/angular');
}

function defineGlobal(name, value) {
  Object.defineProperty(global, name, { configurable: true, writable: true, value });
}
