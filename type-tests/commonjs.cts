import angularjsAnnotate = require('rolldown-plugin-angularjs-annotate');
import annotate = require('rolldown-plugin-angularjs-annotate/core');

const plugin = angularjsAnnotate({ include: '**/*.js' });
const namedPlugin = angularjsAnnotate.angularjsAnnotate({ explicitOnly: true });
const lowLevel: typeof annotate = angularjsAnnotate.annotate;

void plugin;
void namedPlugin;
void lowLevel;
