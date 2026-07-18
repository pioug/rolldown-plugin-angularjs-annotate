import angularjsAnnotate, {
  annotate,
  angularjsAnnotate as namedAngularjsAnnotate,
  type AngularjsAnnotateOptions,
} from 'rolldown-plugin-angularjs-annotate';
import coreAnnotate from 'rolldown-plugin-angularjs-annotate/core';

const options: AngularjsAnnotateOptions = { exclude: ['**/*.spec.js'] };
const plugin = angularjsAnnotate(options);
const namedPlugin = namedAngularjsAnnotate({ regexp: /^app$/ });
const lowLevel: typeof coreAnnotate = annotate;

void plugin;
void namedPlugin;
void lowLevel;
