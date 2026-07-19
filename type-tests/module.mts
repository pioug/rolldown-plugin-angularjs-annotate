import angularjsAnnotate, {
  annotate,
  angularjsAnnotate as namedAngularjsAnnotate,
  type AngularJSAnnotateOptions,
  type ParserComment,
} from 'rolldown-plugin-angularjs-annotate';
import coreAnnotate from 'rolldown-plugin-angularjs-annotate/core';

const options: AngularJSAnnotateOptions = { exclude: ['**/*.spec.js'] };
const plugin = angularjsAnnotate(options);
const namedPlugin = namedAngularjsAnnotate({ regexp: /^app$/ });
const lowLevel: typeof coreAnnotate = annotate;
const parserComment: ParserComment = { value: 'ngInject', start: 0, end: 12 };
const typedParserComment: ParserComment = { type: 'Block', value: 'ngInject', start: 0, end: 14 };

void plugin;
void namedPlugin;
void lowLevel;
void parserComment;
void typedParserComment;
