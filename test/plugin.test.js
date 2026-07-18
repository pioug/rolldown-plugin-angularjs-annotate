const test = require('node:test');
const assert = require('node:assert');
const MagicString = require('magic-string');
const { rolldown } = require('rolldown');
const { parseSync } = require('rolldown/utils');
const angularjsAnnotate = require('..');

function transform(plugin, code, id, meta) {
  return plugin.transform.handler.call({ warn() {} }, code, id, meta);
}

test('Expose CommonJS and ESM-compatible public exports', async () => {
  assert.equal(angularjsAnnotate.default, angularjsAnnotate);
  assert.equal(angularjsAnnotate.angularjsAnnotate, angularjsAnnotate);
  assert.equal(typeof angularjsAnnotate.annotate, 'function');

  const namespace = await import('../index.js');
  assert.equal(namespace.default, angularjsAnnotate);
  assert.equal(namespace.angularjsAnnotate, angularjsAnnotate);
  assert.equal(namespace.annotate, angularjsAnnotate.annotate);
});

test('Transform consistently in Rolldown and fallback environments', () => {
  const code = "angular.module('x').run(function($http) {});";
  const plugin = angularjsAnnotate();
  const fallback = transform(plugin, code, 'test.js');
  const magicString = new MagicString(code);
  const native = transform(plugin, code, 'test.js', {
    ast: parseSync('test.js', code, { sourceType: 'unambiguous' }).program,
    magicString,
  });
  assert.equal(native.code, magicString);
  assert.equal(native.code.toString(), fallback.code);
  assert.ok(fallback.map);
});

test('Skip excluded files', () => {
  const plugin = angularjsAnnotate();
  assert.equal(transform(plugin, 'function x(dep) {}', 'node_modules/x.js'), undefined);
  assert.equal(transform(plugin, 'function x(dep) {}', '/project/node_modules/x.js'), undefined);
  assert.equal(transform(plugin, 'function x(dep) {}', 'component.vue'), undefined);
});

test('Support glob, array, and stateful RegExp filters', () => {
  const include = /\.js$/g;
  const plugin = angularjsAnnotate({ include: ['**/*.js', include], exclude: '**/vendor/**' });
  const code = "angular.module('x').run(function(dep) {});";

  assert.ok(transform(plugin, code, '/project/source/one.js'));
  assert.ok(transform(plugin, code, '/project/source/two.js'));
  assert.equal(transform(plugin, code, '/project/vendor/three.js'), undefined);
  assert.equal(transform(plugin, code, '/project/source/four.css'), undefined);
});

test('Parse transformed Vue script IDs and reject parser failures as Errors', () => {
  const plugin = angularjsAnnotate();
  const code = "angular.module('x').run((dep: Service) => {});";
  assert.ok(transform(plugin, code, '/project/App.vue?vue&type=script&lang.ts'));
  assert.ok(transform(plugin, code, '/project/tsx/source.ts'));
  assert.ok(transform(plugin, code, '/project/App.vue', { moduleType: 'ts' }));
  assert.throws(() => transform(plugin, 'angular.module(', 'broken.js'), SyntaxError);
});

test('Respect custom includes even when Rolldown supplies a JavaScript module type', () => {
  const plugin = angularjsAnnotate({ include: '**/included/**' });
  const code = "angular.module('x').run(function(dep) {});";
  assert.ok(transform(plugin, code, '/project/included/App.vue', { moduleType: 'js' }));
  assert.equal(transform(plugin, code, '/project/excluded/App.vue', { moduleType: 'js' }), undefined);

  const defaults = angularjsAnnotate({ include: undefined });
  assert.ok(transform(defaults, code, '/project/App.vue', { moduleType: 'js' }));
});

for (const nativeMagicString of [false, true]) {
  test(`Transform through a real Rolldown build (nativeMagicString: ${nativeMagicString})`, async () => {
    const build = await rolldown({
      input: 'entry.js',
      experimental: { nativeMagicString },
      plugins: [
        {
          name: 'virtual-entry',
          resolveId(id) { if (id === 'entry.js') return id; },
          load(id) { if (id === 'entry.js') return "angular.module('x').run(function(dep) {});"; },
        },
        angularjsAnnotate(),
      ],
    });
    const output = await build.generate({ format: 'esm', sourcemap: true });
    assert.match(output.output[0].code, /\.run\(\["dep", function\(dep\)/);
    assert.ok(output.output[0].map);
    assert.equal(output.output[0].map.sources.length, 1);
    assert.match(output.output[0].map.sources[0], /entry\.js$/);
  });
}

test('Transform a framework-generated JavaScript module with a non-script ID', async () => {
  const build = await rolldown({
    input: '/project/App.vue',
    plugins: [
      {
        name: 'virtual-sfc',
        resolveId(id) { if (id === '/project/App.vue') return id; },
        load(id) {
          if (id === '/project/App.vue') {
            return { code: "angular.module('x').run(function(dep) {});", moduleType: 'js' };
          }
        },
      },
      angularjsAnnotate(),
    ],
  });
  const output = await build.generate({ format: 'esm' });
  assert.match(output.output[0].code, /\.run\(\["dep", function\(dep\)/);
});
