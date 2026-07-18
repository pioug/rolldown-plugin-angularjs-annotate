import type MagicString from 'magic-string';
import type { Plugin, RolldownMagicString } from 'rolldown';
import type { ESTree } from 'rolldown/utils';

declare function angularjsAnnotate(
  options?: angularjsAnnotate.AngularjsAnnotateOptions,
): Plugin;

declare namespace angularjsAnnotate {
  type FilterPattern = string | RegExp | readonly (string | RegExp)[];

  interface AngularjsAnnotateOptions {
    /** Module IDs transformed by the plugin. */
    include?: FilterPattern;
    /** Module IDs omitted by the plugin. */
    exclude?: FilterPattern;
    /** Disable all implicit AngularJS pattern matching. */
    explicitOnly?: boolean;
    /** Restrict implicit short-form module receivers such as `app.controller(...)`. */
    regexp?: string | RegExp;
  }

  interface ParserComment {
    type: 'Block' | 'Line' | string;
    value: string;
    start: number;
    end: number;
  }

  interface AnnotateOptions {
    comments?: readonly ParserComment[] | null;
    explicitOnly?: boolean;
    regexp?: string | RegExp;
    onWarn?: (message: string) => void;
  }

  function annotate(
    program: ESTree.Program,
    code: string,
    magicString: MagicString | RolldownMagicString,
    options?: AnnotateOptions,
  ): void;

  const angularjsAnnotate: (
    options?: AngularjsAnnotateOptions,
  ) => Plugin;
}

export = angularjsAnnotate;
