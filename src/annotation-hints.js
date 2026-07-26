'use strict';

const REGISTRATION_METHOD_NAMES = [
  'animation', 'component', 'config', 'controller', 'decorator', 'directive', 'factory', 'filter',
  'invoke', 'provider', 'run', 'service', 'store'
];
const EXPLICIT_ANNOTATION_NAMES = ['ngInject', 'ngNoInject'];

const REGISTRATION_METHODS = new Set(REGISTRATION_METHOD_NAMES);
const EXPLICIT_ANNOTATION_CODE_FILTER = codeFilter(EXPLICIT_ANNOTATION_NAMES);
const ANNOTATION_CODE_FILTER = codeFilter([
  ...EXPLICIT_ANNOTATION_NAMES,
  'module',
  ...REGISTRATION_METHOD_NAMES,
]);

function codeFilter(names) {
  return new RegExp(String.raw`(?:\\|\b(?:${names.join('|')})\b)`);
}

module.exports = {
  ANNOTATION_CODE_FILTER,
  EXPLICIT_ANNOTATION_CODE_FILTER,
  REGISTRATION_METHODS,
};
