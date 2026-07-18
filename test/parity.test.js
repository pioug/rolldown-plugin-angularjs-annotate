const test = require('node:test');
const assert = require('node:assert');
const MagicString = require('magic-string');
const { minifySync, parseSync } = require('rolldown/utils');
const annotate = require('../src/annotate');

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
});

function transform(code, options = {}) {
  const parsed = parseSync('fixture.js', code, { sourceType: 'unambiguous' });
  if (parsed.errors.length) throw parsed.errors[0];
  const magicString = new MagicString(code);
  annotate(parsed.program, code, magicString, options);
  return magicString.toString();
}

function compact(code) {
  return minifySync('fixture.js', code, { compress: false, mangle: false }).code;
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
      for (const fixtureCase of casesFor(fixture)) {
        await t.test(fixtureCase.name, () => {
          assert.equal(compact(transform(fixtureCase.input)), compact(fixtureCase.expected));
        });
      }

      if (fixture.explicit && !fixture.contextDependent) {
        await t.test(`${fixture.name} - explicitOnly`, () => {
          assert.equal(
            compact(transform(functionBody(fixture.input), { explicitOnly: true })),
            compact(functionBody(fixture.expected)),
          );
        });
      }

      if (fixture.implicit && !fixture.contextDependent) {
        await t.test(`${fixture.name} - explicitOnly`, () => {
          const input = functionBody(fixture.input);
          assert.equal(compact(transform(input, { explicitOnly: true })), compact(input));
        });
      }
    }
  });
}
