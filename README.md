# rolldown-plugin-angularjs-annotate

AngularJS dependency-injection annotations for Rolldown, without a Babel
transform layer.

The annotator is behaviorally compatible with the active fixture suite from
`babel-plugin-angularjs-annotate@0.10.0`: all 131 fixtures across its 11 suites,
including context-sensitive negative cases and `explicitOnly`, run directly
against this implementation.

## Install

```sh
npm install --save-dev rolldown-plugin-angularjs-annotate
```

## Usage

```js
const angularjsAnnotate = require('rolldown-plugin-angularjs-annotate');

module.exports = {
  plugins: [angularjsAnnotate()]
};
```

The plugin uses Rolldown's filtered transform hook and native AST/MagicString
metadata when available. It runs in the `post` phase so framework plugins can
turn virtual modules, such as Vue single-file component scripts, into
JavaScript first.

This is a Rolldown plugin. Its package metadata deliberately marks Rollup as
incompatible rather than claiming support for an untested fallback host.

## Options

```js
angularjsAnnotate({
  include: ['**/src/**/*.js', '**/src/**/*.ts'],
  exclude: '**/*.spec.js',
  explicitOnly: false,
  regexp: '^app(?:\\..+)?$'
});
```

| Option | Meaning |
| --- | --- |
| `include` | String glob, `RegExp`, or array of either. Defaults to JavaScript/TypeScript IDs and modules Rolldown identifies as JavaScript/TypeScript, including framework-generated virtual modules. |
| `exclude` | String glob, `RegExp`, or array of either. Defaults to `node_modules` and Rolldown's runtime module. |
| `explicitOnly` | When `true`, only `@ngInject`, `ngInject`, and their no-inject counterparts are considered. |
| `regexp` | Restricts implicit short module receivers such as `app.controller(...)`. The compatibility default accepts identifier and dotted-property forms. |

Use `regexp: '^$'` to disable implicit short forms while retaining explicit
`angular.module(...)` chains.

## Supported annotations

Explicit annotation supports:

- `@ngInject` and `@ngNoInject` line, block, and JSDoc comments
- `"ngInject"` and `"ngNoInject"` directive prologues
- `ngInject(value)` and `ngNoInject(value)` wrappers
- functions, arrows, classes, constructors, assignments, references, exports,
  object properties, and recursively annotated object literals

Implicit matching supports:

- long and short AngularJS module registrations and chains
- controllers, services, factories, filters, directives, providers,
  decorators, animations, components, config/run blocks, invoke, and store
- component controllers/templates and directive definition objects
- provider `$get` declarations and reference following
- `$provide`, `$injector`, `$controllerProvider`, route/UI-Router providers,
  HTTP interceptors, UI Bootstrap modals, and Angular Material overlays
- lexical binding resolution, shadowing, hoisting, aliases, and direct IIFEs

Existing inline arrays, `$inject` assignments, and static class `$inject`
fields are preserved. Unsupported destructured parameter lists are left
unchanged instead of producing positionally incorrect annotations. Ambiguous
mutable references and object methods that rely on `super` are also left
unchanged rather than receiving a transformation that could alter runtime
semantics.

## Low-level API

Pipelines sharing an AST and MagicString instance can call the core directly:

```js
const { annotate } = require('rolldown-plugin-angularjs-annotate');

annotate(program, code, magicString, {
  comments,
  explicitOnly: false
});
```

The `comments` array is optional; the core has a source-based fallback for
native Rolldown ASTs. Public TypeScript declarations cover both the plugin and
the low-level API.

## Verification

```sh
npm run check
```

The suite includes the upstream compatibility corpus, safety regressions, a
minified AngularJS `strictDi` bootstrap, source maps, filters, TypeScript/Vue
module IDs, framework-generated modules with non-script IDs, package consumer
types, and real Rolldown builds with native MagicString both disabled and enabled.

## License

MIT. See [NOTICE](NOTICE) for upstream attribution.
