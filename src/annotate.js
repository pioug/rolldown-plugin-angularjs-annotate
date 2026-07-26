'use strict';

const { REGISTRATION_METHODS } = require('./annotation-hints');
const CHAIN_ONLY_METHODS = new Set(['bootstrap', 'constant', 'value']);
const STATE_PROPERTIES = new Set(['controller', 'controllerProvider', 'onEnter', 'onExit', 'templateProvider']);
const VIEW_PROPERTIES = new Set(['controller', 'controllerProvider', 'templateProvider']);
const COMPONENT_PROPERTIES = new Set(['controller', 'template', 'templateUrl']);
const STANDALONE_STATEMENTS = new Set([
  'ClassDeclaration', 'ExportDefaultDeclaration', 'ExportNamedDeclaration', 'ExpressionStatement',
  'FunctionDeclaration', 'VariableDeclaration'
]);
const AMBIGUOUS_WRITE_ANCESTORS = new Set([
  'CatchClause', 'ConditionalExpression', 'DoWhileStatement', 'ForInStatement', 'ForOfStatement',
  'ForStatement', 'IfStatement', 'LogicalExpression', 'SwitchCase', 'TryStatement', 'WhileStatement'
]);
const WRAPPER_TYPES = new Set([
  'ChainExpression', 'ParenthesizedExpression', 'TSAsExpression', 'TSInstantiationExpression', 'TSNonNullExpression',
  'TSSatisfiesExpression', 'TSTypeAssertion'
]);
const AMD_LOADER_NAMES = new Set(['define', 'require', 'requirejs']);
const ANNOTATION_WRAPPER_NAMES = new Set(['ngInject', 'ngNoInject']);
const DEFAULT_MODULE_REGEXP = /^[a-zA-Z0-9_$\.\s]+$/;

module.exports = function annotate(program, code, magicString, options = {}) {
  const annotator = new Annotator(program, code, magicString, options);
  annotator.run();
};

class Annotator {
  constructor(program, code, magicString, options) {
    this.program = program;
    this.code = code;
    this.magicString = magicString;
    this.options = options || {};
    this.moduleRegexp = normalizeModuleRegexp(this.options.regexp);

    this.comments = normalizeComments(this.options.comments);
    this.commentProtectedNodes = this.comments == null && /\/[/*]/.test(this.code) ? [] : null;
    const hasExplicitComment = this.comments ?
      this.comments.some(comment => commentAnnotation(comment.value) != null) :
      this.code.includes('@ngInject') || this.code.includes('@ngNoInject');
    this.explicitCandidateNodes = hasExplicitComment ? [] : null;
    this.writeAndAnnotationNodes = [];
    this.calls = [];
    this.explicitNodes = [];
    this.hasIndexedCandidate = false;
    this.parents = new WeakMap();
    this.methodProperties = new WeakMap();

    this.nodeScopes = new WeakMap();
    this.functionScopes = new WeakMap();
    this.bindingByValue = new WeakMap();
    this.bindingByDeclaration = new WeakMap();
    this.rootScope = this.buildScopes();

    this.comments ||= this.commentProtectedNodes ? scanComments(this.code, this.commentProtectedNodes) : [];
    this.commentProtectedNodes = null;
    this.skipAnalysis = !this.hasAnnotationCandidates();
    if (this.skipAnalysis) return;

    this.regularInfoCache = new WeakMap();

    this.explicitActions = [];
    this.suppressedFunctionDirectives = new WeakSet();
    this.blockedNodes = new WeakSet();
    this.blockedBindings = new Set();
    this.blockedWrites = new Set();
    this.contextRoots = new WeakSet();
    this.contextRootCount = 0;
    this.processedContextCalls = new WeakSet();
    this.processedMethods = new WeakMap();
    this.queue = [];

    this.plannedNodes = new WeakSet();
    this.before = new Map();
    this.after = new Map();
    this.generatedNames = new Set();
    this.configSeen = new Map();

    this.commentByStart = new Map(this.comments.map(comment => [comment.start, comment]));
    this.collectBindingWrites();
  }

  run() {
    if (this.skipAnalysis) return;

    this.collectExistingAnnotations();
    this.collectExplicitActions();

    for (const action of this.explicitActions) {
      if (!action.annotate) this.blockTarget(action.node);
    }
    for (const action of this.explicitActions) {
      if (action.annotate) this.enqueue(action.node, { explicit: true });
    }

    if (!this.options.explicitOnly) this.collectRegularTargets();
    this.drainQueue();

    if (!this.options.explicitOnly) {
      let previousContextCount = -1;
      while (previousContextCount !== this.contextRootCount) {
        previousContextCount = this.contextRootCount;
        this.collectContextualTargets();
        this.drainQueue();
      }
    }

    this.applyInsertions();
  }

  indexNode(node, parent) {
    if (parent) this.parents.set(node, parent);

    if (this.explicitCandidateNodes && explicitPriority(node) < 100) {
      this.explicitCandidateNodes.push(node);
    }
    if (this.commentProtectedNodes &&
        (node.type === 'Literal' || node.type === 'TemplateElement' || node.type === 'JSXText')) {
      this.commentProtectedNodes.push(node);
    }
    switch (node.type) {
      case 'AccessorProperty':
      case 'AssignmentExpression':
      case 'FieldDefinition':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'MethodDefinition':
      case 'PropertyDefinition':
      case 'UpdateExpression':
        this.writeAndAnnotationNodes.push(node);
        break;
    }

    const functionNode = isFunction(node);
    if (functionNode) {
      this.explicitNodes.push(node);
      if (!this.hasIndexedCandidate && functionDirective(node) != null) {
        this.hasIndexedCandidate = true;
      }
    } else if (node.type === 'CallExpression') {
      this.calls.push(node);
      if (annotationWrapperName(node)) {
        this.explicitNodes.push(node);
        this.hasIndexedCandidate = true;
      }
      if (!this.options.explicitOnly && !this.hasIndexedCandidate && isImplicitAnnotationCandidate(node)) {
        this.hasIndexedCandidate = true;
      }
    }

    if (node.type === 'Property' && node.method && isFunction(node.value)) {
      this.methodProperties.set(node.value, node);
    }
    return functionNode;
  }

  indexSubtree(node, parent) {
    walk(node, (current, currentParent) => this.indexNode(current, currentParent), new WeakSet(), parent);
  }

  indexUnvisitedChildren(node, visited) {
    // Scope traversal intentionally skips metadata such as names, decorators, and type annotations.
    forEachChild(node, child => {
      if (!visited.has(child)) this.indexSubtree(child, node);
    });
  }

  hasAnnotationCandidates() {
    if (this.comments.some(comment => commentAnnotation(comment.value) != null)) return true;
    return this.hasIndexedCandidate;
  }

  buildScopes() {
    const root = new Scope('program', null, this.program, this.program);
    this.visitScope(this.program, root, null, true);
    return root;
  }

  visitScope(node, scope, parent = null, reuseBlock = false) {
    if (!isNode(node)) return;
    const functionNode = this.indexNode(node, parent);
    this.nodeScopes.set(node, scope);

    if (node.type === 'Program') {
      for (const statement of node.body) this.visitScope(statement, scope, node);
      return;
    }

    if (functionNode) {
      if (node.type === 'FunctionDeclaration' && node.id) {
        this.declare(scope, node.id.name, node, node, 'hoisted');
      }

      const functionScope = new Scope('function', scope, node, node.body?.type === 'BlockStatement' ? node.body : null);
      this.functionScopes.set(node, functionScope);
      if (node.type !== 'FunctionDeclaration' && node.id) {
        this.declare(functionScope, node.id.name, node, node, 'function-name');
      }
      for (const parameter of node.params || []) {
        this.declarePattern(functionScope, parameter, null, parameter, 'param');
        this.visitScope(parameter, functionScope, node);
      }
      if (node.body?.type === 'BlockStatement') this.visitScope(node.body, functionScope, node, true);
      else this.visitScope(node.body, functionScope, node);
      this.indexUnvisitedChildren(node, new Set([...(node.params || []), node.body]));
      return;
    }

    if (node.type === 'BlockStatement') {
      const blockScope = reuseBlock ? scope : new Scope('block', scope, node, node);
      this.nodeScopes.set(node, blockScope);
      for (const statement of node.body) this.visitScope(statement, blockScope, node);
      return;
    }

    if (node.type === 'StaticBlock') {
      const blockScope = new Scope('static-block', scope, node, node);
      this.nodeScopes.set(node, blockScope);
      for (const statement of node.body || []) this.visitScope(statement, blockScope, node);
      return;
    }

    if (node.type === 'SwitchStatement') {
      this.visitScope(node.discriminant, scope, node);
      const switchScope = new Scope('block', scope, node, null);
      this.nodeScopes.set(node, switchScope);
      for (const switchCase of node.cases || []) this.visitScope(switchCase, switchScope, node);
      return;
    }

    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const loopScope = new Scope('block', scope, node, null);
      this.nodeScopes.set(node, loopScope);
      forEachChild(node, child => this.visitScope(child, loopScope, node));
      return;
    }

    if (node.type === 'CatchClause') {
      const catchScope = new Scope('block', scope, node, node.body);
      this.nodeScopes.set(node, catchScope);
      if (node.param) {
        this.declarePattern(catchScope, node.param, null, node.param, 'caught');
        this.visitScope(node.param, catchScope, node);
      }
      this.visitScope(node.body, catchScope, node, true);
      return;
    }

    if (isClass(node)) {
      if (node.type === 'ClassDeclaration' && node.id) {
        this.declare(scope, node.id.name, node, node, 'class');
      }
      const classScope = new Scope('class', scope, node, null);
      if (node.id) this.declare(classScope, node.id.name, node, node, 'class-name');
      if (node.superClass) this.visitScope(node.superClass, scope, node);
      this.visitScope(node.body, classScope, node);
      this.indexUnvisitedChildren(node, new Set([node.superClass, node.body]));
      return;
    }

    if (node.type === 'VariableDeclaration') {
      for (const declarator of node.declarations) {
        this.parents.set(declarator, node);
        const targetScope = node.kind === 'var' ? nearestFunctionScope(scope) : scope;
        this.declarePattern(targetScope, declarator.id, declarator.init, declarator, node.kind);
      }
      forEachChild(node, child => this.visitScope(child, scope, node));
      return;
    }

    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers || []) {
        if (specifier.local) this.declare(scope, specifier.local.name, null, specifier, 'import');
      }
    }

    forEachChild(node, child => this.visitScope(child, scope, node));
  }

  declarePattern(scope, pattern, value, declaration, kind) {
    pattern = unwrap(pattern);
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      this.declare(scope, pattern.name, value, declaration, kind);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      this.declarePattern(scope, pattern.left, value, declaration, kind);
      return;
    }
    if (pattern.type === 'RestElement') {
      this.declarePattern(scope, pattern.argument, value, declaration, kind);
      return;
    }
    if (pattern.type === 'TSParameterProperty') {
      this.declarePattern(scope, pattern.parameter, value, declaration, kind);
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements || []) this.declarePattern(scope, element, null, declaration, kind);
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties || []) {
        this.declarePattern(scope, property.type === 'RestElement' ? property.argument : property.value, null, declaration, kind);
      }
    }
  }

  declare(scope, name, value, declaration, kind) {
    if (!name) return null;
    let binding = scope.bindings.get(name);
    if (!binding || !['var', 'hoisted'].includes(kind)) {
      binding = { name, value: null, declaration: null, kind, scope, statement: null, writes: [], unknownWrites: [] };
      scope.bindings.set(name, binding);
    }
    if (declaration && !binding.declaration) binding.declaration = declaration;
    if (value) this.addBindingWrite(binding, value, declaration, kind, kind === 'hoisted');
    if (declaration) this.bindingByDeclaration.set(declaration, binding);
    return binding;
  }

  addBindingWrite(binding, value, declaration, kind, hoisted = false, ambiguous = false) {
    const write = {
      value,
      declaration,
      kind,
      statement: declaration && this.statementFor(declaration),
      start: hoisted ? Number.NEGATIVE_INFINITY : (declaration?.start ?? value?.start ?? 0),
      ambiguous,
    };
    binding.writes.push(write);
    binding.value = value;
    binding.declaration = declaration;
    binding.statement = write.statement;
    binding.kind = kind;
    this.rememberBindingValue(value, binding);
    return write;
  }

  rememberBindingValue(value, binding) {
    for (const candidate of new Set([value, unwrap(value)])) {
      if (!isNode(candidate)) continue;
      const existing = this.bindingByValue.get(candidate);
      if (!existing || existing.kind === 'function-name' || existing.kind === 'class-name') {
        this.bindingByValue.set(candidate, binding);
      }
    }
  }

  collectBindingWrites() {
    for (const node of this.writeAndAnnotationNodes) {
      if (node.type === 'AssignmentExpression') {
        if (node.left?.type === 'Identifier' && node.operator === '=') {
          const binding = this.bindingFor(node.left);
          if (binding) {
            this.addBindingWrite(binding, node.right, node, 'assignment', false, this.isAmbiguousWrite(node, binding));
          }
        } else {
          for (const identifier of assignedIdentifiers(node.left)) this.markUnknownWrite(identifier, node);
        }
      } else if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier') {
        this.markUnknownWrite(node.argument, node);
      } else if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
        const patterns = node.left?.type === 'VariableDeclaration' ?
          node.left.declarations.map(declaration => declaration.id) : [node.left];
        for (const pattern of patterns) {
          for (const identifier of assignedIdentifiers(pattern)) this.markUnknownWrite(identifier, node);
        }
      }
    }
  }

  markUnknownWrite(identifier, node) {
    const binding = this.bindingFor(identifier);
    if (!binding) return;
    binding.unknownWrites.push({ start: node.start, ambiguous: this.isAmbiguousWrite(node, binding) });
  }

  isAmbiguousWrite(node, binding) {
    let current = this.parents.get(node);
    while (current && current !== binding.scope.node) {
      if (AMBIGUOUS_WRITE_ANCESTORS.has(current.type)) return true;
      if (isFunction(current) && this.functionScopes.get(current) !== binding.scope) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  statementFor(node) {
    let current = node;
    let parent = this.parents.get(current);
    while (parent && parent.type !== 'Program' && parent.type !== 'BlockStatement' &&
           parent.type !== 'StaticBlock' && parent.type !== 'SwitchCase') {
      current = parent;
      parent = this.parents.get(current);
    }
    if (!parent) return null;
    return STANDALONE_STATEMENTS.has(current.type) ? current : null;
  }

  bindingFor(identifier) {
    if (identifier?.type !== 'Identifier') return null;
    let scope = this.nodeScopes.get(identifier);
    while (scope) {
      const binding = scope.bindings.get(identifier.name);
      if (binding) return binding;
      scope = scope.parent;
    }
    return null;
  }

  bindingView(binding, write) {
    if (!binding || !write) return null;
    return {
      ...binding,
      baseBinding: binding.baseBinding || binding,
      value: write.value,
      declaration: write.declaration,
      statement: write.statement,
      kind: write.kind,
      write,
    };
  }

  bindingForValue(value) {
    const binding = this.bindingByValue.get(value);
    if (!binding) return null;
    if (binding.kind === 'function-name' || binding.kind === 'class-name') return null;
    const write = binding.writes.find(candidate => unwrap(candidate.value) === value);
    return write ? this.bindingView(binding, write) : binding;
  }

  bindingForDeclaration(declaration) {
    const binding = this.bindingByDeclaration.get(declaration);
    if (!binding) return null;
    const write = binding.writes.find(candidate => candidate.declaration === declaration);
    return write ? this.bindingView(binding, write) : binding;
  }

  effectiveBinding(binding, reference) {
    if (!binding) return null;
    if (binding.kind === 'function-name' || binding.kind === 'class-name') {
      const outer = this.bindingByValue.get(binding.value);
      if (!outer || outer === binding) return null;
      binding = outer;
    }

    const referenceFunction = nearestFunctionScope(this.nodeScopes.get(reference));
    const bindingFunction = nearestFunctionScope(binding.scope);
    if ((binding.unknownWrites.length || binding.writes.length > 1) && referenceFunction !== bindingFunction) return null;
    if (binding.unknownWrites.some(write => write.start <= reference.start)) return null;

    let effective = null;
    for (const write of binding.writes) {
      if (write.start <= reference.start && (!effective || write.start >= effective.start)) effective = write;
    }
    if (!effective && binding.writes.length === 1 && referenceFunction !== bindingFunction) {
      const future = binding.writes[0];
      if (['class', 'const', 'let', 'var'].includes(future.kind) && !future.ambiguous) effective = future;
    }
    if (!effective || effective.ambiguous) return null;
    return this.bindingView(binding, effective);
  }

  collectExistingAnnotations() {
    for (const node of this.writeAndAnnotationNodes) {
      if (node.type === 'AssignmentExpression' && isInjectMember(node.left)) {
        const object = unwrap(node.left.object);
        if (object?.type === 'Identifier') {
          const binding = this.bindingFor(object);
          const effective = this.effectiveBinding(binding, object);
          if (effective?.write) this.blockedWrites.add(effective.write);
          else if (binding) this.blockedBindings.add(binding);
        }
      }
      if ((node.type === 'PropertyDefinition' || node.type === 'FieldDefinition' ||
           node.type === 'AccessorProperty' || node.type === 'MethodDefinition') &&
          node.static && staticPropertyName(node) === '$inject') {
        const classNode = this.findAncestor(node, isClass);
        if (classNode) {
          this.blockedNodes.add(classNode);
        }
      }
    }
  }

  collectExplicitActions() {
    let candidates;
    for (const comment of this.comments) {
      const annotation = commentAnnotation(comment.value);
      if (annotation == null) continue;
      candidates ||= this.explicitCandidates();
      const node = this.nextAnnotatedNode(comment, candidates);
      if (!annotation && node?.type === 'VariableDeclaration' && node.declarations.length !== 1) {
        for (const declaration of node.declarations) {
          const value = unwrap(declaration.init);
          if (isFunction(value)) this.suppressedFunctionDirectives.add(value);
          if (isClass(value)) {
            for (const element of value.body?.body || []) {
              if (element.type === 'MethodDefinition' && element.kind === 'constructor' && isFunction(element.value)) {
                this.suppressedFunctionDirectives.add(element.value);
              }
            }
          }
        }
      }
      const targets = node ? this.normalizeExplicitNodes(node) : [];
      for (const target of targets) this.explicitActions.push({ node: target, annotate: annotation });
    }

    for (const node of this.explicitNodes) {
      if (isFunction(node)) {
        const directive = functionDirective(node);
        if (directive != null && !this.suppressedFunctionDirectives.has(node)) {
          let target = node;
          const parent = this.parents.get(node);
          if (parent?.type === 'Property' && (parent.kind === 'get' || parent.kind === 'set')) continue;
          if (parent?.type === 'MethodDefinition') {
            if (parent.kind !== 'constructor') continue;
            target = this.findAncestor(parent, isClass) || node;
          }
          this.explicitActions.push({ node: target, annotate: directive });
        }
      }
      const wrapper = annotationWrapperName(node);
      if (wrapper) {
        this.explicitActions.push({ node: node.arguments[0], annotate: wrapper === 'ngInject' });
      }
    }
  }

  explicitCandidates() {
    const result = [...this.explicitCandidateNodes];
    result.sort((left, right) => explicitStart(left) - explicitStart(right) ||
      explicitPriority(left) - explicitPriority(right) || right.end - left.end);
    return result;
  }

  nextAnnotatedNode(comment, candidates) {
    for (const candidate of candidates) {
      const start = explicitStart(candidate);
      if (start < comment.end) continue;
      if (this.isTrivia(comment.end, start)) return candidate;
      if (/\S/.test(this.code.slice(comment.end, start))) break;
    }
    return null;
  }

  isTrivia(start, end) {
    let cursor = start;
    while (cursor < end) {
      const whitespace = /^[\s]*/.exec(this.code.slice(cursor, end))[0].length;
      cursor += whitespace;
      if (cursor >= end) return true;
      const comment = this.commentByStart.get(cursor);
      if (comment && comment.end > end) return false;
      if (!comment) return false;
      cursor = comment.end;
    }
    return true;
  }

  normalizeExplicitNodes(node) {
    if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
      const declaration = node.declaration || node;
      if (declaration.type === 'VariableDeclaration' && declaration.declarations.length !== 1) return [];
      return [declaration];
    }
    if (node.type === 'VariableDeclaration' && node.declarations.length !== 1) {
      return node.declarations.map(declaration => unwrap(declaration.init)).filter(value => value?.type === 'ObjectExpression');
    }
    if (node.type === 'ExpressionStatement') return [node.expression];
    if (node.type === 'MethodDefinition' && node.kind === 'constructor') return [this.findAncestor(node, isClass) || node];
    return [node];
  }

  blockTarget(input, seen = new WeakSet()) {
    let node = unwrap(input);
    if (!isNode(node) || seen.has(node)) return;
    seen.add(node);

    if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
      this.blockTarget(node.declaration, seen);
      return;
    }
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) this.blockTarget(declaration, seen);
      return;
    }
    if (node.type === 'VariableDeclarator') {
      const binding = this.bindingForDeclaration(node);
      if (binding?.write) this.blockedWrites.add(binding.write);
      else if (binding) this.blockedBindings.add(binding.baseBinding || binding);
      this.blockTarget(node.init, seen);
      return;
    }
    if (node.type === 'Property') {
      this.blockTarget(node.value, seen);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      this.blockTarget(node.right, seen);
      return;
    }
    const branches = branchExpressions(node);
    if (branches) {
      for (const branch of branches) this.blockTarget(branch, seen);
      return;
    }
    if (node.type === 'ArrayExpression') {
      const last = unwrap(node.elements[node.elements.length - 1]);
      if (last) this.blockTarget(last, seen);
      return;
    }
    if (node.type === 'ObjectExpression') {
      this.walkAnnotatedObject(node, value => this.blockTarget(value, seen));
      return;
    }
    if (node.type === 'Identifier') {
      const binding = this.bindingFor(node);
      if (binding) {
        const effective = this.effectiveBinding(binding, node);
        if (effective?.write) this.blockedWrites.add(effective.write);
        else this.blockedBindings.add(binding);
        this.blockTarget(effective?.value, seen);
      }
      return;
    }
    if (node.type === 'CallExpression') {
      if (annotationWrapperName(node)) {
        this.blockTarget(node.arguments[0], seen);
        return;
      }
      const regular = this.regularInfo(node);
      if (regular?.target) this.blockTarget(regular.target, seen);
      const returned = this.iifeReturn(node);
      if (returned) this.blockTarget(returned, seen);
      this.blockedNodes.add(node);
      return;
    }
    if (isFunction(node) || isClass(node)) {
      this.blockedNodes.add(node);
    }
  }

  collectRegularTargets() {
    for (const call of this.calls) {
      const info = this.regularInfo(call);
      if (!info?.target || this.blockedNodes.has(call)) continue;
      if (info.method === 'component') this.processConfig(info.target, 'component');
      else this.enqueue(info.target, { method: info.method });
    }
  }

  regularInfo(call, stack = new WeakSet()) {
    if (this.regularInfoCache.has(call)) return this.regularInfoCache.get(call);
    if (!isNode(call) || call.type !== 'CallExpression' || stack.has(call)) return null;
    stack.add(call);

    const callee = unwrap(call.callee);
    if (callee?.type !== 'MemberExpression' || callee.computed) {
      this.regularInfoCache.set(call, null);
      return null;
    }
    const method = staticPropertyName(callee);
    const object = unwrap(callee.object);

    if (method === 'module' && object?.type === 'Identifier' && this.isAngularReference(object)) {
      const info = { chain: true, method: 'module', target: call.arguments.length >= 2 ? call.arguments[call.arguments.length - 1] : null };
      this.regularInfoCache.set(call, info);
      return info;
    }

    let isModule = false;
    if (object?.type === 'CallExpression') {
      isModule = Boolean(this.regularInfo(object, stack)?.chain) || this.matchesModuleExpression(object);
    }
    else if (object && this.matchesModuleExpression(object)) isModule = true;
    if (!isModule || (!REGISTRATION_METHODS.has(method) && !CHAIN_ONLY_METHODS.has(method))) {
      this.regularInfoCache.set(call, null);
      return null;
    }

    if (method === 'decorator' && object?.type === 'Identifier' && object.name === '$stateProvider') {
      this.regularInfoCache.set(call, null);
      return null;
    }
    if (method === 'invoke' && object?.type === 'Identifier' && object.name === '$injector') {
      this.regularInfoCache.set(call, null);
      return null;
    }
    if (['decorator', 'factory', 'provider', 'service'].includes(method) && object?.type === 'Identifier' && object.name === '$provide') {
      this.regularInfoCache.set(call, null);
      return null;
    }

    let target = null;
    if (REGISTRATION_METHODS.has(method)) {
      if ((method === 'config' || method === 'run') && call.arguments.length === 1) target = call.arguments[0];
      else if (method !== 'config' && method !== 'run' && call.arguments.length === 2 && isStringLiteral(call.arguments[0])) target = call.arguments[1];
    }
    const info = { chain: true, method, target };
    this.regularInfoCache.set(call, info);
    return info;
  }

  matchesModuleExpression(node) {
    if (node.type === 'Identifier' && node.name === 'angular' && !this.isAngularReference(node)) return false;
    const source = this.code.slice(node.start, node.end);
    return this.moduleRegexp.test(source);
  }

  isAngularReference(identifier, trail = new Set()) {
    const binding = this.bindingFor(identifier);
    if (!binding) return identifier.name === 'angular';
    const baseBinding = binding.baseBinding || binding;
    if (trail.has(baseBinding)) return false;
    trail.add(baseBinding);
    if (binding.kind === 'import') {
      const declaration = this.parents.get(binding.declaration);
      if (declaration?.type !== 'ImportDeclaration' || declaration.source?.value !== 'angular') return false;
      if (binding.declaration.type === 'ImportDefaultSpecifier' || binding.declaration.type === 'ImportNamespaceSpecifier') return true;
      const imported = binding.declaration.imported;
      return binding.declaration.type === 'ImportSpecifier' && (imported?.name === 'default' || imported?.value === 'default');
    }
    const declaration = this.parents.get(binding.declaration);
    if (identifier.name === 'angular' && declaration?.type === 'VariableDeclaration' && declaration.declare) return true;
    if (this.isDestructuredAngularBinding(binding)) return true;
    if (this.isAmdAngularParameter(binding)) return true;
    if (this.isIifeAngularParameter(binding, trail)) return true;
    const effective = this.effectiveBinding(binding, identifier);
    return this.isAngularValue(effective?.value, trail);
  }

  isAngularValue(input, trail) {
    const value = unwrap(input);
    if (!value) return false;
    if (this.isDirectAngularRequire(value)) return true;
    if (value.type === 'MemberExpression') {
      const object = unwrap(value.object);
      const property = staticPropertyName(value);
      if (property === 'default' && (this.isDirectAngularRequire(object) ||
          (object?.type === 'Identifier' && this.isAngularReference(object, trail)))) return true;
      if (property === 'angular' && object?.type === 'Identifier' &&
          ['window', 'globalThis'].includes(object.name) && !this.bindingFor(object)) return true;
    }
    if (value.type === 'Identifier') return this.isAngularReference(value, trail);
    return false;
  }

  isDirectAngularRequire(value) {
    value = unwrap(value);
    return value?.type === 'CallExpression' && value.callee?.type === 'Identifier' &&
      value.callee.name === 'require' && !this.bindingFor(value.callee) &&
      value.arguments.length === 1 && isStringLiteral(value.arguments[0]) && value.arguments[0].value === 'angular';
  }

  isDestructuredAngularBinding(binding) {
    const declaration = binding.declaration;
    if (declaration?.type !== 'VariableDeclarator') return false;
    const pattern = unwrap(declaration.id);
    if (pattern?.type !== 'ObjectPattern') return false;
    const source = unwrap(declaration.init);
    const propertyName = this.isDirectAngularRequire(source) ? 'default' :
      (source?.type === 'Identifier' && ['window', 'globalThis'].includes(source.name) && !this.bindingFor(source) ? 'angular' : null);
    if (!propertyName) return false;
    return pattern.properties.some(property => property.type === 'Property' && staticPropertyName(property) === propertyName &&
      parameterName(property.value) === binding.name);
  }

  isIifeAngularParameter(binding, trail) {
    if (binding.kind !== 'param') return false;
    const callback = binding.scope?.node;
    if (!isFunction(callback)) return false;
    const runtimeIndex = runtimeParameterIndex(callback.params, binding.name);
    if (runtimeIndex < 0) return false;
    let parent = this.parents.get(callback);
    let child = callback;
    while (parent && WRAPPER_TYPES.has(parent.type) && parent.expression === child) {
      child = parent;
      parent = this.parents.get(parent);
    }
    if (parent?.type !== 'CallExpression' || unwrap(parent.callee) !== callback) return false;
    return this.isAngularValue(parent.arguments[runtimeIndex], trail);
  }

  isAmdAngularParameter(binding) {
    if (binding.kind !== 'param') return false;
    const callback = binding.scope?.node;
    if (!isFunction(callback)) return false;
    const runtimeIndex = runtimeParameterIndex(callback.params, binding.name);
    if (runtimeIndex < 0) return false;

    let parent = this.parents.get(callback);
    let child = callback;
    while (parent && WRAPPER_TYPES.has(parent.type) && parent.expression === child) {
      child = parent;
      parent = this.parents.get(parent);
    }
    if (parent?.type === 'CallExpression') {
      const callbackIndex = parent.arguments.findIndex(argument => unwrap(argument) === callback || argument === child);
      if (this.isAmdAngularArgument(parent, callbackIndex, runtimeIndex)) return true;
    }

    for (const call of this.calls) {
      const callee = unwrap(call.callee);
      if (callee?.type !== 'Identifier' || !AMD_LOADER_NAMES.has(callee.name) || this.bindingFor(callee)) continue;
      const callbackIndex = call.arguments.findIndex(argument => {
        const reference = unwrap(argument);
        if (reference?.type !== 'Identifier') return false;
        const effective = this.effectiveBinding(this.bindingFor(reference), reference);
        return unwrap(effective?.value) === callback;
      });
      if (this.isAmdAngularArgument(call, callbackIndex, runtimeIndex)) return true;
    }
    return false;
  }

  isAmdAngularArgument(call, callbackIndex, parameterIndex) {
    if (callbackIndex < 0) return false;
    const callee = unwrap(call.callee);
    if (callee?.type !== 'Identifier' || !AMD_LOADER_NAMES.has(callee.name) || this.bindingFor(callee)) return false;
    for (let index = callbackIndex - 1; index >= 0; index--) {
      const dependencies = this.resolveValue(call.arguments[index], new WeakSet());
      if (dependencies?.type === 'ArrayExpression') {
        return dependencies.elements[parameterIndex]?.value === 'angular';
      }
    }
    return false;
  }

  collectContextualTargets() {
    for (const call of this.calls) {
      if (this.processedContextCalls.has(call) || !this.isInContext(call)) continue;
      this.processedContextCalls.add(call);
      this.matchContextualCall(call);
    }
  }

  matchContextualCall(call) {
    const callee = unwrap(call.callee);
    if (callee?.type !== 'MemberExpression' || callee.computed) return false;
    const object = unwrap(callee.object);
    const method = staticPropertyName(callee);

    if (object?.type === 'Identifier' && object.name === '$injector' && method === 'invoke' && call.arguments.length >= 1) {
      for (const argument of call.arguments) this.enqueue(argument, { method: 'invoke' });
      return true;
    }
    if (object?.type === 'MemberExpression' && !object.computed && method === 'push' &&
        object.object?.type === 'Identifier' && object.object.name === '$httpProvider' &&
        ['interceptors', 'responseInterceptors'].includes(staticPropertyName(object)) && call.arguments.length >= 1) {
      for (const argument of call.arguments) this.enqueue(argument, { method: 'push' });
      return true;
    }
    if (object?.type === 'Identifier' && object.name === '$controllerProvider' && method === 'register' && call.arguments.length === 2) {
      this.enqueue(call.arguments[1], { method: 'register' });
      return true;
    }
    if (object?.type === 'Identifier' && object.name === '$provide' &&
        ['decorator', 'factory', 'provider', 'service'].includes(method) && call.arguments.length === 2) {
      this.enqueue(call.arguments[1], { method });
      return true;
    }
    if (method === 'when' && this.chainStartsWith(object, '$routeProvider') && call.arguments.length === 2) {
      this.processConfig(call.arguments[1], 'route');
      return true;
    }
    if (method === 'when' && this.chainStartsWith(object, '$urlRouterProvider') && call.arguments.length >= 1) {
      this.enqueue(call.arguments[call.arguments.length - 1], { method: 'when' });
      return true;
    }
    if (method === 'state' && this.chainStartsWith(object, '$stateProvider') && call.arguments.length >= 1 && call.arguments.length <= 2) {
      this.processConfig(call.arguments[call.arguments.length - 1], 'state');
      return true;
    }
    if (method === 'setNestedState' && this.chainStartsWith(object, 'stateHelperProvider') && call.arguments.length >= 1 && call.arguments.length <= 2) {
      this.processConfig(call.arguments[0], 'state');
      return true;
    }
    if (object?.type === 'Identifier' && call.arguments.length === 1 &&
        ((['$modal', '$uibModal'].includes(object.name) && method === 'open') ||
         (['$mdBottomSheet', '$mdDialog', '$mdToast'].includes(object.name) && method === 'show'))) {
      this.processConfig(call.arguments[0], 'modal');
      return true;
    }
    return false;
  }

  chainStartsWith(node, name) {
    node = unwrap(node);
    if (node?.type === 'Identifier') return node.name === name;
    if (node?.type !== 'CallExpression') return false;
    const callee = unwrap(node.callee);
    return callee?.type === 'MemberExpression' && !callee.computed && this.chainStartsWith(callee.object, name);
  }

  enqueue(node, info = {}) {
    if (isNode(node)) this.queue.push({ node, info });
  }

  drainQueue() {
    for (let index = 0; index < this.queue.length; index++) {
      const { node, info } = this.queue[index];
      this.processTarget(node, info, new WeakSet());
    }
    this.queue.length = 0;
  }

  processTarget(input, info, trail, bindingHint = null) {
    let node = unwrap(input);
    if (!isNode(node) || trail.has(node)) return;
    trail.add(node);
    this.markContext(node);

    if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') {
      this.processTarget(node.declaration, info, trail, bindingHint);
      return;
    }
    if (node.type === 'Property') {
      if (node.kind === 'get' || node.kind === 'set') return;
      this.processTarget(node.value, info, trail, bindingHint);
      return;
    }
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) this.processTarget(declaration, info, trail, bindingHint);
      return;
    }
    if (node.type === 'VariableDeclarator') {
      const binding = this.bindingForDeclaration(node) || bindingHint;
      this.processTarget(node.init, info, trail, binding);
      return;
    }
    if (node.type === 'Identifier') {
      const binding = this.effectiveBinding(this.bindingFor(node), node);
      if (!binding || !binding.value) return;
      if (this.blockedBindings.has(binding.baseBinding || binding)) {
        this.processBlockedMethodContext(binding.value, info.method);
        return;
      }
      this.markContext(binding.value);
      this.processTarget(binding.value, info, trail, binding);
      return;
    }
    const branches = branchExpressions(node);
    if (branches) {
      if (bindingHint && unwrap(bindingHint.value) === node) {
        this.processBlockedMethodContext(node, info.method);
        return;
      }
      for (const branch of branches) this.processTarget(branch, info, trail, bindingHint);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      const assignment = this.code.slice(node.left.start, node.left.end);
      this.processTarget(node.right, { ...info, assignment }, trail, null);
      return;
    }
    if (node.type === 'CallExpression') {
      const wrapper = annotationWrapperName(node);
      if (wrapper) {
        if (wrapper === 'ngNoInject') {
          this.processBlockedMethodContext(node.arguments[0], info.method);
          return;
        }
        this.processTarget(node.arguments[0], { ...info, explicit: true }, trail, bindingHint);
        return;
      }
      const returned = this.iifeReturn(node);
      if (returned && bindingHint && (isFunction(unwrap(returned)) || isClass(unwrap(returned)))) {
        const target = unwrap(returned);
        const dependencies = isClass(target) ? classDependencies(target) : functionDependencies(target);
        if (!this.isBlocked(target, bindingHint) && dependencies?.length && !this.plannedNodes.has(target)) {
          this.plannedNodes.add(target);
          this.planBindingInjection(bindingHint, dependencies);
        }
        this.markContext(target);
        this.processMethodContext(target, info.method);
      } else if (returned?.type === 'Identifier') {
        this.processTarget(returned, info, trail, null);
      } else if (returned) {
        if (bindingHint) this.processBlockedMethodContext(returned, info.method);
        else this.processTarget(returned, info, trail, null);
      }
      return;
    }
    if (node.type === 'ArrayExpression') {
      this.validateAnnotatedArray(node, info);
      this.processBlockedMethodContext(node.elements[node.elements.length - 1], info.method);
      return;
    }
    if (node.type === 'ObjectExpression') {
      if (info.explicit) {
        const childInfo = { ...info };
        delete childInfo.assignment;
        this.walkAnnotatedObject(node, value => this.enqueue(value, childInfo));
      }
      this.processMethodContext(node, info.method);
      return;
    }
    if (!isFunction(node) && !isClass(node)) return;

    const binding = bindingHint || this.bindingForValue(node) || null;
    const annotatedParent = this.annotatedArrayParent(node);
    if (annotatedParent && info.explicit) this.validateAnnotatedArray(annotatedParent, info);
    if (this.isBlocked(node, binding)) {
      this.processBlockedMethodContext(node, info.method);
      return;
    }
    this.markContext(node);
    this.planAnnotation(node, binding, info);
    this.processMethodContext(node, info.method);
  }

  processBlockedMethodContext(input, method, trail = new WeakSet()) {
    let node = unwrap(input);
    if (!method || !isNode(node) || trail.has(node)) return;
    trail.add(node);

    if (node.type === 'Identifier') {
      const binding = this.effectiveBinding(this.bindingFor(node), node);
      if (binding?.value) this.processBlockedMethodContext(binding.value, method, trail);
      return;
    }
    if (node.type === 'ArrayExpression') {
      this.processBlockedMethodContext(node.elements[node.elements.length - 1], method, trail);
      return;
    }
    const branches = branchExpressions(node);
    if (branches) {
      for (const branch of branches) this.processBlockedMethodContext(branch, method, trail);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      this.processBlockedMethodContext(node.right, method, trail);
      return;
    }
    if (node.type === 'SequenceExpression') {
      this.processBlockedMethodContext(node.expressions[node.expressions.length - 1], method, trail);
      return;
    }
    if (node.type === 'CallExpression') {
      if (annotationWrapperName(node)) {
        this.processBlockedMethodContext(node.arguments[0], method, trail);
        return;
      }
      const returned = this.iifeReturn(node);
      if (returned) this.processBlockedMethodContext(returned, method, trail);
      return;
    }
    if (!isFunction(node) && !isClass(node) && node.type !== 'ObjectExpression') return;
    this.markContext(node);
    this.processMethodContext(node, method);
  }

  processMethodContext(node, method) {
    if (!method) return;
    let methods = this.processedMethods.get(node);
    if (!methods) this.processedMethods.set(node, methods = new Set());
    if (methods.has(method)) return;
    methods.add(method);
    if (method === 'provider') this.scanProvider(node);
    if (method === 'directive') this.scanDirective(node);
  }

  scanProvider(root) {
    walk(root, node => {
      if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression' &&
          staticPropertyName(node.left) === '$get') {
        const owner = unwrap(node.left.object);
        if (owner?.type === 'ThisExpression' || (owner?.type === 'Identifier' && ['self', 'that'].includes(owner.name))) {
          this.enqueue(node.right, { method: 'provider' });
        }
      }
      if (node.type === 'ObjectExpression') {
        for (const property of node.properties || []) {
          if (property.type === 'Property' && staticPropertyName(property) === '$get' && property.kind !== 'get' && property.kind !== 'set') {
            this.enqueue(property.value, { method: 'provider' });
          }
        }
      }
    });
  }

  scanDirective(root) {
    this.scanDirectiveFunction(root, new WeakSet());
  }

  scanDirectiveFunction(root, trail) {
    root = unwrap(root);
    if (!isFunction(root) || trail.has(root)) return;
    trail.add(root);
    if (root.type === 'ArrowFunctionExpression' && root.body?.type !== 'BlockStatement') {
      this.processDirectiveReturn(root.body, trail);
      return;
    }
    const visit = node => {
      if (!isNode(node)) return;
      if (node !== root && (isFunction(node) || isClass(node))) return;
      if (node.type === 'ReturnStatement' && node.argument) this.processDirectiveReturn(node.argument, trail);
      forEachChild(node, visit);
    };
    visit(root);
  }

  processDirectiveReturn(input, trail) {
    const node = unwrap(input);
    if (!isNode(node)) return;
    const branches = branchExpressions(node);
    if (branches) {
      for (const branch of branches) this.processDirectiveReturn(branch, trail);
      return;
    }
    if (node.type === 'CallExpression') {
      const returned = this.iifeReturn(node);
      if (returned) {
        this.processDirectiveReturn(returned, trail);
        return;
      }
      const callee = lastSequenceExpression(node.callee);
      if (callee?.type === 'Identifier') {
        const binding = this.effectiveBinding(this.bindingFor(callee), callee);
        const helper = this.resolveValue(binding?.value, new WeakSet());
        if (isFunction(helper)) this.scanDirectiveFunction(helper, trail);
      }
      return;
    }
    this.processDirectiveObject(node);
  }

  processDirectiveObject(input) {
    const node = this.resolveValue(input, new WeakSet());
    if (node?.type !== 'ObjectExpression') return;
    const controller = findProperty(node, 'controller');
    if (controller && controller.kind !== 'get' && controller.kind !== 'set') this.enqueue(controller.value, { method: 'controller' });
  }

  processConfig(input, kind) {
    let seen = this.configSeen.get(kind);
    if (!seen) this.configSeen.set(kind, seen = new WeakSet());
    const node = unwrap(input);
    if (!isNode(node) || seen.has(node)) return;
    seen.add(node);

    if (node.type === 'ConditionalExpression') {
      this.processConfig(node.consequent, kind);
      this.processConfig(node.alternate, kind);
      return;
    }
    if (isObjectAssign(node)) {
      for (const argument of node.arguments) this.processConfig(argument, kind);
      return;
    }
    const resolved = this.resolveValue(node, new WeakSet());
    if (resolved !== node) {
      this.processConfig(resolved, kind);
      return;
    }
    if (node.type !== 'ObjectExpression') return;

    for (const property of node.properties || []) {
      if (property.type === 'SpreadElement') {
        this.processConfig(property.argument, kind);
        continue;
      }
      if (property.type !== 'Property' || property.kind === 'get' || property.kind === 'set') continue;
      const name = staticPropertyName(property);
      if (kind === 'component' && COMPONENT_PROPERTIES.has(name)) {
        this.enqueue(property.value, { method: name });
      } else if ((kind === 'route' || kind === 'modal') && name === 'controller') {
        this.enqueue(property.value, { method: 'controller' });
      } else if (kind === 'state' && STATE_PROPERTIES.has(name)) {
        this.enqueue(property.value, { method: name });
      } else if ((kind === 'route' || kind === 'modal' || kind === 'state') && name === 'resolve') {
        this.processValues(property.value, value => this.enqueue(value, { method: 'resolve' }));
      } else if (kind === 'state' && name === 'params') {
        this.processParams(property.value);
      } else if (kind === 'state' && name === 'views') {
        this.processViews(property.value);
      } else if (kind === 'state' && name === 'children') {
        const children = this.resolveValue(property.value, new WeakSet());
        if (children?.type === 'ArrayExpression') {
          for (const child of children.elements || []) this.processConfig(child, 'state');
        }
      }
    }
  }

  processValues(input, callback) {
    const node = this.resolveValue(input, new WeakSet());
    if (node?.type !== 'ObjectExpression') return;
    for (const property of node.properties || []) {
      if (property.type === 'SpreadElement') this.processValues(property.argument, callback);
      else if (property.type === 'Property' && property.kind !== 'get' && property.kind !== 'set') callback(property.value);
    }
  }

  processParams(input) {
    this.processValues(input, value => {
      const resolved = this.resolveValue(value, new WeakSet());
      if (resolved?.type === 'ObjectExpression') {
        const property = findProperty(resolved, 'value');
        if (property && property.kind !== 'get' && property.kind !== 'set') this.enqueue(property.value, { method: 'params' });
      } else {
        this.enqueue(value, { method: 'params' });
      }
    });
  }

  processViews(input) {
    this.processValues(input, value => {
      const view = this.resolveValue(value, new WeakSet());
      if (view?.type !== 'ObjectExpression') return;
      for (const property of view.properties || []) {
        if (property.type !== 'Property' || property.kind === 'get' || property.kind === 'set') continue;
        const name = staticPropertyName(property);
        if (VIEW_PROPERTIES.has(name)) this.enqueue(property.value, { method: name });
        else if (name === 'resolve') this.processValues(property.value, item => this.enqueue(item, { method: 'resolve' }));
      }
    });
  }

  resolveValue(input, trail) {
    let node = unwrap(input);
    if (!isNode(node) || trail.has(node)) return node;
    trail.add(node);
    if (node.type === 'Identifier') {
      const binding = this.effectiveBinding(this.bindingFor(node), node);
      if (binding?.value && !this.blockedBindings.has(binding.baseBinding || binding)) return this.resolveValue(binding.value, trail);
    }
    if (node.type === 'CallExpression') {
      const returned = this.iifeReturn(node);
      if (returned) return this.resolveValue(returned, trail);
    }
    return node;
  }

  iifeReturn(node) {
    node = unwrap(node);
    if (node?.type !== 'CallExpression') return null;
    const callee = unwrap(node.callee);
    if (!isFunction(callee)) return null;
    if (callee.body?.type !== 'BlockStatement') return callee.body || null;
    const statement = callee.body.body.find(item => item.type === 'ReturnStatement');
    return statement?.argument || null;
  }

  walkAnnotatedObject(object, callback) {
    for (const property of object.properties || []) {
      if (property.type !== 'Property' || property.kind === 'get' || property.kind === 'set') continue;
      const value = unwrap(property.value);
      if (isFunction(value) || isClass(value)) callback(value);
      else if (value?.type === 'ObjectExpression') this.walkAnnotatedObject(value, callback);
      else if (value?.type === 'ArrayExpression') this.validateAnnotatedArray(value, { explicit: true });
    }
  }

  validateAnnotatedArray(node, info) {
    if (!info.explicit || node.elements.length === 0) return;
    const target = unwrap(node.elements[node.elements.length - 1]);
    if (!isFunction(target) && !isClass(target)) return;
    const annotations = node.elements.slice(0, -1);
    if (!annotations.every(isStringLiteral)) return;
    const dependencies = isClass(target) ? classDependencies(target) : functionDependencies(target);
    if (!dependencies) return;
    if (annotations.length < dependencies.length) {
      const error = new Error('[angularjs-annotate] Function parameters do not match existing annotations.');
      error.code = 'ANNOTATION_MISMATCH';
      error.start = node.start;
      error.end = node.end;
      throw error;
    }
    const mismatch = dependencies.findIndex((dependency, index) => annotations[index]?.value !== dependency);
    if (mismatch >= 0 && typeof this.options.onWarn === 'function') {
      const location = annotations[mismatch] || node;
      this.options.onWarn('[angularjs-annotate] Function parameters do not match existing annotations.', {
        code: 'ANNOTATION_MISMATCH',
        start: location.start,
        end: location.end,
      });
    }
  }

  annotatedArrayParent(node) {
    let current = node;
    let parent = this.parents.get(current);
    while (parent && WRAPPER_TYPES.has(parent.type) && parent.expression === current) {
      current = parent;
      parent = this.parents.get(current);
    }
    if (parent?.type !== 'ArrayExpression' || unwrap(parent.elements[parent.elements.length - 1]) !== node) return null;
    return isAnnotatedArray(parent) ? parent : null;
  }

  isBlocked(node, binding) {
    const baseBinding = binding?.baseBinding || binding;
    if (this.blockedNodes.has(node) || (baseBinding && this.blockedBindings.has(baseBinding))) return true;
    if (binding?.write && this.blockedWrites.has(binding.write)) return true;
    if (this.annotatedArrayParent(node)) return true;
    return false;
  }

  markContext(node) {
    if (!isNode(node) || this.contextRoots.has(node)) return;
    this.contextRoots.add(node);
    this.contextRootCount++;
  }

  isInContext(node) {
    let current = node;
    while (current) {
      if (this.contextRoots.has(current)) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  planAnnotation(node, binding, info) {
    if (this.plannedNodes.has(node)) return;
    const dependencies = isClass(node) ? classDependencies(node) : functionDependencies(node);
    if (!dependencies || dependencies.length === 0) return;
    if (binding?.write?.kind === 'hoisted') {
      const writes = (binding.baseBinding || binding).writes.filter(write => write.kind === 'hoisted');
      if (writes[writes.length - 1] !== binding.write) return;
    }

    if (isClass(node) && !node.id && this.isAnonymousDefaultExport(node)) {
      const name = this.generateName('_ngInjectAnonymousClass');
      if (!this.nameAnonymousDeclaration(node, name, 'class')) return;
      this.plannedNodes.add(node);
      this.planAfter(this.statementFor(node)?.end || node.end, `${name}.$inject = ${dependencyArray(dependencies)};`);
      return;
    }
    if (node.type === 'FunctionDeclaration' && !node.id && this.isAnonymousDefaultExport(node)) {
      const name = this.generateName('_ngInjectExport');
      if (!this.nameAnonymousDeclaration(node, name, 'function')) return;
      this.plannedNodes.add(node);
      const statement = this.statementFor(node);
      this.planBefore(statement?.start ?? node.start, `${name}.$inject = ${dependencyArray(dependencies)};`);
      return;
    }

    if (info.assignment) {
      const statement = this.statementFor(node);
      if (statement) {
        this.plannedNodes.add(node);
        this.planAfter(statement.end, `${info.assignment}.$inject = ${dependencyArray(dependencies)};`);
      }
      return;
    }

    if (binding && unwrap(binding.value) === node) {
      if (binding.statement) {
        this.plannedNodes.add(node);
        this.planBindingInjection(binding, dependencies);
      }
      return;
    }
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
      const declarationBinding = this.bindingForValue(node) || binding;
      if (declarationBinding?.statement) {
        this.plannedNodes.add(node);
        this.planBindingInjection(declarationBinding, dependencies);
      }
      return;
    }

    const property = this.methodProperties.get(node);
    if (property) {
      if (property.kind === 'get' || property.kind === 'set') return;
      if (containsSuper(node)) return;
      const key = this.code.slice(property.key.start, property.key.end);
      const prefix = `${property.computed ? `[${key}]` : key}: ${dependencyPrefix(dependencies)}, ${node.async ? 'async ' : ''}function${node.generator ? '*' : ''}`;
      this.magicString.overwrite(property.start, node.start, prefix);
      this.magicString.appendRight(node.end, ']');
      this.plannedNodes.add(node);
      return;
    }

    if (isFunction(node) || isClass(node)) {
      if (this.isInvocationTarget(node)) return;
      this.magicString.appendLeft(node.start, `${dependencyPrefix(dependencies)}, `);
      this.magicString.appendRight(node.end, ']');
      this.plannedNodes.add(node);
    }
  }

  planBindingInjection(binding, dependencies) {
    const text = `${binding.name}.$inject = ${dependencyArray(dependencies)};`;
    if (binding.value?.type === 'FunctionDeclaration') {
      let position = scopeInsertionPosition(binding.scope);
      const statements = binding.scope?.body?.body || [];
      if (statements.length === 0 || directiveValue(statements[0]) == null) {
        const marker = this.comments.find(comment => comment.end <= position &&
          commentAnnotation(comment.value) != null && this.isTrivia(comment.end, position));
        if (marker) {
          const leadingComment = this.comments.find(comment => comment.end <= position && this.isTrivia(comment.end, position));
          position = leadingComment?.start ?? marker.start;
        }
      }
      if (position != null) this.planBefore(position, text);
      else if (binding.statement) this.planAfter(binding.statement.end, text);
      return;
    }
    if (binding.statement) this.planAfter(binding.statement.end, text);
  }

  planBefore(position, text) {
    let entries = this.before.get(position);
    if (!entries) this.before.set(position, entries = []);
    entries.unshift(text);
  }

  planAfter(position, text) {
    let entries = this.after.get(position);
    if (!entries) this.after.set(position, entries = []);
    entries.unshift(text);
  }

  applyInsertions() {
    for (const [position, entries] of this.before) {
      this.magicString.appendLeft(position, `${entries.join('\n')}\n`);
    }
    for (const [position, entries] of this.after) {
      this.magicString.appendRight(position, `\n${entries.join('\n')}`);
    }
  }

  isAnonymousDefaultExport(node) {
    return this.parents.get(node)?.type === 'ExportDefaultDeclaration';
  }

  isInvocationTarget(node) {
    let current = node;
    let parent = this.parents.get(current);
    while (parent && WRAPPER_TYPES.has(parent.type) && parent.expression === current) {
      current = parent;
      parent = this.parents.get(current);
    }
    return (parent?.type === 'CallExpression' && parent.callee === current) ||
      (parent?.type === 'NewExpression' && parent.callee === current) ||
      (parent?.type === 'TaggedTemplateExpression' && parent.tag === current);
  }

  nameAnonymousDeclaration(node, name, kind) {
    let start = node.start;
    if (kind === 'class' && node.decorators?.length) {
      start = Math.max(start, ...node.decorators.map(decorator => decorator.end));
    }
    const source = this.code.slice(start, node.end);
    const match = kind === 'class' ? /\bclass\b/ : /^(?:async\s+)?function\*?/;
    const found = match.exec(source);
    if (!found) return false;
    this.magicString.appendLeft(start + found.index + found[0].length, ` ${name}`);
    return true;
  }

  generateName(base) {
    let name = base;
    let suffix = 2;
    while (this.generatedNames.has(name) || this.rootScope.bindings.has(name)) name = `${base}${suffix++}`;
    this.generatedNames.add(name);
    return name;
  }

  findAncestor(node, predicate) {
    let current = this.parents.get(node);
    while (current) {
      if (predicate(current)) return current;
      current = this.parents.get(current);
    }
    return null;
  }
}

class Scope {
  constructor(type, parent, node, body) {
    this.type = type;
    this.parent = parent;
    this.node = node;
    this.body = body;
    this.bindings = new Map();
  }
}

function normalizeModuleRegexp(value) {
  if (!value) return new RegExp(DEFAULT_MODULE_REGEXP.source);
  if (value instanceof RegExp) return new RegExp(value.source, value.flags.replace(/[gy]/g, ''));
  return new RegExp(value);
}

function nearestFunctionScope(scope) {
  while (scope.parent && scope.type !== 'function' && scope.type !== 'program' && scope.type !== 'static-block') {
    scope = scope.parent;
  }
  return scope;
}

function branchExpressions(node) {
  if (node?.type === 'ConditionalExpression') return [node.consequent, node.alternate];
  if (node?.type === 'LogicalExpression') return [node.left, node.right];
  return null;
}

function annotationWrapperName(node) {
  if (node?.type !== 'CallExpression' || node.arguments.length !== 1) return null;
  const callee = unwrap(node.callee);
  return callee?.type === 'Identifier' && ANNOTATION_WRAPPER_NAMES.has(callee.name) ? callee.name : null;
}

function isImplicitAnnotationCandidate(node) {
  const callee = unwrap(node.callee);
  if (callee?.type !== 'MemberExpression' || callee.computed) return false;
  const method = staticPropertyName(callee);
  return method === 'module' || REGISTRATION_METHODS.has(method);
}

function lastSequenceExpression(input) {
  let node = unwrap(input);
  while (node?.type === 'SequenceExpression') node = unwrap(node.expressions[node.expressions.length - 1]);
  return node;
}

function scopeInsertionPosition(scope) {
  const body = scope?.body;
  if (!body || (body.type !== 'Program' && body.type !== 'BlockStatement' && body.type !== 'StaticBlock')) return null;
  const statements = body.body || [];
  let index = 0;
  while (index < statements.length && directiveValue(statements[index]) != null) index++;
  if (index < statements.length) return statements[index].start;
  return body.type === 'BlockStatement' || body.type === 'StaticBlock' ? body.end - 1 : body.end;
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) return null;
  return comments.map(comment => ({
    value: comment.value || '',
    start: comment.start,
    end: comment.end,
  })).sort((left, right) => left.start - right.start);
}

function scanComments(code, protectedNodes) {
  const regexp = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
  const firstMatch = regexp.exec(code);
  if (!firstMatch) return [];

  const protectedRanges = protectedNodes
    .map(node => [node.start, node.end])
    .sort((left, right) => left[0] - right[0]);
  const comments = [];
  let rangeIndex = 0;
  for (let match = firstMatch; match; match = regexp.exec(code)) {
    const start = match.index;
    while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex][1] <= start) rangeIndex++;
    const range = protectedRanges[rangeIndex];
    if (range && start >= range[0] && start < range[1]) continue;
    const block = match[0].startsWith('/*');
    comments.push({
      value: block ? match[0].slice(2, -2) : match[0].slice(2),
      start,
      end: start + match[0].length,
    });
  }
  return comments;
}

function commentAnnotation(value) {
  for (const line of String(value).split(/\r?\n/)) {
    const normalized = line.replace(/^[\s*]*/, '').replace(/[\s*]*$/, '').trim();
    if (normalized === '@ngInject') return true;
    if (normalized === '@ngNoInject') return false;
  }
  return null;
}

function explicitPriority(node) {
  if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') return 0;
  if (node.type === 'VariableDeclaration' || node.type === 'ExpressionStatement') return 1;
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return 2;
  if (node.type === 'MethodDefinition' || node.type === 'Property') return 3;
  if (node.type === 'ObjectExpression') return 4;
  if (WRAPPER_TYPES.has(node.type)) return 5;
  if (node.type === 'CallExpression') return 5;
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'ClassExpression') return 6;
  if (node.type === 'Identifier') return 7;
  return 100;
}

function explicitStart(node) {
  const target = node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration' ?
    node.declaration : node;
  if (!target?.decorators?.length) return node.start;
  return Math.min(node.start, ...target.decorators.map(decorator => decorator.start));
}

function functionDirective(node) {
  if (node.body?.type !== 'BlockStatement') return null;
  for (const statement of node.body.body) {
    const value = directiveValue(statement);
    if (value == null) break;
    if (value === 'ngInject') return true;
    if (value === 'ngNoInject') return false;
  }
  return null;
}

function directiveValue(statement) {
  if (statement?.type !== 'ExpressionStatement') return null;
  const expression = statement.expression;
  return expression?.type === 'Literal' && typeof expression.value === 'string' ? expression.value : null;
}

function functionDependencies(node) {
  if (!isFunction(node)) return null;
  const result = [];
  for (const [index, parameter] of (node.params || []).entries()) {
    if (index === 0 && isTypeScriptThisParameter(parameter)) continue;
    const name = parameterName(parameter);
    if (!name) return null;
    result.push(name);
  }
  return result;
}

function classDependencies(node) {
  if (!isClass(node)) return null;
  const constructor = node.body?.body?.find(item => item.type === 'MethodDefinition' &&
    item.kind === 'constructor' && isFunction(item.value) && item.value.body?.type === 'BlockStatement');
  return constructor ? functionDependencies(constructor.value) : [];
}

function unwrapParameter(parameter) {
  parameter = unwrap(parameter);
  while (parameter?.type === 'AssignmentPattern' || parameter?.type === 'RestElement' || parameter?.type === 'TSParameterProperty') {
    parameter = unwrap(parameter.left || parameter.argument || parameter.parameter);
  }
  return parameter;
}

function isTypeScriptThisParameter(parameter) {
  parameter = unwrapParameter(parameter);
  return parameter?.type === 'Identifier' && parameter.name === 'this' && Boolean(parameter.typeAnnotation);
}

function parameterName(parameter) {
  parameter = unwrapParameter(parameter);
  return parameter?.type === 'Identifier' ? parameter.name : null;
}

function runtimeParameterIndex(parameters, bindingName) {
  let runtimeIndex = 0;
  for (const parameter of parameters || []) {
    if (parameterName(parameter) === bindingName) return runtimeIndex;
    if (!isTypeScriptThisParameter(parameter)) runtimeIndex++;
  }
  return -1;
}

function dependencyArray(dependencies) {
  return `[${dependencies.map(JSON.stringify).join(', ')}]`;
}

function dependencyPrefix(dependencies) {
  return `[${dependencies.map(JSON.stringify).join(', ')}`;
}

function isAnnotatedArray(node) {
  if (node?.type !== 'ArrayExpression' || node.elements.length === 0) return false;
  const last = unwrap(node.elements[node.elements.length - 1]);
  return (isFunction(last) || isClass(last)) && node.elements.slice(0, -1).every(isStringLiteral);
}

function isInjectMember(node) {
  return node?.type === 'MemberExpression' && staticPropertyName(node) === '$inject';
}

function isStringLiteral(node) {
  node = unwrap(node);
  return node?.type === 'Literal' && typeof node.value === 'string';
}

function isObjectAssign(node) {
  node = unwrap(node);
  const callee = unwrap(node?.callee);
  return node?.type === 'CallExpression' && callee?.type === 'MemberExpression' && !callee.computed &&
    callee.object?.type === 'Identifier' && callee.object.name === 'Object' && staticPropertyName(callee) === 'assign';
}

function containsSuper(node) {
  let result = false;
  walk(node, candidate => {
    if (candidate.type === 'Super') result = true;
  });
  return result;
}

function assignedIdentifiers(pattern, result = []) {
  pattern = unwrap(pattern);
  if (!pattern) return result;
  if (pattern.type === 'Identifier') {
    result.push(pattern);
  } else if (pattern.type === 'AssignmentPattern') {
    assignedIdentifiers(pattern.left, result);
  } else if (pattern.type === 'RestElement' || pattern.type === 'TSParameterProperty') {
    assignedIdentifiers(pattern.argument || pattern.parameter, result);
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements || []) assignedIdentifiers(element, result);
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties || []) {
      assignedIdentifiers(property.type === 'RestElement' ? property.argument : property.value, result);
    }
  }
  return result;
}

function findProperty(object, name) {
  return object?.properties?.find(property => property.type === 'Property' && staticPropertyName(property) === name) || null;
}

function staticPropertyName(node) {
  const key = node?.property || node?.key;
  if (!key) return null;
  if (!node.computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

function unwrap(node) {
  while (WRAPPER_TYPES.has(node?.type)) node = node.expression;
  return node;
}

function isFunction(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionDeclaration' || node?.type === 'FunctionExpression';
}

function isClass(node) {
  return node?.type === 'ClassDeclaration' || node?.type === 'ClassExpression';
}

function isNode(value) {
  return value && typeof value === 'object' && typeof value.type === 'string';
}

function forEachChild(node, callback) {
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) callback(child, key);
    } else if (isNode(value)) {
      callback(value, key);
    }
  }
}

function walk(node, visitor, seen = new WeakSet(), parent = null, key = null) {
  if (!isNode(node) || seen.has(node)) return;
  seen.add(node);
  visitor(node, parent, key);
  forEachChild(node, (child, childKey) => walk(child, visitor, seen, node, childKey));
}
