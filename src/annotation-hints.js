'use strict';

const REGISTRATION_METHOD_NAMES = [
  'animation', 'component', 'config', 'controller', 'decorator', 'directive', 'factory', 'filter',
  'invoke', 'provider', 'run', 'service', 'store'
];
const EXPLICIT_ANNOTATION_NAMES = ['ngInject', 'ngNoInject'];

const REGISTRATION_METHODS = new Set(REGISTRATION_METHOD_NAMES);
// Escaped identifiers may decode to a supported name, and string directives may use other escape forms.
const SOURCE_ESCAPE_PATTERN = String.raw`\\(?:u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})|x[0-9a-fA-F]{2}|[0-7]{1,3}|\r\n|[\n\r\u2028\u2029])`;
const EXPLICIT_ANNOTATION_PATTERN = String.raw`${SOURCE_ESCAPE_PATTERN}|\b(?:${EXPLICIT_ANNOTATION_NAMES.join('|')})\b`;
const MEMBER_TRIVIA = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r\n?|\n|$))*`;
const IMPLICIT_METHOD_PATTERN = [
  'module',
  ...REGISTRATION_METHOD_NAMES,
].join('|');
const EXPLICIT_ANNOTATION_CODE_FILTER = new RegExp(`(?:${EXPLICIT_ANNOTATION_PATTERN})`);
const ANNOTATION_CODE_FILTER = new RegExp(
  String.raw`(?:${EXPLICIT_ANNOTATION_PATTERN}|\.${MEMBER_TRIVIA}(?:${IMPLICIT_METHOD_PATTERN})\b)`,
);

module.exports = {
  ANNOTATION_CODE_FILTER,
  EXPLICIT_ANNOTATION_CODE_FILTER,
  REGISTRATION_METHODS,
};
