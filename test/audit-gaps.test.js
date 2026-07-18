const test = require('node:test');
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
  }, code, settings.id || 'audit.js', settings.meta);

  return {
    code: result ? result.code.toString() : code,
    warnings,
  };
}

function compact(code, id = 'audit.js') {
  return minifySync(id, code, { compress: false, mangle: false }).code;
}

function assertTransform(input, expected, settings) {
  const actual = transform(input, settings).code;
  const id = settings?.id || 'audit.js';
  assert.equal(compact(actual, id), compact(expected, id));
}

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
      input: "const angularModule = require('angular'); const angular = angularModule.default; angular.module('x').run(function(commonjsDep) {});",
      expected: "const angularModule = require('angular'); const angular = angularModule.default; angular.module('x').run(['commonjsDep', function(commonjsDep) {}]);",
    },
    {
      name: 'named AMD factory',
      input: "define(['angular'], factory); function factory(angular) { angular.module('x').run(function(namedDep) {}); }",
      expected: "define(['angular'], factory); function factory(angular) { angular.module('x').run(['namedDep', function(namedDep) {}]); }",
    },
    {
      name: 'named AMD factory with referenced dependencies',
      input: "const dependencies = ['angular']; define(dependencies, factory); function factory(angular) { angular.module('x').run(function(referencedDep) {}); }",
      expected: "const dependencies = ['angular']; define(dependencies, factory); function factory(angular) { angular.module('x').run(['referencedDep', function(referencedDep) {}]); }",
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
  const input = "const angular = window.angular; angular.module('x').run(function(realDep) {}); function testShadow() { const angular = fakeAngular; angular.module('x').run(function(fakeDep) {}); }";
  const expected = "const angular = window.angular; angular.module('x').run(['realDep', function(realDep) {}]); function testShadow() { const angular = fakeAngular; angular.module('x').run(function(fakeDep) {}); }";
  assertTransform(input, expected);
});

test('Do not treat named imports from Angular as the Angular namespace', () => {
  const input = "import { version } from 'angular'; version.module('x').run(function(falsePositiveDep) {});";
  assert.equal(transform(input).code, input);
});

test('Recognize proven Angular aliases passed to direct IIFEs', () => {
  const input = "(function(angular) { angular.module('x').run(function(umdDep) {}); })(window.angular); (angular => angular.module('x').run(function(arrowDep) {}))(globalThis.angular);";
  const expected = "(function(angular) { angular.module('x').run(['umdDep', function(umdDep) {}]); })(window.angular); (angular => angular.module('x').run(['arrowDep', function(arrowDep) {}]))(globalThis.angular);";
  assertTransform(input, expected);
});

test('Recognize proven destructured Angular aliases', () => {
  const input = "const { default: angular } = require('angular'); angular.module('x').run(function(cjsDep) {}); function nested() { const { angular } = window; angular.module('x').run(function(windowDep) {}); } function renamed() { const { angular: ng } = globalThis; ng.module('x').run(function(globalDep) {}); }";
  const expected = "const { default: angular } = require('angular'); angular.module('x').run(['cjsDep', function(cjsDep) {}]); function nested() { const { angular } = window; angular.module('x').run(['windowDep', function(windowDep) {}]); } function renamed() { const { angular: ng } = globalThis; ng.module('x').run(['globalDep', function(globalDep) {}]); }";
  assertTransform(input, expected);
});

test('Reject unproven and shadowed destructured Angular aliases', () => {
  const input = "const { version: angular } = require('angular'); angular.module('x').run(function(namedDep) {}); function nested() { const window = fakeWindow; const { angular } = window; angular.module('x').run(function(shadowedDep) {}); }";
  assert.equal(transform(input).code, input);
});

test('Recognize wrapped long-form Angular receivers', () => {
  const input = "const angular = window.angular; (angular).module('x').run(function(wrappedDep) {});";
  const expected = "const angular = window.angular; (angular).module('x').run(['wrappedDep', function(wrappedDep) {}]);";
  assertTransform(input, expected);

  const typescript = "declare const angular: any; (angular as any).module('x').run(function(assertedDep: Service) {}); angular!.module('x').run(function(nonNullDep: Service) {});";
  const output = transform(typescript, { id: 'audit.ts' }).code;
  assert.match(output, /\.run\(\["assertedDep", function\(assertedDep: Service\)/);
  assert.match(output, /\.run\(\["nonNullDep", function\(nonNullDep: Service\)/);
});

test('Scan nested provider and directive targets through pre-annotated arrays', () => {
  const input = "angular.module('x').provider('provider', ['outer', function(outer) { this.$get = function(providerDep) {}; }]).directive('directive', ['outer', function(outer) { return { controller: function(controllerDep) {} }; }]);";
  const expected = "angular.module('x').provider('provider', ['outer', function(outer) { this.$get = ['providerDep', function(providerDep) {}]; }]).directive('directive', ['outer', function(outer) { return { controller: ['controllerDep', function(controllerDep) {}] }; }]);";
  assertTransform(input, expected);
});

test('Scan nested provider and directive targets when the outer factory is blocked', () => {
  const input = "Provider.$inject = ['outer']; function Provider(outer) { this.$get = function(providerDep) {}; } function Directive(outer) { 'ngNoInject'; return { controller: function(controllerDep) {} }; } angular.module('x').provider('provider', Provider).directive('directive', Directive);";
  const expected = "Provider.$inject = ['outer']; function Provider(outer) { this.$get = ['providerDep', function(providerDep) {}]; } function Directive(outer) { 'ngNoInject'; return { controller: ['controllerDep', function(controllerDep) {}] }; } angular.module('x').provider('provider', Provider).directive('directive', Directive);";
  assertTransform(input, expected);
});

test('Scan nested targets through conditional and logical pre-annotated bindings', () => {
  const input = "const provider = choose ? ['outer', function(outer) { this.$get = function(leftDep) {}; }] : ['outer', function(outer) { this.$get = function(rightDep) {}; }]; const directive = fallback || ['outer', function(outer) { return { controller: function(controllerDep) {} }; }]; angular.module('x').provider('provider', provider).directive('directive', directive);";
  const expected = "const provider = choose ? ['outer', function(outer) { this.$get = ['leftDep', function(leftDep) {}]; }] : ['outer', function(outer) { this.$get = ['rightDep', function(rightDep) {}]; }]; const directive = fallback || ['outer', function(outer) { return { controller: ['controllerDep', function(controllerDep) {}] }; }]; angular.module('x').provider('provider', provider).directive('directive', directive);";
  assertTransform(input, expected);
});

test('Scan nested provider and directive targets returned by binding IIFEs', () => {
  const input = "const Provider = (() => ['outer', function(outer) { this.$get = function(providerDep) {}; }])(); const Directive = (() => ['outer', function(outer) { return { controller: function(controllerDep) {} }; }])(); angular.module('x').provider('provider', Provider).directive('directive', Directive);";
  const expected = "const Provider = (() => ['outer', function(outer) { this.$get = ['providerDep', function(providerDep) {}]; }])(); const Directive = (() => ['outer', function(outer) { return { controller: ['controllerDep', function(controllerDep) {}] }; }])(); angular.module('x').provider('provider', Provider).directive('directive', Directive);";
  assertTransform(input, expected);
});

test('Scan nested targets inside ngNoInject registration wrappers', () => {
  const input = "angular.module('x').provider('provider', ngNoInject(function(outer) { this.$get = function(providerDep) {}; })).directive('directive', ngNoInject(function(outer) { return { controller: function(controllerDep) {} }; }));";
  const expected = "angular.module('x').provider('provider', ngNoInject(function(outer) { this.$get = ['providerDep', function(providerDep) {}]; })).directive('directive', ngNoInject(function(outer) { return { controller: ['controllerDep', function(controllerDep) {}] }; }));";
  assertTransform(input, expected);
});

test('Recognize parenthesized annotation wrapper callees', () => {
  const input = "angular.module('x').factory('factory', (ngInject)(function(factoryDep) {})).provider('provider', (ngNoInject)(function(outer) { this.$get = function(providerDep) {}; }));";
  const expected = "angular.module('x').factory('factory', (ngInject)(['factoryDep', function(factoryDep) {}])).provider('provider', (ngNoInject)(function(outer) { this.$get = ['providerDep', function(providerDep) {}]; }));";
  assertTransform(input, expected);

  const typescript = "angular.module('x').factory('factory', (ngInject as typeof ngInject)(function(tsDep: Service) {}));";
  assert.match(transform(typescript, { id: 'audit.ts' }).code, /ngInject as typeof ngInject\)\(\["tsDep", function\(tsDep: Service\)/);
});

test('Scan nested targets through blocked wrappers in indirect registration paths', () => {
  const input = "const Provider = choose ? ngNoInject(function(outer) { this.$get = function(providerDep) {}; }) : ['outer', function(outer) { this.$get = function(fallbackDep) {}; }]; const Directive = (() => ngNoInject(function(outer) { return { controller: function(controllerDep) {} }; }))(); angular.module('x').provider('provider', Provider).directive('directive', Directive);";
  const expected = "const Provider = choose ? ngNoInject(function(outer) { this.$get = ['providerDep', function(providerDep) {}]; }) : ['outer', function(outer) { this.$get = ['fallbackDep', function(fallbackDep) {}]; }]; const Directive = (() => ngNoInject(function(outer) { return { controller: ['controllerDep', function(controllerDep) {}] }; }))(); angular.module('x').provider('provider', Provider).directive('directive', Directive);";
  assertTransform(input, expected);
});

test('Scan nested targets through assignment and sequence IIFE returns', () => {
  const input = "let assigned; const AssignmentProvider = (() => assigned = ['outer', function(outer) { this.$get = function(assignmentDep) {}; }])(); const SequenceProvider = (() => (sideEffect(), ['outer', function(outer) { this.$get = function(sequenceDep) {}; }]))(); angular.module('x').provider('assignment', AssignmentProvider).provider('sequence', SequenceProvider);";
  const expected = "let assigned; const AssignmentProvider = (() => assigned = ['outer', function(outer) { this.$get = ['assignmentDep', function(assignmentDep) {}]; }])(); const SequenceProvider = (() => (sideEffect(), ['outer', function(outer) { this.$get = ['sequenceDep', function(sequenceDep) {}]; }]))(); angular.module('x').provider('assignment', AssignmentProvider).provider('sequence', SequenceProvider);";
  assertTransform(input, expected);
});

test('Ignore TypeScript fake this parameters when deriving dependencies', () => {
  const input = "interface Context {} interface Service {} angular.module('x').run(function(this: Context, dep: Service) {});";
  const output = transform(input, { id: 'audit.ts' }).code;
  assert.match(output, /\.run\(\["dep", function\(this: Context, dep: Service\)/);
  assert.doesNotMatch(output, /\["this"/);
});

test('Use the TypeScript constructor implementation rather than an overload signature', () => {
  const input = "interface Dependency {} class Service { constructor(overloadName: Dependency); constructor(runtimeDep: Dependency) {} } angular.module('x').service('Service', Service);";
  const output = transform(input, { id: 'audit.ts' }).code;
  assert.match(output, /Service\.\$inject = \["runtimeDep"\];/);
  assert.doesNotMatch(output, /\["overloadName"\]/);
});

test('Ignore explicit prologues in non-injectable methods and accessors', () => {
  const input = "class Service { method(methodDep) { 'ngInject'; } static other(staticDep) { 'ngInject'; } } const object = { set value(setterDep) { 'ngInject'; } };";
  assert.equal(transform(input).code, input);
});

test('Reject an explicitly marked existing array with too few annotations', () => {
  const input = "angular.module('x').run(['first', function(first, second) { 'ngInject'; }]);";
  assert.throws(
    () => transform(input),
    error => {
      assert.match(error.message, /Function parameters do not match existing annotations/);
      assert.equal(error.id, 'audit.js');
      assert.equal(error.pluginCode, 'ANNOTATION_MISMATCH');
      assert.ok(Number.isInteger(error.start));
      return true;
    },
  );
});

test('Warn about an explicitly marked existing array with mismatched annotations', () => {
  const input = "angular.module('x').run(['wrong', function(actual) { 'ngInject'; }]);";
  const { warnings } = transform(input);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].log.message, /Function parameters do not match existing annotations/);
  assert.equal(warnings[0].log.id, 'audit.js');
  assert.equal(warnings[0].log.pluginCode, 'ANNOTATION_MISMATCH');
  assert.ok(Number.isInteger(warnings[0].position));
});

test('Apply a declaration-level ngInject marker to every object declarator', () => {
  const input = "/* @ngInject */ const first = { start: function(firstDep) {} }, second = { nested: { start: function(secondDep) {} } };";
  const expected = "/* @ngInject */ const first = { start: ['firstDep', function(firstDep) {}] }, second = { nested: { start: ['secondDep', function(secondDep) {}] } };";
  assertTransform(input, expected);
});

test('Apply a declaration-level ngNoInject marker to every object declarator', () => {
  const input = "/* @ngNoInject */ const first = { start: function(firstDep) { 'ngInject'; } }, second = { nested: { start: function(secondDep) { 'ngInject'; } } };";
  assert.equal(transform(input).code, input);
});

test('Honor explicit markers before parenthesized callables', () => {
  const input = "const named = /* @ngInject */ (function(namedDep) {}); consume(/* @ngInject */ ((function(argumentDep) {}))); const blocked = /* @ngNoInject */ (function(blockedDep) { 'ngInject'; });";
  const expected = "const named = /* @ngInject */ (function(namedDep) {}); named.$inject = ['namedDep']; consume(/* @ngInject */ ((['argumentDep', function(argumentDep) {}]))); const blocked = /* @ngNoInject */ (function(blockedDep) { 'ngInject'; });";
  assertTransform(input, expected);
});

test('Use multi-function ngNoInject only to suppress explicit annotations', () => {
  const declaration = "/* @ngNoInject */ const first = function(firstDep) { 'ngInject'; }, second = function(secondDep) { 'ngInject'; };";
  assert.equal(transform(declaration).code, declaration);
  assert.equal(transform(declaration, { options: { explicitOnly: true } }).code, declaration);

  const registered = `${declaration} angular.module('x').controller('first', first).controller('second', second);`;
  const expected = `${declaration}\nfirst.$inject = [\"firstDep\"];\nsecond.$inject = [\"secondDep\"]; angular.module('x').controller('first', first).controller('second', second);`;
  assertTransform(registered, expected);
  assert.equal(transform(registered, { options: { explicitOnly: true } }).code, registered);
});

test('Use multi-class ngNoInject only to suppress explicit constructor annotations', () => {
  const declaration = "/* @ngNoInject */ const First = class { constructor(firstDep) { 'ngInject'; } }, Second = class { constructor(secondDep) { 'ngInject'; } };";
  assert.equal(transform(declaration).code, declaration);
  assert.equal(transform(declaration, { options: { explicitOnly: true } }).code, declaration);

  const registered = `${declaration} angular.module('x').service('First', First).service('Second', Second);`;
  const output = transform(registered).code;
  assert.match(output, /First\.\$inject = \["firstDep"\];/);
  assert.match(output, /Second\.\$inject = \["secondDep"\];/);
  assert.equal(transform(registered, { options: { explicitOnly: true } }).code, registered);
});

test('Follow a directly returned local directive helper', () => {
  const input = "angular.module('x').directive('directive', function() { function makeDefinition() { return { controller: function(controllerDep) {} }; } return makeDefinition(); });";
  const expected = "angular.module('x').directive('directive', function() { function makeDefinition() { return { controller: ['controllerDep', function(controllerDep) {}] }; } return makeDefinition(); });";
  assertTransform(input, expected);
});

test('Follow optional and sequence-wrapped local directive helpers', () => {
  const input = "angular.module('x').directive('optional', function() { function makeOptional() { return { controller: function(optionalDep) {} }; } return makeOptional?.(); }).directive('sequence', function() { function makeSequence() { return { controller: function(sequenceDep) {} }; } return (0, makeSequence)(); });";
  const expected = "angular.module('x').directive('optional', function() { function makeOptional() { return { controller: ['optionalDep', function(optionalDep) {}] }; } return makeOptional?.(); }).directive('sequence', function() { function makeSequence() { return { controller: ['sequenceDep', function(sequenceDep) {}] }; } return (0, makeSequence)(); });";
  assertTransform(input, expected);
});

test('Do not interpret parenthesized strings as directive prologues', () => {
  const input = "const unrelated = function(explicitDep) { ('ngInject'); }; angular.module('x').run(function(contextDep) { ('ngNoInject'); });";
  const expected = "const unrelated = function(explicitDep) { ('ngInject'); }; angular.module('x').run(['contextDep', function(contextDep) { ('ngNoInject'); }]);";
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

test('Resolve a later const when its Angular registration is deferred until after initialization', () => {
  const input = "function register() { angular.module('x').controller('Later', Later); } const Later = function(laterDep) {}; register();";
  const expected = "function register() { angular.module('x').controller('Later', Later); } const Later = function(laterDep) {}; Later.$inject = ['laterDep']; register();";
  assertTransform(input, expected);
});

test('Resolve a later class when its Angular registration is deferred until after initialization', () => {
  const input = "function register() { angular.module('x').service('Service', Service); } class Service { constructor(classDep) {} } register();";
  const expected = "function register() { angular.module('x').service('Service', Service); } class Service { constructor(classDep) {} } Service.$inject = ['classDep']; register();";
  assertTransform(input, expected);
});

test('Resolve only initialized and effectively immutable later let bindings', () => {
  const safeInput = "function register() { angular.module('x').controller('Later', Later); } let Later = function(laterDep) {}; register();";
  const safeExpected = "function register() { angular.module('x').controller('Later', Later); } let Later = function(laterDep) {}; Later.$inject = ['laterDep']; register();";
  assertTransform(safeInput, safeExpected);

  const assignedLater = "function register() { angular.module('x').controller('Later', Later); } let Later; Later = function(laterDep) {}; register();";
  assert.equal(transform(assignedLater).code, assignedLater);

  const reassigned = "function register() { angular.module('x').controller('Later', Later); } let Later = function(firstDep) {}; Later = function(secondDep) {}; register();";
  assert.equal(transform(reassigned).code, reassigned);
});

test('Resolve only initialized and effectively immutable later var bindings', () => {
  const safeInput = "function register() { angular.module('x').controller('Later', Later); } var Later = function(varDep) {}; register();";
  const safeExpected = "function register() { angular.module('x').controller('Later', Later); } var Later = function(varDep) {}; Later.$inject = ['varDep']; register();";
  assertTransform(safeInput, safeExpected);

  const assignedLater = "function register() { angular.module('x').controller('Later', Later); } var Later; Later = function(varDep) {}; register();";
  assert.equal(transform(assignedLater).code, assignedLater);

  const reassigned = "function register() { angular.module('x').controller('Later', Later); } var Later = function(firstDep) {}; Later = function(secondDep) {}; register();";
  assert.equal(transform(reassigned).code, reassigned);
});

test('Allow regexp to match a call-expression module receiver', () => {
  const input = "require('app-module').controller('Controller', function(callDep) {});";
  const expected = "require('app-module').controller('Controller', ['callDep', function(callDep) {}]);";
  assertTransform(input, expected, { options: { regexp: '^require\\(.+\\)$' } });
});
