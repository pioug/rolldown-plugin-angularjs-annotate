const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const MagicString = require('magic-string');
const { minifySync, parseSync } = require('rolldown/utils');
const annotate = require('../src/annotate');

function transform(code, options) {
  const { program, comments } = parseSync('test.js', code, { sourceType: 'unambiguous' });
  const magicString = new MagicString(code);
  annotate(program, code, magicString, { ...options, comments });
  return magicString.toString();
}

test('Annotate AngularJS', () => {
  const input = "angular.module('x').config(function($stateProvider) { function enter(Page) {} $stateProvider.state('x', { onEnter: enter, resolve: { x: function($http) {} } }); });";
  const expected = "angular.module('x').config(['$stateProvider', function($stateProvider) { enter.$inject = ['Page']; function enter(Page) {} $stateProvider.state('x', { onEnter: enter, resolve: { x: ['$http', function($http) {}] } }); }]);";
  assert.equal(
    minifySync('test.js', transform(input), { compress: false, mangle: false }).code,
    minifySync('test.js', expected, { compress: false, mangle: false }).code
  );
});

test('Annotate class constructors and object methods', () => {
  const input = "class Service { constructor($http) { 'ngInject'; } } const callbacks = { load($q) { 'ngInject'; } }; angular.module('x').config(function($stateProvider) { $stateProvider.state('x', { controller($scope) {} }); });";
  const expected = "class Service { constructor($http) { 'ngInject'; } } Service.$inject = ['$http']; const callbacks = { load: ['$q', function($q) { 'ngInject'; }] }; angular.module('x').config(['$stateProvider', function($stateProvider) { $stateProvider.state('x', { controller: ['$scope', function($scope) {}] }); }]);";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Preserve existing annotations and remain idempotent', () => {
  const input = "Controller.$inject = ['token']; function Controller(minified) {} angular.module('x').controller('Controller', Controller);";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', input).code);

  const once = transform("function Service(dep) {} angular.module('x').service('Service', Service);");
  assert.equal(transform(once), once);
});

test('Resolve lexical bindings without annotating unrelated APIs', () => {
  const input = "function Controller(outer) {} function setup() { function Controller(inner) {} angular.module('x').controller('inner', Controller); } angular.module('x').controller('outer', Controller); store.state('x', { controller(dep) {} });";
  const expected = "Controller.$inject = ['outer']; function Controller(outer) {} function setup() { Controller.$inject = ['inner']; function Controller(inner) {} angular.module('x').controller('inner', Controller); } angular.module('x').controller('outer', Controller); store.state('x', { controller(dep) {} });";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Skip unsafe parameter and accessor shapes', () => {
  const input = "angular.module('x').run(function({ value }, dep) {}); angular.module('x').config(function($stateProvider) { $stateProvider.state('x', { set controller(dep) {} }); });";
  const expected = "angular.module('x').run(function({ value }, dep) {}); angular.module('x').config(['$stateProvider', function($stateProvider) { $stateProvider.state('x', { set controller(dep) {} }); }]);";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Follow concise arrow IIFEs without crashing', () => {
  const input = "const factory = (() => function(dep) {})(); angular.module('x').factory('factory', factory);";
  const expected = "const factory = (() => function(dep) {})(); factory.$inject = ['dep']; angular.module('x').factory('factory', factory);";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Honor explicitOnly', () => {
  const input = "angular.module('x').run(function(implicit) {}); const explicit = function(marked) { 'ngInject'; };";
  const expected = "angular.module('x').run(function(implicit) {}); const explicit = function(marked) { 'ngInject'; }; explicit.$inject = ['marked'];";
  assert.equal(minifySync('test.js', transform(input, { explicitOnly: true })).code, minifySync('test.js', expected).code);
});

test('Use declarator names and skip non-standalone declarations', () => {
  const input = "const exposed = /* @ngInject */ function internal(dep) {}; for (let callback = function(loopDep) { 'ngInject'; }; false;) {}";
  const expected = "const exposed = /* @ngInject */ function internal(dep) {}; exposed.$inject = ['dep']; for (let callback = function(loopDep) { 'ngInject'; }; false;) {}";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Preserve wrapped callables and annotate the effective mutable binding', () => {
  const input = "const Wrapped = (function(wrapped) {}); Wrapped(); let Mutable = function(first) {}; Mutable = function(second) {}; angular.module('x').controller('Wrapped', Wrapped).controller('Mutable', Mutable); const Outer = function Inner(named) { angular.module('x').controller('Inner', Inner); }; Outer();";
  const expected = "const Wrapped = (function(wrapped) {}); Wrapped.$inject = ['wrapped']; Wrapped(); let Mutable = function(first) {}; Mutable = function(second) {}; Mutable.$inject = ['second']; angular.module('x').controller('Wrapped', Wrapped).controller('Mutable', Mutable); const Outer = function Inner(named) { angular.module('x').controller('Inner', Inner); }; Outer.$inject = ['named']; Outer();";
  const output = transform(input);
  assert.equal(minifySync('test.js', output).code, minifySync('test.js', expected).code);
  vm.runInNewContext(output, {
    angular: { module: () => ({ controller() { return this; } }) },
  });
});

test('Resolve duplicate var writes and named class-expression references', () => {
  const input = "var Duplicate = function(early) {}; angular.module('x').controller('early', Duplicate); var Duplicate = function(late) {}; angular.module('x').controller('late', Duplicate); const Service = class InnerService { constructor(serviceDep) {} static register() { angular.module('x').service('inner', InnerService); } }; Service.register();";
  const expected = "var Duplicate = function(early) {}; Duplicate.$inject = ['early']; angular.module('x').controller('early', Duplicate); var Duplicate = function(late) {}; Duplicate.$inject = ['late']; angular.module('x').controller('late', Duplicate); const Service = class InnerService { constructor(serviceDep) {} static register() { angular.module('x').service('inner', InnerService); } }; Service.$inject = ['serviceDep']; Service.register();";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Resolve switch bindings and skip ambiguous conditional writes', () => {
  const input = "const C = function(outer) {}; switch (mode) { case 1: const C = function(inner) {}; angular.module('x').controller('inner', C); break; } angular.module('x').controller('outer', C); let Maybe = function(first) {}; if (flag) Maybe = function(second) {}; angular.module('x').controller('maybe', Maybe);";
  const expected = "const C = function(outer) {}; C.$inject = ['outer']; switch (mode) { case 1: const C = function(inner) {}; C.$inject = ['inner']; angular.module('x').controller('inner', C); break; } angular.module('x').controller('outer', C); let Maybe = function(first) {}; if (flag) Maybe = function(second) {}; angular.module('x').controller('maybe', Maybe);";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Preserve every existing inject member and methods that use super', () => {
  const input = "Assigned.$inject = customDeps; function Assigned(dep) {} class Field { static $inject = customDeps; constructor(fieldDep) {} } class Getter { static get $inject() { return customDeps; } constructor(getterDep) {} } const base = { method() {} }; const object = { __proto__: base, /* @ngInject */ method(methodDep) { super.method(); } }; angular.module('x').service('Assigned', Assigned).service('Field', Field).service('Getter', Getter);";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', input).code);
});

test('Recognize CommonJS Angular and safely name decorated default classes', () => {
  const commonjs = "const angular = require('angular'); angular.module('x').run(function(dep) {});";
  const commonjsExpected = "const angular = require('angular'); angular.module('x').run(['dep', function(dep) {}]);";
  assert.equal(minifySync('test.js', transform(commonjs)).code, minifySync('test.js', commonjsExpected).code);

  const decorated = '/* @ngInject */ export default @sealed class { constructor(dep) {} }';
  const decoratedOutput = transform(decorated);
  assert.match(decoratedOutput, /@sealed class _ngInjectAnonymousClass/);
  assert.match(decoratedOutput, /_ngInjectAnonymousClass\.\$inject = \["dep"\];/);
  assert.equal(parseSync('test.js', decoratedOutput, { sourceType: 'module' }).errors.length, 0);
});

test('Skip ambiguous declaration-level markers with multiple declarators', () => {
  const input = '/* @ngInject */ const first = function(one) {}, second = function(two) {};';
  assert.equal(transform(input), input);
});

test('Keep inline named targets scoped and leave explicit IIFEs callable', () => {
  const input = "angular.module('x').service('Class', class InnerClass { constructor(classDep) {} }).factory('Function', function InnerFunction(functionDep) {}); (function ExplicitIife(iifeDep) { 'ngInject'; })();";
  const expected = "angular.module('x').service('Class', ['classDep', class InnerClass { constructor(classDep) {} }]).factory('Function', ['functionDep', function InnerFunction(functionDep) {}]); (function ExplicitIife(iifeDep) { 'ngInject'; })();";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Apply existing annotations and no-inject markers to their effective writes', () => {
  const input = "let C = function(first) {}; C.$inject = ['first']; C = function(second) {}; angular.module('x').controller('C', C); let K = class { static $inject = customDeps; constructor(firstClass) {} }; K = class { constructor(secondClass) {} }; angular.module('x').service('K', K); let N = /* @ngNoInject */ function(firstBlocked) {}; N = function(secondAllowed) {}; angular.module('x').factory('N', N);";
  const expected = "let C = function(first) {}; C.$inject = ['first']; C = function(second) {}; C.$inject = ['second']; angular.module('x').controller('C', C); let K = class { static $inject = customDeps; constructor(firstClass) {} }; K = class { constructor(secondClass) {} }; K.$inject = ['secondClass']; angular.module('x').service('K', K); let N = /* @ngNoInject */ function(firstBlocked) {}; N = function(secondAllowed) {}; N.$inject = ['secondAllowed']; angular.module('x').factory('N', N);";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Do not follow bindings changed by destructuring or loop writes', () => {
  const input = "let C = function(first) {}; [C] = [function(second) {}]; angular.module('x').controller('C', C); let D = function(beforeObject) {}; ({ D } = source); angular.module('x').controller('D', D); let E = function(beforeLoop) {}; for (E of callbacks) {} angular.module('x').controller('E', E);";
  assert.equal(transform(input), input);
});

test('Preserve branch-valued callables and annotate simple IIFE-returned classes', () => {
  const input = "const C = flag ? function(leftDep) {} : function(rightDep) {}; C(); angular.module('x').controller('C', C); const L = fallback || function(logicalDep) {}; L(); angular.module('x').factory('L', L); const K = (() => class { constructor(classDep) {} })(); new K(); angular.module('x').service('K', K);";
  const expected = "const C = flag ? function(leftDep) {} : function(rightDep) {}; C(); angular.module('x').controller('C', C); const L = fallback || function(logicalDep) {}; L(); angular.module('x').factory('L', L); const K = (() => class { constructor(classDep) {} })(); K.$inject = ['classDep']; new K(); angular.module('x').service('K', K);";
  const output = transform(input);
  assert.equal(minifySync('test.js', output).code, minifySync('test.js', expected).code);
  vm.runInNewContext(output, {
    flag: true,
    fallback() {},
    angular: { module: () => ({ controller() { return this; }, factory() { return this; }, service() { return this; } }) },
  });
});

test('Keep injections inside static blocks and switch cases', () => {
  const input = "class Host { static { const C = function(staticDep) {}; angular.module('x').controller('C', C); } } switch (mode) { case 1: function S(switchDep) {} angular.module('x').controller('S', S); break; }";
  const expected = "class Host { static { const C = function(staticDep) {}; C.$inject = ['staticDep']; angular.module('x').controller('C', C); } } switch (mode) { case 1: function S(switchDep) {} S.$inject = ['switchDep']; angular.module('x').controller('S', S); break; }";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Do not let unresolved annotations suppress shadowed declarations', () => {
  const input = "External.$inject = []; function setup() { function External(dep) {} angular.module('x').controller('External', External); }";
  const expected = "External.$inject = []; function setup() { External.$inject = ['dep']; function External(dep) {} angular.module('x').controller('External', External); }";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Associate explicit markers with decorators before export', () => {
  const input = '/* @ngInject */ @sealed export default class { constructor(dep) {} }';
  const output = transform(input);
  assert.match(output, /export default class _ngInjectAnonymousClass/);
  assert.match(output, /_ngInjectAnonymousClass\.\$inject = \["dep"\];/);
  assert.equal(parseSync('test.js', output, { sourceType: 'module' }).errors.length, 0);
});

test('Preserve inline class annotations', () => {
  const input = "angular.module('x').service('C', ['dep', class C { constructor(dep) { 'ngInject'; } }]);";
  assert.equal(transform(input), input);
});

test('Treat static blocks as var scopes and ignore superseded hoisted declarations', () => {
  const input = "var C = function(outer) {}; class Host { static { var C = function(inner) {}; angular.module('x').controller('inner', C); } } angular.module('x').controller('outer', C); function Duplicate(first) { 'ngInject'; } function Duplicate(second) {} angular.module('x').controller('Duplicate', Duplicate);";
  const expected = "Duplicate.$inject = ['second']; var C = function(outer) {}; C.$inject = ['outer']; class Host { static { var C = function(inner) {}; C.$inject = ['inner']; angular.module('x').controller('inner', C); } } angular.module('x').controller('outer', C); function Duplicate(first) { 'ngInject'; } function Duplicate(second) {} angular.module('x').controller('Duplicate', Duplicate);";
  assert.equal(minifySync('test.js', transform(input)).code, minifySync('test.js', expected).code);
});

test('Bootstrap minified AngularJS', () => {
  const input = "class Service { constructor(token) { 'ngInject'; this.value = token; } } const callbacks = { start(Service) { 'ngInject'; globalThis.bootstrapResult = Service.value; } }; angular.module('migrationSmoke', []).constant('token', 'ready').service('Service', Service).run(callbacks.start);";
  const code = minifySync('test.js', transform(input), { mangle: true }).code;
  loadAngular();
  vm.runInThisContext(code);
  const injector = global.angular.bootstrap(global.document.body, ['migrationSmoke'], { strictDi: true });
  assert.equal(injector.get('Service').value, 'ready');
  assert.equal(global.bootstrapResult, 'ready');
});

function loadAngular() {
  function noop() {
    return undefined;
  }

  function element() {
    return {
      nodeType: 1, nodeName: 'DIV', style: {}, childNodes: [], children: [], attributes: [], firstChild: null,
      setAttribute: noop, getAttribute: () => null, hasAttribute: () => false, removeAttribute: noop,
      appendChild: noop, insertBefore: noop, removeChild: noop, cloneNode: element,
      addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
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
        for (const key of ['href', 'protocol', 'host', 'search', 'hash', 'hostname', 'port', 'pathname']) output[key] = url[key];
      };
    }
    return output;
  };
  document.getElementsByTagName = tag => tag === 'head' ? [document.head] : [];
  global.window = global;
  global.document = document;
  global.location = { href: 'http://localhost/' };
  global.navigator = { userAgent: 'node' };
  global.Node = function() {};
  global.Element = function() {};
  require('angular/angular');
}
