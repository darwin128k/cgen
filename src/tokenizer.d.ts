export interface Token {
  type: 'comment' | 'attr' | 'kw' | 'builtin' | 'bracket' | 'string' | 'plain';
  text: string;
}

export function tokenizeLine(line: string): Token[];
export function buildGrammar(): object;
export const DOC_ATTR_NAMES: string[];
export const TM_SCOPES: Record<string, string>;
