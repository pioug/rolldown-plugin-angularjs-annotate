const test = require('node:test');
const assert = require('node:assert');
const babel = require('@babel/core');
const { default: MagicString } = require('magic-string');
const { parseSync } = require('rolldown/utils');
const annotate = require('../src/annotate');

const ES5_BABEL_OPTIONS = {
  presets: [
    [require.resolve('@babel/preset-env'), {
      exclude: ['transform-function-name'],
      modules: 'commonjs',
    }],
  ],
  targets: { ie: '11' },
};

const FIXTURE_ROOT = 'babel-plugin-angularjs-annotate/tests';
const SUITES = [
  'simple',
  'simple-arrow',
  'provider$get',
  'inside_module',
  'ui-router',
  'modals',
  'ngInject',
  'ngInject-arrow',
  'issues',
  'references',
  'es6',
].map(name => require(`${FIXTURE_ROOT}/${name}`));

test('Load the complete active upstream fixture corpus', () => {
  assert.equal(SUITES.length, 11);
  assert.equal(SUITES.reduce((count, suite) => count + suite.tests.length, 0), 131);
  assert.equal(SUITES.reduce((count, suite) => count + suite.tests.reduce((suiteCount, fixture) => {
    const cases = fixture.contextDependent ? 2 : 1;
    const explicitOnly = !fixture.contextDependent && (fixture.explicit || fixture.implicit) ? 1 : 0;
    return suiteCount + (cases + explicitOnly) * Number(!fixture.noES6);
  }, 0), 0), 258);
  assert.equal(SUITES.reduce((count, suite) => count + suite.tests.reduce((suiteCount, fixture) => {
    const cases = fixture.contextDependent ? 2 : 1;
    const explicitOnly = !fixture.contextDependent && (fixture.explicit || fixture.implicit) ? 1 : 0;
    return suiteCount + (cases + explicitOnly) * Number(!fixture.noES5);
  }, 0), 0), 250);
});

function transform(code, options = {}) {
  const parsed = parseSync('fixture.js', code, { sourceType: 'unambiguous' });
  if (parsed.errors.length) throw parsed.errors[0];
  const magicString = new MagicString(code);
  annotate(parsed.program, code, magicString, options);
  return magicString.toString();
}

function compile(code, babelOptions) {
  return babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    compact: true,
    comments: true,
    ...babelOptions,
  }).code.trim().replace(/\n/g, '');
}

function modesFor(fixture) {
  const modes = [];
  if (!fixture.noES5) modes.push({ name: 'ES5', babelOptions: ES5_BABEL_OPTIONS });
  if (!fixture.noES6) modes.push({ name: 'ES2015', babelOptions: { presets: [] } });
  return modes;
}

function functionBody(value) {
  if (typeof value !== 'function') return value;
  const match = value.toString().match(/function[^{]*\{([\s\S]*)\}$/);
  assert.ok(match, 'fixture must be a traditional function or source string');
  return match[1];
}

function insideAngularModule(value) {
  return `angular.module("MyMod").directive("pleasematchthis", function() {\n${functionBody(value)}\n});`;
}

function outsideAngularModule(value) {
  return `foobar.irrespective("dontmatchthis", function() {\n${functionBody(value)}\n});`;
}

function casesFor(fixture) {
  if (!fixture.contextDependent) {
    return [{ name: fixture.name, input: functionBody(fixture.input), expected: functionBody(fixture.expected) }];
  }
  return [
    {
      name: `${fixture.name} - inside module`,
      input: insideAngularModule(fixture.input),
      expected: insideAngularModule(fixture.expected),
    },
    {
      name: `${fixture.name} - outside module`,
      input: outsideAngularModule(fixture.input),
      expected: outsideAngularModule(fixture.input),
    },
  ];
}

for (const suite of SUITES) {
  test(suite.name, async t => {
    for (const fixture of suite.tests) {
      for (const mode of modesFor(fixture)) {
        for (const fixtureCase of casesFor(fixture)) {
          await t.test(`${mode.name}: ${fixtureCase.name}`, () => {
            assert.equal(
              compile(transform(fixtureCase.input), mode.babelOptions),
              compile(fixtureCase.expected, mode.babelOptions),
            );
          });
        }

        if (fixture.explicit && !fixture.contextDependent) {
          await t.test(`${mode.name} explicitOnly: ${fixture.name}`, () => {
            assert.equal(
              compile(transform(functionBody(fixture.input), { explicitOnly: true }), mode.babelOptions),
              compile(functionBody(fixture.expected), mode.babelOptions),
            );
          });
        }

        if (fixture.implicit && !fixture.contextDependent) {
          await t.test(`${mode.name} explicitOnly: ${fixture.name}`, () => {
            const input = functionBody(fixture.input);
            assert.equal(
              compile(transform(input, { explicitOnly: true }), mode.babelOptions),
              compile(input, mode.babelOptions),
            );
          });
        }
      }
    }
  });
}
