'use strict';

const MagicString = require('magic-string');
const { parseSync } = require('rolldown/utils');
const annotate = require('./src/annotate');

const DEFAULT_INCLUDE = /\.[cm]?[jt]sx?(?:$|\?)/;
const DEFAULT_EXCLUDE = [/(?:^|[/\\])node_modules[/\\]/, /\0rolldown[/\\]runtime\.js$/];

function angularjsAnnotate(options = {}) {
  const { include = DEFAULT_INCLUDE, exclude = DEFAULT_EXCLUDE } = options;
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
        let parsed;
        try {
          parsed = meta.ast ? { program: meta.ast, comments: null, errors: [] } : parseSync(id, code, {
            lang: language(id, meta.moduleType),
            sourceType: 'unambiguous',
          });
        } catch (error) {
          reportError(this, error, id);
        }
        if (parsed.errors.length) reportError(this, parserError(parsed.errors[0], id), id);

        const magicString = meta.magicString || new MagicString(code);
        try {
          annotate(parsed.program, code, magicString, {
            comments: parsed.comments,
            explicitOnly: options.explicitOnly,
            regexp: options.regexp,
            onWarn: (message, diagnostic) => {
              if (typeof this?.warn !== 'function') return;
              this.warn({
                message,
                id,
                pluginCode: diagnostic?.code || 'ANNOTATION_MISMATCH',
              }, diagnosticPosition(diagnostic));
            },
          });
        } catch (error) {
          reportError(this, error, id);
        }
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
  const message = diagnostic?.message || diagnostic?.labels?.[0]?.message || String(diagnostic);
  const error = new SyntaxError(message);
  error.cause = diagnostic;
  error.id = id;
  error.pluginCode = 'PARSE_ERROR';
  const position = diagnosticPosition(diagnostic);
  if (position !== undefined) error.start = position;
  return error;
}

function reportError(context, value, id) {
  const error = value instanceof Error ? value : new Error(String(value));
  if (error.id === undefined) error.id = id;
  if (error.pluginCode === undefined) error.pluginCode = error.code || 'ANNOTATION_ERROR';
  if (typeof context?.error === 'function') context.error(error, diagnosticPosition(error));
  if (!error.message.startsWith(`${id}: `)) error.message = `${id}: ${error.message}`;
  throw error;
}

function diagnosticPosition(diagnostic) {
  const position = diagnostic?.start ?? diagnostic?.labels?.[0]?.start;
  return Number.isInteger(position) && position >= 0 ? position : undefined;
}

module.exports = angularjsAnnotate;
module.exports.annotate = annotate;
module.exports.angularjsAnnotate = angularjsAnnotate;
