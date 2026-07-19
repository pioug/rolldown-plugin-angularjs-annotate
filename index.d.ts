import type MagicString from 'magic-string';
import type { Plugin, RolldownMagicString } from 'rolldown';
import type { ESTree } from 'rolldown/utils';

declare function angularjsAnnotate(
  options?: angularjsAnnotate.AngularJSAnnotateOptions,
): Plugin;

declare namespace angularjsAnnotate {
  type FilterPattern = string | RegExp | readonly (string | RegExp)[];

  interface AngularJSAnnotateOptions {
    /** Module IDs transformed by the plugin. */
    include?: FilterPattern;
    /** Module IDs omitted by the plugin. */
    exclude?: FilterPattern;
    /** Disable all implicit AngularJS pattern matching. */
    explicitOnly?: boolean;
    /** Restrict source expressions accepted as implicit AngularJS module receivers. */
    regexp?: string | RegExp;
  }

  interface ParserComment {
    /** Accepted for compatibility with parser comment objects; annotation only uses the range and value. */
    type?: string;
    value: string;
    start: number;
    end: number;
  }

  interface AnnotateDiagnostic {
    /** Stable diagnostic identifier suitable for filtering build logs. */
    code?: string;
    /** Zero-based source offsets when the diagnostic is tied to syntax. */
    start?: number;
    end?: number;
  }

  interface AnnotateOptions {
    comments?: readonly ParserComment[] | null;
    explicitOnly?: boolean;
    regexp?: string | RegExp;
    /** Receives the message and, when available, its source span. */
    onWarn?: (message: string, diagnostic?: AnnotateDiagnostic) => void;
  }

  function annotate(
    program: ESTree.Program,
    code: string,
    magicString: MagicString | RolldownMagicString,
    options?: AnnotateOptions,
  ): void;

  const angularjsAnnotate: (
    options?: AngularJSAnnotateOptions,
  ) => Plugin;
}

export = angularjsAnnotate;
