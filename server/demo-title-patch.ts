import ts from 'typescript';
import {recordedInterfaceTitles, withoutInterfaceTitles} from '../shared/interface-title';
import type {DemoCodeProposal} from '../shared/generated-demo';
import type {Project} from '../shared/types';
import {demoInput, digest} from './demo-schema';

export function prototypeTitlePatch(project: Project, previous: Project, files: Record<string, string>, proposal: DemoCodeProposal): DemoCodeProposal | undefined {
  const currentInput = demoInput(project), previousInput = demoInput(previous);
  const withoutTitles = (input: typeof currentInput) => ({
    ...input,
    cards: input.cards.map(card => ({...card, fields: {...card.fields, flow: withoutInterfaceTitles(card.fields.flow)}})),
  });
  // A title-only edit may reuse the rest of the code. If any other effective
  // requirement changed, use normal generation so those changes are included.
  if (digest(withoutTitles(currentInput)) !== digest(withoutTitles(previousInput))) return;
  const titles = (input: typeof currentInput) => input.cards.flatMap(card =>
    recordedInterfaceTitles(card.fields.flow).map(title => ({...title, cardId: card.id})));
  const oldTitles = titles(previousInput), newTitles = titles(currentInput);
  const difference = (a: typeof oldTitles, b: typeof oldTitles) =>
    a.filter(title => !b.some(item => item.cardId === title.cardId && item.before === title.before && item.after === title.after));
  const added = difference(newTitles, oldTitles), removed = difference(oldTitles, newTitles);
  if (added.length !== 1 || removed.length > 1) return;
  const change = added[0], replaced = removed[0];
  if (replaced && (change.cardId !== replaced.cardId || change.before !== replaced.before && change.before !== replaced.after)) return;
  const previousLabel = replaced?.after ?? change.before;

  const matches: {path: string; start: number; end: number}[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith('.tsx')) continue;
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const inspect = (node: ts.Node) => {
      if (ts.isJsxText(node) && node.getFullText(source).trim() === previousLabel) {
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(source) === 'header') {
            matches.push({path, start: node.getFullStart(), end: node.end});
            break;
          }
        }
      }
      node.forEachChild(inspect);
    };
    inspect(source);
  }
  if (matches.length !== 1) return;
  const {path, start, end} = matches[0], source = files[path];
  const updated = source.slice(0, start) + source.slice(start, end).replace(previousLabel, () => change.after) + source.slice(end);
  return {...proposal, files: [{path, content: updated}], deletePaths: [], edits: [],
    summary: `页头标题更新为「${change.after}」。`};
}
