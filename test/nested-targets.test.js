const test = require('node:test');
const { assertTransform } = require('../test-support/transform');

test('Scan nested provider and directive targets through pre-annotated arrays', () => {
  const input = `
    angular.module('x')
      .provider('provider', ['outer', function(outer) {
        this.$get = function(providerDep) {};
      }])
      .directive('directive', ['outer', function(outer) {
        return { controller: function(controllerDep) {} };
      }]);
  `;
  const expected = `
    angular.module('x')
      .provider('provider', ['outer', function(outer) {
        this.$get = ['providerDep', function(providerDep) {}];
      }])
      .directive('directive', ['outer', function(outer) {
        return { controller: ['controllerDep', function(controllerDep) {}] };
      }]);
  `;
  assertTransform(input, expected);
});

test('Scan nested provider and directive targets when the outer factory is blocked', () => {
  const input = `
    Provider.$inject = ['outer'];
    function Provider(outer) {
      this.$get = function(providerDep) {};
    }
    function Directive(outer) {
      'ngNoInject';
      return { controller: function(controllerDep) {} };
    }
    angular.module('x')
      .provider('provider', Provider)
      .directive('directive', Directive);
  `;
  const expected = `
    Provider.$inject = ['outer'];
    function Provider(outer) {
      this.$get = ['providerDep', function(providerDep) {}];
    }
    function Directive(outer) {
      'ngNoInject';
      return { controller: ['controllerDep', function(controllerDep) {}] };
    }
    angular.module('x')
      .provider('provider', Provider)
      .directive('directive', Directive);
  `;
  assertTransform(input, expected);
});

test('Scan nested targets through conditional and logical pre-annotated bindings', () => {
  const input = `
    const provider = choose
      ? ['outer', function(outer) { this.$get = function(leftDep) {}; }]
      : ['outer', function(outer) { this.$get = function(rightDep) {}; }];
    const directive = fallback || ['outer', function(outer) {
      return { controller: function(controllerDep) {} };
    }];
    angular.module('x')
      .provider('provider', provider)
      .directive('directive', directive);
  `;
  const expected = `
    const provider = choose
      ? ['outer', function(outer) { this.$get = ['leftDep', function(leftDep) {}]; }]
      : ['outer', function(outer) { this.$get = ['rightDep', function(rightDep) {}]; }];
    const directive = fallback || ['outer', function(outer) {
      return { controller: ['controllerDep', function(controllerDep) {}] };
    }];
    angular.module('x')
      .provider('provider', provider)
      .directive('directive', directive);
  `;
  assertTransform(input, expected);
});

test('Scan nested provider and directive targets returned by binding IIFEs', () => {
  const input = `
    const Provider = (() => ['outer', function(outer) {
      this.$get = function(providerDep) {};
    }])();
    const Directive = (() => ['outer', function(outer) {
      return { controller: function(controllerDep) {} };
    }])();
    angular.module('x')
      .provider('provider', Provider)
      .directive('directive', Directive);
  `;
  const expected = `
    const Provider = (() => ['outer', function(outer) {
      this.$get = ['providerDep', function(providerDep) {}];
    }])();
    const Directive = (() => ['outer', function(outer) {
      return { controller: ['controllerDep', function(controllerDep) {}] };
    }])();
    angular.module('x')
      .provider('provider', Provider)
      .directive('directive', Directive);
  `;
  assertTransform(input, expected);
});

test('Scan nested targets inside ngNoInject registration wrappers', () => {
  const input = `
    angular.module('x')
      .provider('provider', ngNoInject(function(outer) {
        this.$get = function(providerDep) {};
      }))
      .directive('directive', ngNoInject(function(outer) {
        return { controller: function(controllerDep) {} };
      }));
  `;
  const expected = `
    angular.module('x')
      .provider('provider', ngNoInject(function(outer) {
        this.$get = ['providerDep', function(providerDep) {}];
      }))
      .directive('directive', ngNoInject(function(outer) {
        return { controller: ['controllerDep', function(controllerDep) {}] };
      }));
  `;
  assertTransform(input, expected);
});

test('Scan nested targets through blocked wrappers in indirect registration paths', () => {
  const input = `
    const Provider = choose
      ? ngNoInject(function(outer) { this.$get = function(providerDep) {}; })
      : ['outer', function(outer) { this.$get = function(fallbackDep) {}; }];
    const Directive = (() => ngNoInject(function(outer) {
      return { controller: function(controllerDep) {} };
    }))();
    angular.module('x')
      .provider('provider', Provider)
      .directive('directive', Directive);
  `;
  const expected = `
    const Provider = choose
      ? ngNoInject(function(outer) { this.$get = ['providerDep', function(providerDep) {}]; })
      : ['outer', function(outer) { this.$get = ['fallbackDep', function(fallbackDep) {}]; }];
    const Directive = (() => ngNoInject(function(outer) {
      return { controller: ['controllerDep', function(controllerDep) {}] };
    }))();
    angular.module('x')
      .provider('provider', Provider)
      .directive('directive', Directive);
  `;
  assertTransform(input, expected);
});

test('Scan nested targets through assignment and sequence IIFE returns', () => {
  const input = `
    let assigned;
    const AssignmentProvider = (() => assigned = ['outer', function(outer) {
      this.$get = function(assignmentDep) {};
    }])();
    const SequenceProvider = (() => (sideEffect(), ['outer', function(outer) {
      this.$get = function(sequenceDep) {};
    }]))();
    angular.module('x')
      .provider('assignment', AssignmentProvider)
      .provider('sequence', SequenceProvider);
  `;
  const expected = `
    let assigned;
    const AssignmentProvider = (() => assigned = ['outer', function(outer) {
      this.$get = ['assignmentDep', function(assignmentDep) {}];
    }])();
    const SequenceProvider = (() => (sideEffect(), ['outer', function(outer) {
      this.$get = ['sequenceDep', function(sequenceDep) {}];
    }]))();
    angular.module('x')
      .provider('assignment', AssignmentProvider)
      .provider('sequence', SequenceProvider);
  `;
  assertTransform(input, expected);
});

test('Follow a directly returned local directive helper', () => {
  const input = `
    angular.module('x').directive('directive', function() {
      function makeDefinition() {
        return { controller: function(controllerDep) {} };
      }
      return makeDefinition();
    });
  `;
  const expected = `
    angular.module('x').directive('directive', function() {
      function makeDefinition() {
        return { controller: ['controllerDep', function(controllerDep) {}] };
      }
      return makeDefinition();
    });
  `;
  assertTransform(input, expected);
});

test('Follow optional and sequence-wrapped local directive helpers', () => {
  const input = `
    angular.module('x')
      .directive('optional', function() {
        function makeOptional() {
          return { controller: function(optionalDep) {} };
        }
        return makeOptional?.();
      })
      .directive('sequence', function() {
        function makeSequence() {
          return { controller: function(sequenceDep) {} };
        }
        return (0, makeSequence)();
      });
  `;
  const expected = `
    angular.module('x')
      .directive('optional', function() {
        function makeOptional() {
          return { controller: ['optionalDep', function(optionalDep) {}] };
        }
        return makeOptional?.();
      })
      .directive('sequence', function() {
        function makeSequence() {
          return { controller: ['sequenceDep', function(sequenceDep) {}] };
        }
        return (0, makeSequence)();
      });
  `;
  assertTransform(input, expected);
});
