'use strict';

const MagicString = require('magic-string');
const picomatch = require('picomatch');
const { parseSync } = require('rolldown/utils');
const annotate = require('./src/annotate');

const DEFAULT_INCLUDE = /\.[cm]?[jt]sx?(?:$|\?)/;
const DEFAULT_EXCLUDE = [/(?:^|[/\\])node_modules[/\\]/, /\0rolldown[/\\]runtime\.js$/];

function angularjsAnnotate(options = {}) {
  const { include = DEFAULT_INCLUDE, exclude = DEFAULT_EXCLUDE } = options;
  const filter = createFilter(include, exclude);
  const excluded = createMatcher(exclude);
  const useModuleType = options.include === undefined;

  return {
    name: 'rolldown-plugin-angularjs-annotate',
    enforce: 'post',
    transform: {
      filter: useModuleType ? {
        id: { exclude },
        moduleType: ['js', 'jsx', 'ts', 'tsx'],
      } : { id: { include, exclude } },
      handler(code, id, meta = {}) {
        if (!filter(id) && !(useModuleType && isJavaScriptModuleType(meta.moduleType) && !excluded(id))) return;

        const parsed = meta.ast ? { program: meta.ast, comments: null, errors: [] } : parseSync(id, code, {
          lang: language(id, meta.moduleType),
          sourceType: 'unambiguous',
        });
        if (parsed.errors.length) throw parserError(parsed.errors[0], id);

        const magicString = meta.magicString || new MagicString(code);
        annotate(parsed.program, code, magicString, {
          comments: parsed.comments,
          explicitOnly: options.explicitOnly,
          regexp: options.regexp,
          onWarn: message => typeof this?.warn === 'function' ? this.warn(message) : undefined,
        });
        if (!magicString.hasChanged()) return;

        return meta.magicString ? { code: magicString } : {
          code: magicString.toString(),
          map: magicString.generateMap({ hires: 'boundary', includeContent: true, source: id }),
        };
      },
    },
  };
}

function language(id, moduleType) {
  if (isJavaScriptModuleType(moduleType)) return moduleType;
  const match = /(?:\.([cm]?[jt]sx?)(?:$|\?)|(?:^|[?&])lang\.([jt]sx?)(?:&|$))/.exec(id);
  const extension = match?.[1] || match?.[2];
  if (extension?.endsWith('tsx')) return 'tsx';
  if (extension?.endsWith('ts')) return 'ts';
  if (extension?.endsWith('jsx')) return 'jsx';
  return 'js';
}

function isJavaScriptModuleType(moduleType) {
  return moduleType === 'js' || moduleType === 'jsx' || moduleType === 'ts' || moduleType === 'tsx';
}

function parserError(diagnostic, id) {
  if (diagnostic instanceof Error) return diagnostic;
  const message = diagnostic?.message || diagnostic?.labels?.[0]?.message || String(diagnostic);
  const error = new SyntaxError(`${id}: ${message}`);
  error.cause = diagnostic;
  return error;
}

function createFilter(include, exclude) {
  const inclusions = patterns(include).map(patternMatcher);
  const exclusions = patterns(exclude).map(patternMatcher);
  return id => (inclusions.length === 0 || inclusions.some(matches => matches(id))) &&
    !exclusions.some(matches => matches(id));
}

function createMatcher(value) {
  const matchers = patterns(value).map(patternMatcher);
  return id => matchers.some(matches => matches(id));
}

function patterns(value) {
  if (value == null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function patternMatcher(pattern) {
  if (pattern instanceof RegExp) {
    return value => {
      pattern.lastIndex = 0;
      const result = pattern.test(value);
      pattern.lastIndex = 0;
      return result;
    };
  }
  const matches = picomatch(String(pattern), { dot: true });
  return value => matches(value.replace(/\\/g, '/'));
}

angularjsAnnotate.annotate = annotate;
angularjsAnnotate.angularjsAnnotate = angularjsAnnotate;
angularjsAnnotate.default = angularjsAnnotate;

module.exports = angularjsAnnotate;
module.exports.annotate = annotate;
module.exports.angularjsAnnotate = angularjsAnnotate;
module.exports.default = angularjsAnnotate;
