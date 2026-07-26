const test = require('node:test');
const assert = require('node:assert');
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');
const { default: MagicString } = require('magic-string');
const { rolldown } = require('rolldown');
const { parseSync } = require('rolldown/utils');
const angularjsAnnotate = require('..');

function transform(plugin, code, id, meta) {
  return plugin.transform.handler.call({ warn() {} }, code, id, meta);
}

function positionOf(code, token) {
  const index = code.indexOf(token);
  assert.notEqual(index, -1, `Expected code to contain ${JSON.stringify(token)}`);
  const prefix = code.slice(0, index);
  const lines = prefix.split('\n');
  return { line: lines.length, column: lines.at(-1).length };
}

async function bundleVirtual(plugin, code, id, moduleType) {
  const build = await rolldown({
    input: id,
    plugins: [
      {
        name: 'virtual-entry',
        resolveId(source) { if (source === id) return source; },
        load(source) {
          if (source !== id) return;
          return moduleType ? { code, moduleType } : code;
        },
      },
      plugin,
    ],
  });
  try {
    const output = await build.generate({ format: 'esm' });
    return output.output[0].code;
  } finally {
    await build.close();
  }
}

test('Expose CommonJS and ESM-compatible public exports', async () => {
  assert.equal(angularjsAnnotate.angularjsAnnotate, angularjsAnnotate);
  assert.equal(typeof angularjsAnnotate.annotate, 'function');
  const core = require('rolldown-plugin-angularjs-annotate/core');
  assert.equal(core, angularjsAnnotate.annotate);

  const namespace = await import('../index.js');
  assert.equal(namespace.default, angularjsAnnotate);
  assert.equal(namespace.angularjsAnnotate, angularjsAnnotate);
  assert.equal(namespace.annotate, angularjsAnnotate.annotate);

  const coreNamespace = await import('rolldown-plugin-angularjs-annotate/core');
  assert.equal(coreNamespace.default, core);
});

test('Transform consistently with standalone and native MagicString', () => {
  const code = "angular.module('x').run(function($http) {});";
  const plugin = angularjsAnnotate();
  const standalone = transform(plugin, code, 'test.js');
  const magicString = new MagicString(code);
  const native = transform(plugin, code, 'test.js', {
    ast: parseSync('test.js', code, { sourceType: 'unambiguous' }).program,
    magicString,
  });
  assert.equal(native.code, magicString);
  assert.equal(native.code.toString(), standalone.code);
  assert.ok(standalone.map);
});

test('Scan explicit comments from a native AST without matching literal text', () => {
  const code = [
    "const example = '/* @ngInject */';",
    'function untouched(ignored) {}',
    '/* @ngInject */',
    'function marked(dep) {}',
  ].join('\n');
  const magicString = new MagicString(code);
  const result = transform(angularjsAnnotate(), code, 'test.js', {
    ast: parseSync('test.js', code, { sourceType: 'unambiguous' }).program,
    magicString,
  });

  assert.equal(result.code, magicString);
  assert.doesNotMatch(result.code.toString(), /untouched\.\$inject/);
  assert.match(result.code.toString(), /marked\.\$inject = \["dep"\]/);
});

test('Map generated code back to its original positions', () => {
  const code = [
    "angular.module('x').run(function($http) {",
    "  return $http.get('/resource');",
    '});',
  ].join('\n');
  const result = transform(angularjsAnnotate(), code, 'test.js');
  const traceMap = new TraceMap(result.map);

  assert.deepEqual(result.map.sources, ['test.js']);
  assert.deepEqual(result.map.sourcesContent, [code]);
  for (const token of ['function', '$http.get', "'/resource'"]) {
    assert.deepEqual(
      originalPositionFor(traceMap, positionOf(result.code, token)),
      { source: 'test.js', ...positionOf(code, token), name: null },
    );
  }
});

test('Delegate default exclusions to Rolldown hook filters', async () => {
  const plugin = angularjsAnnotate();
  const code = "angular.module('x').run(function(excludedDep) {});";
  const output = await bundleVirtual(plugin, code, '/project/node_modules/x.js');
  assert.doesNotMatch(output, /\["excludedDep"/);
});

test('Support native glob, array, and RegExp hook filters', async () => {
  const include = /\.js$/g;
  const plugin = angularjsAnnotate({ include: ['**/*.js', include], exclude: '**/vendor/**' });
  const code = "angular.module('x').run(function(dep) {});";

  assert.match(await bundleVirtual(plugin, code, '/project/source/one.js'), /\["dep"/);
  assert.match(await bundleVirtual(plugin, code, '/project/source/two.js'), /\["dep"/);
  assert.doesNotMatch(await bundleVirtual(plugin, code, '/project/vendor/three.js'), /\["dep"/);
  assert.doesNotMatch(await bundleVirtual(plugin, code, '/project/source/four.css', 'js'), /\["dep"/);
});

test('Skip the transform hook when code has no annotation hints', async () => {
  const plugin = angularjsAnnotate();
  const handler = plugin.transform.handler;
  let transforms = 0;
  plugin.transform.handler = function(...args) {
    transforms++;
    return handler.apply(this, args);
  };

  assert.match(
    await bundleVirtual(plugin, 'export const answer = 42;', '/project/source.js'),
    /const answer = 42/,
  );
  assert.equal(transforms, 0);
});

test('Keep supported escaped annotation candidates inside the native code filter', async () => {
  const implicit = await bundleVirtual(
    angularjsAnnotate(),
    "angular.module('x').contr\\u006fller('name', function(dep) {});",
    '/project/implicit.js',
  );
  const explicit = await bundleVirtual(
    angularjsAnnotate({ explicitOnly: true }),
    "function handler(dep) { 'ng\\u0049nject'; } export { handler };",
    '/project/explicit.js',
  );

  assert.match(implicit, /\["dep", function\(dep\)/);
  assert.match(explicit, /handler\.\$inject = \["dep"\]/);

  const codeFilter = angularjsAnnotate().transform.filter.code;
  const lineContinuation = ["function handler(dep) { 'ngIn\\", "ject'; }"].join('\n');
  for (const code of [
    String.raw`function handler(dep) { 'ng\x49nject'; }`,
    String.raw`function handler(dep) { 'ng\111nject'; }`,
    lineContinuation,
  ]) {
    assert.equal(codeFilter.test(code), true);
  }
  assert.equal(codeFilter.test(String.raw`const pattern = /\d+/; const text = 'line\n';`), false);
});

test('Allow comments between member access and implicit annotation methods', async () => {
  const blockComment = await bundleVirtual(
    angularjsAnnotate(),
    "angular.module('x')./* gap */controller('name', function(blockDep) {});",
    '/project/block-comment.js',
  );
  const lineComment = await bundleVirtual(
    angularjsAnnotate(),
    "angular.module('x').// gap\ncontroller('name', function(lineDep) {});",
    '/project/line-comment.js',
  );

  assert.match(blockComment, /\["blockDep", function\(blockDep\)/);
  assert.match(lineComment, /\["lineDep", function\(lineDep\)/);
});

test('Parse transformed Vue script IDs and reject parser failures as Errors', () => {
  const plugin = angularjsAnnotate();
  const code = "angular.module('x').run((dep: Service) => {});";
  assert.ok(transform(plugin, code, '/project/App.vue?vue&type=script&lang.ts'));
  assert.ok(transform(plugin, code, '/project/tsx/source.ts'));
  assert.ok(transform(plugin, code, '/project/App.vue', { moduleType: 'ts' }));
  let parseError;
  assert.throws(() => transform(plugin, 'angular.module(', 'broken.js'), error => {
    parseError = error;
    return error instanceof SyntaxError;
  });
  assert.equal(parseError.id, 'broken.js');
  assert.equal(parseError.pluginCode, 'PARSE_ERROR');
  assert.match(parseError.message, /^broken\.js: /);
});

test('Report annotation failures through the structured Rolldown error API', () => {
  const plugin = angularjsAnnotate();
  const input = "angular.module('x').run(['first', function(first, second) { 'ngInject'; }]);";
  const diagnostics = [];

  assert.throws(() => plugin.transform.handler.call({
    error(log, position) {
      diagnostics.push({ log, position });
      throw log;
    },
    warn() {},
  }, input, 'mismatch.js'), /Function parameters do not match existing annotations/);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].log.id, 'mismatch.js');
  assert.equal(diagnostics[0].log.pluginCode, 'ANNOTATION_MISMATCH');
  assert.ok(Number.isInteger(diagnostics[0].position));
});

test('Respect custom includes even when Rolldown supplies a JavaScript module type', async () => {
  const plugin = angularjsAnnotate({ include: '**/included/**' });
  const code = "angular.module('x').run(function(dep) {});";
  assert.match(await bundleVirtual(plugin, code, '/project/included/App.vue', 'js'), /\["dep"/);
  assert.doesNotMatch(await bundleVirtual(plugin, code, '/project/excluded/App.vue', 'js'), /\["dep"/);

  const defaults = angularjsAnnotate({ include: undefined });
  assert.match(await bundleVirtual(defaults, code, '/project/App.vue', 'js'), /\["dep"/);
});

for (const nativeMagicString of [false, true]) {
  test(`Transform through a real Rolldown build (nativeMagicString: ${nativeMagicString})`, async () => {
    const code = "angular.module('x').run(function(dep) {});";
    const build = await rolldown({
      input: 'entry.js',
      experimental: { nativeMagicString },
      plugins: [
        {
          name: 'virtual-entry',
          resolveId(id) { if (id === 'entry.js') return id; },
          load(id) { if (id === 'entry.js') return code; },
        },
        angularjsAnnotate(),
      ],
    });
    try {
      const output = await build.generate({ format: 'esm', sourcemap: true });
      assert.match(output.output[0].code, /\.run\(\["dep", function\(dep\)/);
      assert.ok(output.output[0].map);
      assert.equal(output.output[0].map.sources.length, 1);
      assert.match(output.output[0].map.sources[0], /entry\.js$/);
      const original = originalPositionFor(
        new TraceMap(output.output[0].map),
        positionOf(output.output[0].code, 'function(dep)'),
      );
      assert.match(original.source, /entry\.js$/);
      assert.deepEqual(
        { line: original.line, column: original.column },
        positionOf(code, 'function(dep)'),
      );
    } finally {
      await build.close();
    }
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
  try {
    const output = await build.generate({ format: 'esm' });
    assert.match(output.output[0].code, /\.run\(\["dep", function\(dep\)/);
  } finally {
    await build.close();
  }
});
